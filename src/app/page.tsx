'use client';

import React, { useState, useCallback, useRef, startTransition } from 'react';
import * as XLSX from 'xlsx';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine,
  BarChart, Bar, ScatterChart, Scatter, ZAxis, Cell,
  PieChart, Pie,
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
} from 'recharts';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { MultiAgentPanel } from '@/components/multi-agent-panel';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  ScrollArea,
} from '@/components/ui/scroll-area';
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from '@/components/ui/accordion';
import type { Paper, Signal1Result, Signal2Result, Signal3Result, Signal4Result, Metrics, SignalStatus } from '@/lib/types';
import { computeMetrics, minMaxNormalize, entropyWeights, criticWeights, pcaWeights, bootstrapWeightStability, computeAUC, trainLogisticRegression, predictLogisticRegression, ndcgAtK, enrichmentAtK, mannWhitneyUTest, computeCitationPercentile } from '@/lib/metrics';
import {
  computePapersHash, idbClearAll, idbClearSignal1, idbLoadMeta, idbLoadPapers,
  idbLoadSignal, idbLoadSignal1, idbSaveMeta, idbSavePapers, idbSaveSignal,
  idbSaveSignal1Batch, type SessionMeta,
} from '@/lib/idb-cache';

// ============ 颜色常量 ============
const H1_COLOR = '#ef4444';
const NON_H1_COLOR = '#3b82f6';
const TYPE_COLORS: Record<string, string> = {
  'High Impact': '#ef4444',
  'Medium Impact': '#f59e0b',
  'Low Impact': '#6b7280',
  'Error': '#94a3b8',
  // 兼容旧数据
  'New Finding': '#ef4444',
  'Technical Advance': '#3b82f6',
  'Interesting Hypothesis': '#f59e0b',
  'Novel Drug Target': '#10b981',
  'Confirmation': '#6b7280',
  'Controversial': '#8b5cf6',
};
// Signal3: knowledge network bridging (no strength colors needed)

// ============ 数据解析工具 ============
function parseExcelFile(file: File): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        const workbook = XLSX.read(data, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const jsonData = XLSX.utils.sheet_to_json(sheet);
        resolve(jsonData as Array<Record<string, unknown>>);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

function normalizeHeader(s: string): string {
  return s.toLowerCase().replace(/[\s_\-（）()]/g, '');
}

function extractValue(row: Record<string, unknown>, keys: string[]): string {
  const rowKeys = Object.keys(row);
  // 第一轮：归一化后精确匹配，避免子串误匹配
  // （例如查 "type" 时误命中 "publication type"，查 "rating" 时误命中 "evaluation rating" 的顺序问题）
  for (const key of keys) {
    const nk = normalizeHeader(key);
    for (const k of rowKeys) {
      if (normalizeHeader(k) === nk) {
        const val = row[k];
        return val != null ? String(val).trim() : '';
      }
    }
  }
  // 第二轮：子串包含匹配（兜底英文列名变体）
  for (const key of keys) {
    const nk = normalizeHeader(key);
    for (const k of rowKeys) {
      if (normalizeHeader(k).includes(nk)) {
        const val = row[k];
        return val != null ? String(val).trim() : '';
      }
    }
  }
  return '';
}

// MeSH 术语本身含逗号（如 "Receptors, G-Protein-Coupled"、"ATP Citrate (pro-S)-Lyase"），
// 因此优先以分号/竖线/换行分隔；仅当全文不含分号时，才退回逗号分隔。
function parseMeshTerms(raw: string): string[] {
  if (!raw) return [];
  const hasSemicolon = /[;|]|\n/.test(raw);
  const sep = hasSemicolon ? /[;|]|\n/ : /[,]/;
  return raw
    .split(sep)
    .map(t => t.trim())
    .filter(t => t.length > 0);
}

// 散点图降采样：均匀抽取最多 maxPoints 个点，避免 5000+ 点 SVG 渲染卡死
function downsample<T>(arr: T[], maxPoints: number): T[] {
  if (arr.length <= maxPoints) return arr;
  const step = arr.length / maxPoints;
  const out: T[] = [];
  for (let i = 0; i < maxPoints; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

// 年份解析：支持 "2021"、"2021-Apr"、"2021/04/15"、Excel 日期数字等
function parseYear(raw: string): string {
  if (!raw) return '';
  const str = String(raw).trim();
  // 纯四位数年份
  const yearMatch = str.match(/(19|20)\d{2}/);
  if (yearMatch) return yearMatch[0];
  // Excel 日期序列号
  const num = Number(str);
  if (!isNaN(num) && num > 20000 && num < 80000) {
    const date = new Date(Math.round((num - 25569) * 86400 * 1000));
    return String(date.getUTCFullYear());
  }
  return '';
}

// ============ 主组件 ============
export default function LitmusApp() {
  // 数据状态
  const [papers, setPapers] = useState<Paper[]>([]);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [dataSource, setDataSource] = useState<{ paperFile: string; h1File: string }>({ paperFile: '', h1File: '' });

  // 信号结果
  const [signal1Results, setSignal1Results] = useState<Signal1Result[]>([]);
  const [signal2Results, setSignal2Results] = useState<Signal2Result[]>([]);
  const [signal3Results, setSignal3Results] = useState<Signal3Result[]>([]);
  const [signal4Results, setSignal4Results] = useState<Signal4Result[]>([]);

  // 信号状态
  const [signal1Status, setSignal1Status] = useState<SignalStatus>('idle');
  const [signal2Status, setSignal2Status] = useState<SignalStatus>('idle');
  const [signal3Status, setSignal3Status] = useState<SignalStatus>('idle');
  const [signal4Status, setSignal4Status] = useState<SignalStatus>('idle');

  // 进度
  const [signal1Progress, setSignal1Progress] = useState(0);
  const [signal2Progress, setSignal2Progress] = useState(0);
  const [signal3Progress, setSignal3Progress] = useState(0);
  const [signal4Progress, setSignal4Progress] = useState(0);

  // MeSH Tree Number 统计（信号2 数据来源标识）
  const [signal2TreeStats, setSignal2TreeStats] = useState<{
    totalUniqueTerms: number;
    termsFoundInMesh: number;
    coverage: number;
    source: 'mesh-api' | 'keyword-fallback';
  } | null>(null);

  // 指标
  const [signal1Metrics, setSignal1Metrics] = useState<Metrics | null>(null);
  const [signal2Metrics, setSignal2Metrics] = useState<Metrics | null>(null);
  const [signal3Metrics, setSignal3Metrics] = useState<Metrics | null>(null);
  const [signal4Metrics, setSignal4Metrics] = useState<Metrics | null>(null);

  // 配置
  const [llmModel, setLlmModel] = useState('doubao-seed-2-0-lite-260215');
  const [llmTemperature, setLlmTemperature] = useState('0.3');
  const [batchSize, setBatchSize] = useState('20');
  const [signal4K, setSignal4K] = useState('5');

  // 融合权重
  const [fusionWeights, setFusionWeights] = useState({ w1: 0.5, w2: 0.3, w3: 0.05, w4: 0.15 });
  // 无监督权重方法：各方法对比结果由 methodResults (useMemo) 自动计算

  // 文件上传 refs
  const paperFileRef = useRef<HTMLInputElement>(null);
  const h1FileRef = useRef<HTMLInputElement>(null);
  const citationFileRef = useRef<HTMLInputElement>(null);
  // 持久化最近一次 H1 标签，保证论文文件与 H1 文件的上传顺序无关
  const lastH1MapRef = useRef<Map<string, { classifications: string[]; rating: string }>>(new Map());

  // Citation数据
  const [citationData, setCitationData] = useState<Map<string, { citations: number; year: number }>>(new Map());
  const [citationFile, setCitationFile] = useState('');

  // Excel 解析状态：大文件（5000+ 行）同步解析需 1-3 秒，先让"解析中"提示渲染再执行
  const [parsing, setParsing] = useState<'paper' | 'h1' | 'citation' | null>(null);

  // 可恢复的 IndexedDB 会话（刷新/崩溃后检测到未完成数据时弹出提示）
  const [resumeInfo, setResumeInfo] = useState<SessionMeta | null>(null);
  // 恢复会话的操作中状态
  const [resuming, setResuming] = useState(false);

  // ============ 数据上传处理 ============
  const handlePaperFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setParsing('paper');
    // 让加载状态先渲染，再执行同步解析，避免"点击后页面无反应"的假死感
    await new Promise(r => setTimeout(r, 30));
    try {
      const rows = await parseExcelFile(file);
      const parsedPapers: Paper[] = rows.map(row => {
        const pmid = extractValue(row, ['PMID', 'pmid', 'pubmed id']);
        const title = extractValue(row, ['Title', 'title', '题名', '标题']);
        const abstract = extractValue(row, ['Abstract', 'abstract', '摘要']);
        // 数据集A原始表年份列名为 Time（格式 2021-Apr），兼容 Year/年份
        const yearRaw = extractValue(row, ['Time', 'Year', 'year', 'Publication Year', '年份', '时间', '发表时间']);
        const year = parseYear(yearRaw);
        // 数据集A原始表类型列名为「论文类型」
        const paperType = extractValue(row, ['论文类型', 'Publication Type', 'publication type', 'paper type', '文献类型', 'PT']);
        // 数据集A原始表 MeSH 列名为「MeSH词」
        const meshRaw = extractValue(row, ['MeSH词', 'MeSH Terms', 'mesh terms', 'mesh term', 'MeSH', 'mesh', '主题词']);
        const meshTerms = parseMeshTerms(meshRaw);

        return { pmid, title, abstract, meshTerms, year, paperType, isH1: false, h1Classification: [], h1Rating: '' };
      }).filter(p => p.pmid && p.title);

      // 用持久化的 H1 映射标注，支持任意上传顺序（先传H1或先传论文均可）
      const h1InfoMap = lastH1MapRef.current;
      const finalPapers = parsedPapers.map(p => {
        const h1Info = h1InfoMap.get(p.pmid);
        return h1Info
          ? { ...p, isH1: true, h1Classification: h1Info.classifications, h1Rating: h1Info.rating }
          : p;
      });
      setPapers(finalPapers);
      setDataSource(prev => ({ ...prev, paperFile: file.name }));

      // IndexedDB 持久化：新数据集（pmid 指纹变化）清空旧缓存，否则保留断点
      (async () => {
        try {
          const hash = computePapersHash(finalPapers.map(p => p.pmid));
          const meta = await idbLoadMeta();
          if (!meta || meta.papersHash !== hash) {
            await idbClearAll();
          }
          await idbSavePapers(finalPapers);
          await idbSaveMeta({
            id: 'session', papersHash: hash, paperCount: finalPapers.length,
            s1Done: 0, s1Status: 'partial', s2Done: false, s3Done: false, s4Done: false,
            updatedAt: Date.now(),
          });
          setResumeInfo(null);
        } catch { /* IndexedDB 不可用时静默降级，不影响主流程 */ }
      })();
    } catch (err) {
      alert('论文数据解析失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setParsing(null);
    }
  }, []);

  const handleH1FileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setParsing('h1');
    await new Promise(r => setTimeout(r, 30));
    try {
      const rows = await parseExcelFile(file);
      // 构建H1论文映射
      const h1Map = new Map<string, { classifications: string[]; rating: string }>();
      for (const row of rows) {
        const pmid = extractValue(row, ['PMID', 'pmid', 'pubmed id']);
        // 数据集A对比表列为 Classifications；兼容旧的 Classification
        const classification = extractValue(row, [
          'Classifications', 'Classification', 'classification', 'h1classification', '分类',
        ]);
        // 数据集A对比表列为 Evaluation Rating；精确匹配优先，避免误匹配
        const rating = extractValue(row, [
          'Evaluation Rating', 'h1Rating', 'Rating', 'rating', 'recommendation status', '评价', '等级',
        ]);

        if (pmid) {
          // 支持分号/逗号分隔的多分类
          const classificationList = classification
            ? classification.split(/[;|]/).map(s => s.trim()).filter(Boolean)
            : [];
          const existing = h1Map.get(pmid);
          if (existing) {
            for (const c of classificationList) {
              if (!existing.classifications.includes(c)) existing.classifications.push(c);
            }
            // 保留更高评级
            if (rating && (!existing.rating || rating === 'Exceptional' || (rating === 'Very Good' && existing.rating !== 'Exceptional'))) {
              existing.rating = rating;
            }
          } else {
            h1Map.set(pmid, {
              classifications: classificationList,
              // 对比文件中存在即视为 H1；评级列可能为空
              rating: rating || '',
            });
          }
        }
      }

      // 持久化 H1 映射，并标注已加载的论文（含清除上一份文件中不再是 H1 的标记）
      lastH1MapRef.current = h1Map;
      setPapers(prev => {
        const next = prev.map(p => {
          const h1 = h1Map.get(p.pmid);
          return h1
            ? { ...p, isH1: true, h1Classification: h1.classifications, h1Rating: h1.rating }
            : { ...p, isH1: false, h1Classification: [], h1Rating: '' };
        });
        // H1 标注并入论文缓存（hash 不变，不影响既有信号断点）
        idbSavePapers(next).catch(() => {});
        return next;
      });
      setDataSource(prev => ({ ...prev, h1File: file.name }));
    } catch (err) {
      alert('H1数据解析失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setParsing(null);
    }
  }, []);

  // ============ Citation数据上传处理 ============
  const handleCitationFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setParsing('citation');
    await new Promise(r => setTimeout(r, 30));
    try {
      const rows = await parseExcelFile(file);
      const citMap = new Map<string, { citations: number; year: number }>();
      for (const row of rows) {
        const pmid = extractValue(row, ['pmid', 'PMID']);
        const citations = extractValue(row, ['citation', 'Citation', 'citations', 'Citations', 'citation_count', 'CitationCount', '被引次数', '引用数']);
        const year = extractValue(row, ['year', 'Year', 'publication_year', 'PublicationYear', '发表年份']);
        if (pmid && citations) {
          const citCount = parseInt(citations);
          const yearNum = year ? parseInt(year) : 0;
          if (!isNaN(citCount)) {
            citMap.set(pmid, { citations: citCount, year: yearNum || 2020 });
          }
        }
      }
      setCitationData(citMap);
      setCitationFile(file.name);
    } catch (err) {
      alert('Citation数据解析失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setParsing(null);
    }
  }, []);

  // 标记数据已加载
  React.useEffect(() => {
    if (papers.length > 0) {
      setDataLoaded(true);
    }
  }, [papers]);

  // 页面加载时检测 IndexedDB 中未完成的会话（刷新/崩溃恢复入口）
  React.useEffect(() => {
    (async () => {
      try {
        const meta = await idbLoadMeta();
        if (!meta) return;
        const hasWork = meta.s1Done > 0 || meta.s2Done || meta.s3Done || meta.s4Done;
        if (meta.paperCount > 0 && hasWork) setResumeInfo(meta);
      } catch { /* IndexedDB 不可用 */ }
    })();
  }, []);

  // 恢复会话：论文 + 各信号结果 + 完成状态全部还原
  const handleResumeSession = useCallback(async () => {
    setResuming(true);
    try {
      const meta = await idbLoadMeta();
      const cachedPapers = await idbLoadPapers<Paper>();
      if (!meta || cachedPapers.length === 0) {
        setResumeInfo(null);
        return;
      }
      setPapers(cachedPapers);
      setDataLoaded(true);

      const labels = cachedPapers.map(p => ({ pmid: p.pmid, isH1: p.isH1 }));

      // 信号1：恢复全部已落盘结果；done 则重算指标，partial 则保留待续跑
      const s1 = await idbLoadSignal1<Signal1Result>();
      if (s1.length > 0) {
        const order = new Map(cachedPapers.map((p, i) => [p.pmid, i]));
        s1.sort((a, b) => (order.get(a.pmid) ?? 0) - (order.get(b.pmid) ?? 0));
        setSignal1Results(s1);
        if (meta.s1Status === 'done' && s1.length === cachedPapers.length) {
          setSignal1Metrics(computeMetrics(s1.map(r => ({ pmid: r.pmid, score: r.score })), labels));
          setSignal1Status('done');
        } else {
          // 部分结果：置回 idle，用户点运行即自动断点续跑
          setSignal1Status('idle');
          setSignal1Progress(Math.round((s1.length / cachedPapers.length) * 100));
        }
      }

      const s2 = await idbLoadSignal<Signal2Result[]>('s2');
      if (meta.s2Done && s2 && s2.length > 0) {
        setSignal2Results(s2);
        setSignal2Metrics(computeMetrics(s2.map(r => ({ pmid: r.pmid, score: r.score })), labels));
        setSignal2Progress(100);
        setSignal2Status('done');
      }
      const s3 = await idbLoadSignal<Signal3Result[]>('s3');
      if (meta.s3Done && s3 && s3.length > 0) {
        setSignal3Results(s3);
        setSignal3Metrics(computeMetrics(s3.map(r => ({ pmid: r.pmid, score: r.score })), labels));
        setSignal3Progress(100);
        setSignal3Status('done');
      }
      const s4 = await idbLoadSignal<Signal4Result[]>('s4');
      if (meta.s4Done && s4 && s4.length > 0) {
        setSignal4Results(s4);
        setSignal4Metrics(computeMetrics(s4.map(r => ({ pmid: r.pmid, score: r.score })), labels));
        setSignal4Progress(100);
        setSignal4Status('done');
      }

      setDataSource(prev => ({ ...prev, paperFile: prev.paperFile || '(已从缓存恢复)' }));
      setResumeInfo(null);
    } catch (err) {
      console.error('恢复会话失败:', err);
      alert('恢复会话失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setResuming(false);
    }
  }, []);

  // 放弃缓存会话：清空 IndexedDB，从头开始
  const handleDiscardSession = useCallback(async () => {
    try { await idbClearAll(); } catch { /* ignore */ }
    setResumeInfo(null);
  }, []);

  // O(1) H1 标签查询表：替代渲染时 papers.find(...) 的 O(N) 线性查找。
  // 5355 篇 × 每个散点一次 find，会让散点图渲染变成 O(N²)（数千万次比较），是卡死主因之一。
  const h1LabelMap = React.useMemo(() => {
    const m = new Map<string, boolean>();
    for (const p of papers) m.set(p.pmid, p.isH1);
    return m;
  }, [papers]);

  // 各信号散点图数据（H1 全保留，非H1 降采样到 400 点以内），仅在结果变化时重算
  const SCATTER_CAP = 400;
  const signal1Scatter = React.useMemo(() => {
    const h1: Array<{ x: number; y: number }> = [];
    const nonH1: Array<{ x: number; y: number }> = [];
    signal1Results.forEach((r, i) => {
      (h1LabelMap.get(r.pmid) ? h1 : nonH1).push({ x: i, y: r.score });
    });
    return { h1, nonH1: downsample(nonH1, SCATTER_CAP) };
  }, [signal1Results, h1LabelMap]);

  const signal2Scatter = React.useMemo(() => {
    const h1: Array<{ meshCount: number; crossDomain: number }> = [];
    const nonH1: Array<{ meshCount: number; crossDomain: number }> = [];
    for (const r of signal2Results) {
      (h1LabelMap.get(r.pmid) ? h1 : nonH1).push({ meshCount: r.meshCount, crossDomain: r.crossDomainIndex });
    }
    return { h1, nonH1: downsample(nonH1, SCATTER_CAP) };
  }, [signal2Results, h1LabelMap]);

  const signal3Scatter = React.useMemo(() => {
    const h1: Array<{ keywords: number; score: number }> = [];
    const nonH1: Array<{ keywords: number; score: number }> = [];
    for (const r of signal3Results) {
      (h1LabelMap.get(r.pmid) ? h1 : nonH1).push({ keywords: r.keywordCount, score: r.score });
    }
    return { h1, nonH1: downsample(nonH1, SCATTER_CAP) };
  }, [signal3Results, h1LabelMap]);

  const signal4Scatter = React.useMemo(() => {
    const h1: Array<{ deviation: number; rarity: number }> = [];
    const nonH1: Array<{ deviation: number; rarity: number }> = [];
    for (const r of signal4Results) {
      const point = { deviation: r.deviationScore || 0, rarity: r.frequencyScore || 0 };
      (h1LabelMap.get(r.pmid) ? h1 : nonH1).push(point);
    }
    return { h1, nonH1: downsample(nonH1, SCATTER_CAP) };
  }, [signal4Results, h1LabelMap]);

  // 信号4 分数直方图（H1/非H1 分箱），单次遍历
  const signal4Bins = React.useMemo(() => {
    const bins = Array.from({ length: 10 }, (_, i) => ({
      range: `${i * 10}-${(i + 1) * 10}`,
      H1: 0,
      nonH1: 0,
    }));
    for (const r of signal4Results) {
      const binIdx = Math.min(Math.floor(r.score * 100 / 10), 9);
      if (h1LabelMap.get(r.pmid)) bins[binIdx].H1++;
      else bins[binIdx].nonH1++;
    }
    return bins;
  }, [signal4Results, h1LabelMap]);

  // 信号4 H1/非H1 统计摘要（单次遍历，替代渲染时 6 次 O(N) filter）
  const signal4Summary = React.useMemo(() => {
    const zero = { h1Avg: 0, nonH1Avg: 0, h1DevAvg: 0, nonH1DevAvg: 0, h1RarAvg: 0, nonH1RarAvg: 0 };
    if (signal4Results.length === 0) return zero;
    let h1N = 0, nonH1N = 0, h1Sum = 0, nonH1Sum = 0, h1Dev = 0, nonH1Dev = 0, h1Rar = 0, nonH1Rar = 0;
    for (const r of signal4Results) {
      if (h1LabelMap.get(r.pmid)) {
        h1N++; h1Sum += r.score; h1Dev += r.deviationScore || 0; h1Rar += r.frequencyScore || 0;
      } else {
        nonH1N++; nonH1Sum += r.score; nonH1Dev += r.deviationScore || 0; nonH1Rar += r.frequencyScore || 0;
      }
    }
    return {
      h1Avg: h1N ? h1Sum / h1N : 0,
      nonH1Avg: nonH1N ? nonH1Sum / nonH1N : 0,
      h1DevAvg: h1N ? h1Dev / h1N : 0,
      nonH1DevAvg: nonH1N ? nonH1Dev / nonH1N : 0,
      h1RarAvg: h1N ? h1Rar / h1N : 0,
      nonH1RarAvg: nonH1N ? nonH1Rar / nonH1N : 0,
    };
  }, [signal4Results, h1LabelMap]);

  // ============ 信号运行函数 ============
  const runSignal1 = useCallback(async () => {
    if (papers.length === 0) return;
    setSignal1Status('running');
    setSignal1Progress(0);
    setSignal1Metrics(null);

    const bs = parseInt(batchSize) || 20;
    const temp = parseFloat(llmTemperature) || 0.3;
    // 结果刷新节流：5500 篇约 275 个批次，若每批都全量 setState，
    // 大组件树会重渲染 275 次导致持续掉帧；改为最多每秒刷新一次，最后一批强制刷新
    const FLUSH_INTERVAL_MS = 1000;
    let lastFlush = 0;

    // ---- 断点续跑：读取 IndexedDB 中同源数据的已完成结果，跳过这些 PMID ----
    // 注意：若当前已有完整结果（用户点"重新运行"），则清空断点从头计算
    const resultByPmid = new Map<string, Signal1Result>();
    const papersHash = computePapersHash(papers.map(p => p.pmid));
    const isFullRerun = signal1Results.length >= papers.length;
    try {
      if (isFullRerun) {
        await idbClearSignal1();
      } else {
        const meta = await idbLoadMeta();
        if (meta && meta.papersHash === papersHash) {
          const cached = await idbLoadSignal1<Signal1Result>();
          for (const r of cached) resultByPmid.set(r.pmid, r);
        } else {
          // 数据指纹不匹配（换了数据集）：清掉旧断点
          await idbClearSignal1();
        }
      }
    } catch { /* IndexedDB 不可用时退化为不缓存 */ }

    const remaining = papers.filter(p => !resultByPmid.has(p.pmid));
    const totalCount = papers.length;
    // 用于节流刷新的快照：按 papers 原始顺序装配（断点结果 + 新结果合并）
    const buildSnapshot = () =>
      papers.map(p => resultByPmid.get(p.pmid)).filter((r): r is Signal1Result => !!r);

    // 已有部分结果先展示出来（续跑场景）
    if (resultByPmid.size > 0) {
      setSignal1Results(buildSnapshot());
      setSignal1Progress(Math.round((resultByPmid.size / totalCount) * 100));
    } else {
      setSignal1Results([]);
    }

    try {
      for (let i = 0; i < remaining.length; i += bs) {
        const batch = remaining.slice(i, i + bs);
        const response = await fetch('/api/signal1', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            papers: batch.map(p => ({ pmid: p.pmid, title: p.title, abstract: p.abstract })),
            model: llmModel,
            temperature: temp,
          }),
        });

        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }

        const data = await response.json();
        const batchResults: Signal1Result[] = (data.results || []).map((r: Record<string, unknown>) => ({
          pmid: r.pmid as string,
          innovationTypes: r.innovationTypes as Signal1Result['innovationTypes'],
          primaryType: r.primaryType as string,
          reasoning: r.reasoning as string,
          score: r.score as number,
        }));

        for (const r of batchResults) resultByPmid.set(r.pmid, r);
        // 每批增量落盘：中途断连/刷新后可从断点续跑
        idbSaveSignal1Batch(batchResults).catch(() => {});
        idbSaveMeta({
          id: 'session', papersHash, paperCount: totalCount,
          s1Done: resultByPmid.size,
          s1Status: resultByPmid.size >= totalCount ? 'done' : 'partial',
          s2Done: false, s3Done: false, s4Done: false, updatedAt: Date.now(),
        }).catch(() => {});

        const now = Date.now();
        const isLastBatch = i + bs >= remaining.length;
        if (isLastBatch) {
          // 最后一批同步 flush，确保 done 状态与完整结果同时生效
          setSignal1Results(buildSnapshot());
        } else if (now - lastFlush >= FLUSH_INTERVAL_MS) {
          lastFlush = now;
          const snapshot = buildSnapshot();
          // startTransition：大结果集渲染可中断，输入/切换 Tab 等交互不被阻塞
          startTransition(() => setSignal1Results(snapshot));
        }
        setSignal1Progress(Math.round((resultByPmid.size / totalCount) * 100));
      }

      const finalResults = buildSnapshot();
      const metrics = computeMetrics(
        finalResults.map(r => ({ pmid: r.pmid, score: r.score })),
        papers.map(p => ({ pmid: p.pmid, isH1: p.isH1 })),
      );
      setSignal1Metrics(metrics);
      setSignal1Status('done');
      idbSaveMeta({
        id: 'session', papersHash, paperCount: totalCount,
        s1Done: finalResults.length, s1Status: 'done',
        s2Done: false, s3Done: false, s4Done: false, updatedAt: Date.now(),
      }).catch(() => {});
    } catch (err) {
      console.error('Signal 1 error:', err);
      // 中途失败也保留已完成的批次结果（IndexedDB 已有增量落盘），便于续跑
      setSignal1Results(buildSnapshot());
      setSignal1Status('error');
    }
  }, [papers, llmModel, llmTemperature, batchSize, signal1Results.length]);

  const runSignal2 = useCallback(async () => {
    if (papers.length === 0) return;
    setSignal2Status('running');
    setSignal2Progress(0);
    setSignal2Results([]);
    setSignal2Metrics(null);

    try {
      const response = await fetch('/api/signal2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          papers: papers.map(p => ({ pmid: p.pmid, meshTerms: p.meshTerms })),
        }),
      });

      if (!response.ok) throw new Error(`API error: ${response.status}`);

      const data = await response.json();
      const results: Signal2Result[] = (data.results || []).map((r: Record<string, unknown>) => ({
        pmid: r.pmid as string,
        meshCount: r.meshCount as number,
        uniqueDomains: r.uniqueDomains as number,
        crossDomainIndex: r.crossDomainIndex as number,
        domainDistribution: r.domainDistribution as Record<string, number>,
        hasMeSH: r.hasMeSH as boolean,
        score: r.score as number,
      }));

      // 保存 MeSH Tree Number 统计信息（用于显示数据来源）
      const treeStats = data.treeNumberStats as {
        totalUniqueTerms: number;
        termsFoundInMesh: number;
        coverage: number;
        source: 'mesh-api' | 'keyword-fallback';
      } | undefined;
      setSignal2TreeStats(treeStats || null);

      setSignal2Results(results);
      setSignal2Progress(100);

      const metrics = computeMetrics(
        results.map(r => ({ pmid: r.pmid, score: r.score })),
        papers.map(p => ({ pmid: p.pmid, isH1: p.isH1 })),
      );
      setSignal2Metrics(metrics);
      setSignal2Status('done');
      idbSaveSignal('s2', results).catch(() => {});
      idbLoadMeta().then(m => m && idbSaveMeta({ ...m, s2Done: true, updatedAt: Date.now() })).catch(() => {});
    } catch (err) {
      console.error('Signal 2 error:', err);
      setSignal2Status('error');
    }
  }, [papers]);

  const runSignal3 = useCallback(async () => {
    if (papers.length === 0) return;
    setSignal3Status('running');
    setSignal3Progress(0);
    setSignal3Results([]);
    setSignal3Metrics(null);

    try {
      setSignal3Progress(20);
      const response = await fetch('/api/signal3', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          papers: papers.map(p => ({ pmid: p.pmid, title: p.title, abstract: p.abstract })),
          topKeywords: 15,
        }),
      });

      if (!response.ok) throw new Error(`API error: ${response.status}`);
      setSignal3Progress(80);

      const data = await response.json();
      const results: Signal3Result[] = (data.results || []).map((r: Record<string, unknown>) => ({
        pmid: r.pmid as string,
        keywordCount: r.keywordCount as number,
        betweenness: r.betweenness as number,
        normalizedBetweenness: r.normalizedBetweenness as number,
        bridgingKeywords: r.bridgingKeywords as string[],
        topKeywords: (r.topKeywords as Array<{ keyword: string; score: number }>) || [],
        score: r.score as number,
      }));

      setSignal3Results(results);
      setSignal3Progress(100);

      const metrics = computeMetrics(
        results.map(r => ({ pmid: r.pmid, score: r.score })),
        papers.map(p => ({ pmid: p.pmid, isH1: p.isH1 })),
      );
      setSignal3Metrics(metrics);
      setSignal3Status('done');
      idbSaveSignal('s3', results).catch(() => {});
      idbLoadMeta().then(m => m && idbSaveMeta({ ...m, s3Done: true, updatedAt: Date.now() })).catch(() => {});
    } catch (err) {
      console.error('Signal 3 error:', err);
      setSignal3Status('error');
    }
  }, [papers]);

  // ============ 信号4：认知偏离度 ============
  const runSignal4 = useCallback(async () => {
    if (papers.length === 0) {
      alert('请先上传论文数据');
      return;
    }

    setSignal4Status('running');
    setSignal4Progress(0);
    setSignal4Results([]);
    setSignal4Metrics(null);

    try {
      const response = await fetch('/api/signal4', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          papers: papers.map(p => ({
            pmid: p.pmid,
            title: p.title,
            abstract: p.abstract,
            meshTerms: p.meshTerms,
          })),
        }),
      });

      if (!response.ok) throw new Error(`API error: ${response.status}`);

      const data = await response.json();
      const results = data.results as Signal4Result[];
      
      setSignal4Results(results);
      setSignal4Progress(100);

      // 计算指标
      const metrics = computeMetrics(
        results.map(r => ({ pmid: r.pmid, score: r.score })),
        papers.map(p => ({ pmid: p.pmid, isH1: p.isH1 })),
      );
      setSignal4Metrics(metrics);
      setSignal4Status('done');
      idbSaveSignal('s4', results).catch(() => {});
      idbLoadMeta().then(m => m && idbSaveMeta({ ...m, s4Done: true, updatedAt: Date.now() })).catch(() => {});
    } catch (err) {
      console.error('Signal 5 error:', err);
      setSignal4Status('error');
    }
  }, [papers]);

  // ============ 融合计算 ============
  // 检测退化信号（所有值相同，无区分力）
  const isDegenerate = (results: Array<{ score: number }>) => {
    if (results.length === 0) return true;
    const scores = results.map(r => r.score);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    return max - min < 1e-10; // 浮点精度内无差异
  };

  // 仅纳入「已完成(status==='done')」的信号：运行中的中间结果（如 S1 每 20 篇一批）
  // 不进入融合，避免每个批次都触发全量融合/PCA/嵌套CV重算导致页面卡死。
  // 门控稳定化：信号未完成时依赖恒为 null，S1 分批中间结果不再触发
  // normalizedMatrix → methodResults → citationValidation 等下游全链重算
  const s1Done = signal1Status === 'done';
  const s2Done = signal2Status === 'done';
  const s3Done = signal3Status === 'done';
  const s4Done = signal4Status === 'done';
  const fusionInputs = React.useMemo(() => ({
    s1: s1Done ? signal1Results : [],
    s2: s2Done ? signal2Results : [],
    s3: s3Done ? signal3Results : [],
    s4: s4Done ? signal4Results : [],
  }), [
    s1Done, s1Done ? signal1Results : null,
    s2Done, s2Done ? signal2Results : null,
    s3Done, s3Done ? signal3Results : null,
    s4Done, s4Done ? signal4Results : null,
  ]);

  const fusionResults = React.useMemo(() => {
    const { s1, s2, s3, s4 } = fusionInputs;
    if (s1.length === 0 && s2.length === 0 && s3.length === 0 && s4.length === 0) {
      return [];
    }

    // 只为至少出现在一个已完成信号中的论文建表
    const scoreMap = new Map<string, { s1: number; s2: number; s3: number; s4: number; isH1: boolean }>();
    const h1Label = new Map(papers.map(p => [p.pmid, p.isH1]));
    const ensure = (pmid: string) => {
      let e = scoreMap.get(pmid);
      if (!e) {
        e = { s1: 0, s2: 0, s3: 0, s4: 0, isH1: h1Label.get(pmid) ?? false };
        scoreMap.set(pmid, e);
      }
      return e;
    };

    // 检测退化信号并自动调整权重
    const degenerateS1 = s1.length === 0 || isDegenerate(s1);
    const degenerateS2 = s2.length === 0 || isDegenerate(s2);
    const degenerateS3 = s3.length === 0 || isDegenerate(s3);
    const degenerateS4 = s4.length === 0 || isDegenerate(s4);

    // 填充各信号（归一化后）
    if (!degenerateS1) {
      const scores = minMaxNormalize(s1.map(r => r.score));
      s1.forEach((r, i) => { ensure(r.pmid).s1 = scores[i]; });
    }
    if (!degenerateS2) {
      const scores = minMaxNormalize(s2.map(r => r.score));
      s2.forEach((r, i) => { ensure(r.pmid).s2 = scores[i]; });
    }
    if (!degenerateS3) {
      const scores = minMaxNormalize(s3.map(r => r.score));
      s3.forEach((r, i) => { ensure(r.pmid).s3 = scores[i]; });
    }
    if (!degenerateS4) {
      const scores = minMaxNormalize(s4.map(r => r.score));
      s4.forEach((r, i) => { ensure(r.pmid).s4 = scores[i]; });
    }

    // 自动调整权重：退化信号的权重置0，剩余权重重新分配
    let { w1, w2, w3, w4 } = fusionWeights;
    if (degenerateS1) w1 = 0;
    if (degenerateS2) w2 = 0;
    if (degenerateS3) w3 = 0;
    if (degenerateS4) w4 = 0;
    const wSum = w1 + w2 + w3 + w4;

    // 如果所有信号都退化，回退到均匀分
    if (wSum === 0) {
      return Array.from(scoreMap.entries()).map(([pmid, sc]) => ({
        pmid,
        signal1Score: sc.s1,
        signal2Score: sc.s2,
        signal3Score: sc.s3,
        signal4Score: sc.s4,
        fusedScore: 0.5,
        isH1: sc.isH1,
        degraded: true as const,
      })).sort((a, b) => b.fusedScore - a.fusedScore);
    }

    return Array.from(scoreMap.entries()).map(([pmid, sc]) => ({
      pmid,
      signal1Score: sc.s1,
      signal2Score: sc.s2,
      signal3Score: sc.s3,
      signal4Score: sc.s4,
      fusedScore: (sc.s1 * w1 + sc.s2 * w2 + sc.s3 * w3 + sc.s4 * w4) / wSum,
      isH1: sc.isH1,
      weightsUsed: { w1, w2, w3, w4 },
      degenerateSignals: [degenerateS1 ? 'S1' : '', degenerateS2 ? 'S2' : '', degenerateS3 ? 'S3' : '', degenerateS4 ? 'S4' : ''].filter(Boolean),
    })).sort((a, b) => b.fusedScore - a.fusedScore);
    // 仅依赖「已完成」的信号结果与权重；S1 分批运行不会重算
  }, [fusionInputs, fusionWeights, papers]);

  const fusionMetrics = React.useMemo(() => fusionResults.length > 0
    ? computeMetrics(
        fusionResults.map(r => ({ pmid: r.pmid, score: r.fusedScore })),
        fusionResults.map(r => ({ pmid: r.pmid, isH1: r.isH1 })),
      )
    : null, [fusionResults]);

  // ============ Citation验证 ============
  const citationValidation = React.useMemo(() => {
    if (citationData.size === 0 || fusionResults.length === 0) return null;

    // 构建带年份的citation数据
    const papersWithCitation = papers
      .filter(p => citationData.has(p.pmid))
      .map(p => {
        const cit = citationData.get(p.pmid)!;
        return { pmid: p.pmid, citationCount: cit.citations, year: cit.year };
      });

    // 计算citation/year percentile
    const percentileMap = computeCitationPercentile(papersWithCitation);

    // 按融合得分排序
    const sorted = [...fusionResults].sort((a, b) => b.fusedScore - a.fusedScore);

    // 所有有citation数据的论文的percentile（用于随机基线）
    const allPercentiles = papersWithCitation
      .map(p => percentileMap.get(p.pmid) ?? 0)
      .filter(p => p > 0);

    // 所有有citation数据的论文的citation（用于Mann-Whitney U检验）
    const allCitations = papersWithCitation.map(p => p.citationCount);

    // 计算不同K值的指标
    const kValues = [10, 50, 100, 200, 300, 500, 1000];
    const results = kValues.map(k => {
      const topK = sorted.slice(0, k);
      const topKCitations = topK
        .map(r => citationData.get(r.pmid)?.citations ?? 0)
        .filter(c => c > 0);

      const topKPercentiles = topK
        .map(r => percentileMap.get(r.pmid) ?? 0)
        .filter(p => p > 0);

      const avgTopK = topKCitations.length > 0
        ? topKCitations.reduce((a, b) => a + b, 0) / topKCitations.length
        : 0;
      const avgRandom = allCitations.length > 0
        ? allCitations.reduce((a, b) => a + b, 0) / allCitations.length
        : 0;

      const avgPercentileTopK = topKPercentiles.length > 0
        ? topKPercentiles.reduce((a, b) => a + b, 0) / topKPercentiles.length
        : 0;
      const avgPercentileRandom = allPercentiles.length > 0
        ? allPercentiles.reduce((a, b) => a + b, 0) / allPercentiles.length
        : 0;

      // Mann-Whitney U检验
      const mwuResult = mannWhitneyUTest(topKCitations, allCitations);

      return {
        k,
        avgTopK: Math.round(avgTopK * 100) / 100,
        avgRandom: Math.round(avgRandom * 100) / 100,
        enrichment: avgRandom > 0 ? Math.round((avgTopK / avgRandom) * 100) / 100 : 0,
        avgPercentileTopK: Math.round(avgPercentileTopK * 10) / 10,
        avgPercentileRandom: Math.round(avgPercentileRandom * 10) / 10,
        percentileEnrichment: avgPercentileRandom > 0 ? Math.round((avgPercentileTopK / avgPercentileRandom) * 100) / 100 : 0,
        pValue: mwuResult.p,
        significant: mwuResult.significant,
        stars: mwuResult.stars,
        topKCount: topKCitations.length,
        totalCount: allCitations.length,
      };
    });

    return results;
  }, [citationData, fusionResults, papers]);

  // ============ 箱线图数据计算 ============
  const boxPlotData = React.useMemo(() => {
    if (citationData.size === 0 || fusionResults.length === 0) return null;

    // 计算五数概括
    const fiveNumberSummary = (values: number[]) => {
      if (values.length === 0) return { min: 0, q1: 0, median: 0, q3: 0, max: 0 };
      const sorted = [...values].sort((a, b) => a - b);
      const n = sorted.length;
      const median = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)];
      const q1 = sorted[Math.floor(n * 0.25)];
      const q3 = sorted[Math.floor(n * 0.75)];
      return {
        min: sorted[0],
        q1,
        median,
        q3,
        max: sorted[n - 1],
      };
    };

    // 随机抽样函数（固定种子以保证可重复性）
    const randomSample = (arr: number[], n: number) => {
      const shuffled = [...arr].sort(() => 0.5 - Math.random());
      return shuffled.slice(0, n);
    };

    // 有citation数据的论文
    const papersWithCitation = fusionResults
      .filter(r => citationData.has(r.pmid))
      .map(r => ({ pmid: r.pmid, citationCount: citationData.get(r.pmid)!.citations }));

    const allCitations = papersWithCitation.map(p => p.citationCount);
    const sorted = [...fusionResults].sort((a, b) => b.fusedScore - a.fusedScore);

    const kValues = [10, 50, 100, 200, 500];
    return kValues.map(k => {
      const topKCitations = sorted.slice(0, k)
        .map(r => citationData.get(r.pmid)?.citations ?? 0)
        .filter(c => c > 0);

      const randomCitations = randomSample(allCitations, Math.min(k, allCitations.length));

      return {
        k,
        topK: fiveNumberSummary(topKCitations),
        random: fiveNumberSummary(randomCitations),
      };
    });
  }, [citationData, fusionResults]);

  // ============ 无监督权重计算 ============
  // 构建归一化矩阵 (n × 4)
  const normalizedMatrix = React.useMemo(() => {
    // 仅使用已完成的信号，避免分批运行时反复触发熵权/CRITIC/PCA 重算
    const { s1, s2, s3, s4 } = fusionInputs;
    if (s1.length === 0 && s2.length === 0 && s3.length === 0 && s4.length === 0) {
      return null;
    }

    // 收集所有有结果的PMID
    const pmidSet = new Set<string>();
    s1.forEach(r => pmidSet.add(r.pmid));
    s2.forEach(r => pmidSet.add(r.pmid));
    s3.forEach(r => pmidSet.add(r.pmid));
    s4.forEach(r => pmidSet.add(r.pmid));

    const pmids = Array.from(pmidSet);
    if (pmids.length === 0) return null;

    // 构建各信号的原始分数映射
    const s1Map = new Map(s1.map(r => [r.pmid, r.score]));
    const s2Map = new Map(s2.map(r => [r.pmid, r.score]));
    const s3Map = new Map(s3.map(r => [r.pmid, r.score]));
    const s4Map = new Map(s4.map(r => [r.pmid, r.score]));

    // 提取各信号原始分数数组
    const s1Raw = pmids.map(pmid => s1Map.get(pmid) ?? 0);
    const s2Raw = pmids.map(pmid => s2Map.get(pmid) ?? 0);
    const s3Raw = pmids.map(pmid => s3Map.get(pmid) ?? 0);
    const s4Raw = pmids.map(pmid => s4Map.get(pmid) ?? 0);

    // Min-Max归一化
    const s1Norm = minMaxNormalize(s1Raw);
    const s2Norm = minMaxNormalize(s2Raw);
    const s3Norm = minMaxNormalize(s3Raw);
    const s4Norm = minMaxNormalize(s4Raw);

    // 构建 n×4 矩阵
    const matrix: number[][] = pmids.map((_, i) => [s1Norm[i], s2Norm[i], s3Norm[i], s4Norm[i]]);

    return { pmids, matrix, s1Norm, s2Norm, s3Norm, s4Norm };
  }, [fusionInputs]);

  // 计算各方法的权重和AUC
  const methodResults = React.useMemo(() => {
    if (!normalizedMatrix) return [];

    const { matrix, pmids, s1Norm, s2Norm, s3Norm, s4Norm } = normalizedMatrix;
    const labels = pmids.map(pmid => (h1LabelMap.get(pmid) ? 1 : 0));

    const methods: Array<{
      method: string;
      label: string;
      weights: { w1: number; w2: number; w3: number; w4: number };
      auc: number;
    }> = [];

    // 1. 手动权重（当前）
    const { w1, w2, w3, w4 } = fusionWeights;
    const wSum = w1 + w2 + w3 + w4;
    const manualScores = pmids.map((_, i) =>
      (s1Norm[i] * w1 + s2Norm[i] * w2 + s3Norm[i] * w3 + s4Norm[i] * w4) / (wSum || 1)
    );
    methods.push({
      method: 'manual',
      label: '手动权重',
      weights: { w1: w1 / (wSum || 1), w2: w2 / (wSum || 1), w3: w3 / (wSum || 1), w4: w4 / (wSum || 1) },
      auc: computeAUC(manualScores, labels),
    });

    // 2. 等权重
    const equalScores = pmids.map((_, i) => (s1Norm[i] + s2Norm[i] + s3Norm[i] + s4Norm[i]) / 4);
    methods.push({
      method: 'equal',
      label: '等权重',
      weights: { w1: 0.25, w2: 0.25, w3: 0.25, w4: 0.25 },
      auc: computeAUC(equalScores, labels),
    });

    // 3. 熵权法
    const ew = entropyWeights(matrix);
    const entropyScores = pmids.map((_, i) =>
      s1Norm[i] * ew[0] + s2Norm[i] * ew[1] + s3Norm[i] * ew[2] + s4Norm[i] * ew[3]
    );
    methods.push({
      method: 'entropy',
      label: '熵权法',
      weights: { w1: ew[0], w2: ew[1], w3: ew[2], w4: ew[3] },
      auc: computeAUC(entropyScores, labels),
    });

    // 4. CRITIC法
    const cw = criticWeights(matrix);
    const criticScores = pmids.map((_, i) =>
      s1Norm[i] * cw[0] + s2Norm[i] * cw[1] + s3Norm[i] * cw[2] + s4Norm[i] * cw[3]
    );
    methods.push({
      method: 'critic',
      label: 'CRITIC法',
      weights: { w1: cw[0], w2: cw[1], w3: cw[2], w4: cw[3] },
      auc: computeAUC(criticScores, labels),
    });

    // 5. PCA法
    const pw = pcaWeights(matrix);
    const pcaScores = pmids.map((_, i) =>
      s1Norm[i] * pw[0] + s2Norm[i] * pw[1] + s3Norm[i] * pw[2] + s4Norm[i] * pw[3]
    );
    methods.push({
      method: 'pca',
      label: 'PCA主成分',
      weights: { w1: pw[0], w2: pw[1], w3: pw[2], w4: pw[3] },
      auc: computeAUC(pcaScores, labels),
    });

    return methods;
  }, [normalizedMatrix, fusionWeights, h1LabelMap]);

  // Bootstrap稳定性分析
  const [bootstrapResults, setBootstrapResults] = useState<Record<string, Array<{ mean: number; std: number; ciLow: number; ciHigh: number }>> | null>(null);
  const [bootstrapRunning, setBootstrapRunning] = useState(false);

  const runBootstrap = useCallback(() => {
    if (!normalizedMatrix) return;
    setBootstrapRunning(true);

    // 使用setTimeout让UI先更新
    setTimeout(() => {
      const { matrix } = normalizedMatrix;
      const results: Record<string, Array<{ mean: number; std: number; ciLow: number; ciHigh: number }>> = {};

      results['entropy'] = bootstrapWeightStability(matrix, entropyWeights, 500);
      results['critic'] = bootstrapWeightStability(matrix, criticWeights, 500);
      results['pca'] = bootstrapWeightStability(matrix, pcaWeights, 500);

      setBootstrapResults(results);
      setBootstrapRunning(false);
    }, 50);
  }, [normalizedMatrix]);

  // 应用无监督权重到融合
  const applyUnsupervisedWeights = useCallback((methodKey: string) => {
    const found = methodResults.find(m => m.method === methodKey);
    if (found) {
      setFusionWeights(found.weights);
    }
  }, [methodResults]);

  // ============ 嵌套5折交叉验证 ============
  // 外层5折评估性能，内层在训练集上网格搜索最优权重（无数据泄漏）
  type NestedCVFoldResult = {
    fold: number;
    trainSize: number;
    testSize: number;
    trainH1: number;
    testH1: number;
    // 内层搜索到的最优权重
    bestWeights: { w1: number; w2: number; w3: number; w4: number };
    bestTrainAUC: number;
    methods: Record<string, { weights: { w1: number; w2: number; w3: number; w4: number }; auc: number }>;
  };

  const [nestedCvResults, setNestedCvResults] = useState<NestedCVFoldResult[] | null>(null);
  const [nestedCvRunning, setNestedCvRunning] = useState(false);

  const runNestedCrossValidation = useCallback(() => {
    if (!normalizedMatrix) return;
    setNestedCvRunning(true);

    setTimeout(() => {
      const { pmids, matrix, s1Norm, s2Norm, s3Norm, s4Norm } = normalizedMatrix;
      const labels = pmids.map(pmid => (h1LabelMap.get(pmid) ? 1 : 0));

      // 分层抽样
      const h1Indices: number[] = [];
      const nonH1Indices: number[] = [];
      labels.forEach((l, i) => {
        if (l === 1) h1Indices.push(i);
        else nonH1Indices.push(i);
      });

      const shuffle = (arr: number[]) => {
        const a = [...arr];
        for (let i = a.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
      };

      const h1Shuffled = shuffle(h1Indices);
      const nonH1Shuffled = shuffle(nonH1Indices);

      const splitToFolds = (indices: number[]) => {
        const folds: number[][] = [[], [], [], [], []];
        indices.forEach((idx, i) => {
          folds[i % 5].push(idx);
        });
        return folds;
      };

      const h1Folds = splitToFolds(h1Shuffled);
      const nonH1Folds = splitToFolds(nonH1Shuffled);

      const weightFns: Record<string, (m: number[][]) => number[]> = {
        entropy: entropyWeights,
        critic: criticWeights,
        pca: pcaWeights,
      };

      // 网格搜索步长
      const STEP = 0.05;

      const cvFolds: NestedCVFoldResult[] = [];

      for (let fold = 0; fold < 5; fold++) {
        const testIndices = [...h1Folds[fold], ...nonH1Folds[fold]];
        const trainIndices: number[] = [];
        for (let f = 0; f < 5; f++) {
          if (f !== fold) {
            trainIndices.push(...h1Folds[f], ...nonH1Folds[f]);
          }
        }

        const trainMatrix = trainIndices.map(i => matrix[i]);
        const trainS1 = trainIndices.map(i => s1Norm[i]);
        const trainS2 = trainIndices.map(i => s2Norm[i]);
        const trainS3 = trainIndices.map(i => s3Norm[i]);
        const trainS4 = trainIndices.map(i => s4Norm[i]);
        const trainLabels = trainIndices.map(i => labels[i]);

        const testS1 = testIndices.map(i => s1Norm[i]);
        const testS2 = testIndices.map(i => s2Norm[i]);
        const testS3 = testIndices.map(i => s3Norm[i]);
        const testS4 = testIndices.map(i => s4Norm[i]);
        const testLabels = testIndices.map(i => labels[i]);

        const foldMethods: NestedCVFoldResult['methods'] = {};

        // === 内层：在训练集上网格搜索最优权重 ===
        let bestW1 = 0.25, bestW2 = 0.25, bestW3 = 0.25, bestW4 = 0.25;
        let bestTrainAUC = 0;

        for (let a = 0; a <= 100; a += Math.round(STEP * 100)) {
          for (let b = 0; b <= 100 - a; b += Math.round(STEP * 100)) {
            for (let c = 0; c <= 100 - a - b; c += Math.round(STEP * 100)) {
              const d = 100 - a - b - c;
              const tw1 = a / 100;
              const tw2 = b / 100;
              const tw3 = c / 100;
              const tw4 = d / 100;

              const trainScores = trainIndices.map((_, ti) =>
                trainS1[ti] * tw1 + trainS2[ti] * tw2 + trainS3[ti] * tw3 + trainS4[ti] * tw4
              );
              const trainAUC = computeAUC(trainScores, trainLabels);

              if (trainAUC > bestTrainAUC) {
                bestTrainAUC = trainAUC;
                bestW1 = tw1;
                bestW2 = tw2;
                bestW3 = tw3;
                bestW4 = tw4;
              }
            }
          }
        }

        // 用内层最优权重评估外层测试集
        const bestTestScores = testIndices.map((_, ti) =>
          testS1[ti] * bestW1 + testS2[ti] * bestW2 + testS3[ti] * bestW3 + testS4[ti] * bestW4
        );
        const bestTestAUC = computeAUC(bestTestScores, testLabels);

        foldMethods['nested_optimal'] = {
          weights: { w1: bestW1, w2: bestW2, w3: bestW3, w4: bestW4 },
          auc: bestTestAUC,
        };

        // 等权重（baseline，无监督）
        const equalScores = testIndices.map((_, ti) => (testS1[ti] + testS2[ti] + testS3[ti] + testS4[ti]) / 4);
        foldMethods['equal'] = {
          weights: { w1: 0.25, w2: 0.25, w3: 0.25, w4: 0.25 },
          auc: computeAUC(equalScores, testLabels),
        };

        // 无监督方法：在训练集上计算权重，在测试集上评估
        for (const [key, weightFn] of Object.entries(weightFns)) {
          const weights = weightFn(trainMatrix);
          const scores = testIndices.map((_, ti) =>
            testS1[ti] * weights[0] + testS2[ti] * weights[1] + testS3[ti] * weights[2] + testS4[ti] * weights[3]
          );
          foldMethods[key] = {
            weights: { w1: weights[0], w2: weights[1], w3: weights[2], w4: weights[3] },
            auc: computeAUC(scores, testLabels),
          };
        }

        cvFolds.push({
          fold: fold + 1,
          trainSize: trainIndices.length,
          testSize: testIndices.length,
          trainH1: trainIndices.filter(i => labels[i] === 1).length,
          testH1: testIndices.filter(i => labels[i] === 1).length,
          bestWeights: { w1: bestW1, w2: bestW2, w3: bestW3, w4: bestW4 },
          bestTrainAUC,
          methods: foldMethods,
        });
      }

      setNestedCvResults(cvFolds);
      setNestedCvRunning(false);
    }, 50);
  }, [normalizedMatrix, h1LabelMap]);

  // ============ 嵌套5折交叉验证 + Logistic Regression (L2) ============
  // 内层训练LR模型，外层评估（无数据泄漏）
  type NestedCVLRResult = {
    fold: number;
    trainSize: number;
    testSize: number;
    trainH1: number;
    testH1: number;
    trainAUC: number;
    testAUC: number;
    weights: number[]; // LR权重
    bias: number;
    testScores: number[]; // 测试集预测得分
    testLabels: number[]; // 测试集真实标签
  };

  const [nestedCvLRResults, setNestedCvLRResults] = useState<NestedCVLRResult[] | null>(null);
  const [nestedCvLRRunning, setNestedCvLRRunning] = useState(false);

  const runNestedCVWithLR = useCallback(() => {
    if (!normalizedMatrix) return;
    setNestedCvLRRunning(true);

    setTimeout(() => {
      const { pmids, matrix, s1Norm, s2Norm, s3Norm, s4Norm } = normalizedMatrix;
      const labels = pmids.map(pmid => (h1LabelMap.get(pmid) ? 1 : 0));

      // 分层抽样
      const h1Indices: number[] = [];
      const nonH1Indices: number[] = [];
      labels.forEach((l, i) => {
        if (l === 1) h1Indices.push(i);
        else nonH1Indices.push(i);
      });

      const shuffle = (arr: number[]) => {
        const a = [...arr];
        for (let i = a.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
      };

      const h1Shuffled = shuffle(h1Indices);
      const nonH1Shuffled = shuffle(nonH1Indices);

      const splitToFolds = (indices: number[]) => {
        const folds: number[][] = [[], [], [], [], []];
        indices.forEach((idx, i) => {
          folds[i % 5].push(idx);
        });
        return folds;
      };

      const h1Folds = splitToFolds(h1Shuffled);
      const nonH1Folds = splitToFolds(nonH1Shuffled);

      const cvFolds: NestedCVLRResult[] = [];

      for (let fold = 0; fold < 5; fold++) {
        const testIndices = [...h1Folds[fold], ...nonH1Folds[fold]];
        const trainIndices: number[] = [];
        for (let f = 0; f < 5; f++) {
          if (f !== fold) {
            trainIndices.push(...h1Folds[f], ...nonH1Folds[f]);
          }
        }

        // 训练集特征和标签
        const trainX = trainIndices.map(i => [s1Norm[i], s2Norm[i], s3Norm[i], s4Norm[i]]);
        const trainY = trainIndices.map(i => labels[i]);

        // 测试集特征和标签
        const testX = testIndices.map(i => [s1Norm[i], s2Norm[i], s3Norm[i], s4Norm[i]]);
        const testY = testIndices.map(i => labels[i]);

        // 训练LR模型
        const model = trainLogisticRegression(trainX, trainY, { lr: 0.1, epochs: 1000, lambda: 0.01 });

        // 预测
        const trainProbs = predictLogisticRegression(trainX, model);
        const testProbs = predictLogisticRegression(testX, model);

        // 计算AUC
        const trainAUC = computeAUC(trainProbs, trainY);
        const testAUC = computeAUC(testProbs, testY);

        cvFolds.push({
          fold: fold + 1,
          trainSize: trainIndices.length,
          testSize: testIndices.length,
          trainH1: trainIndices.filter(i => labels[i] === 1).length,
          testH1: testIndices.filter(i => labels[i] === 1).length,
          trainAUC,
          testAUC,
          weights: model.weights,
          bias: model.bias,
          testScores: testProbs,
          testLabels: testY,
        });
      }

      setNestedCvLRResults(cvFolds);
      setNestedCvLRRunning(false);
    }, 50);
  }, [normalizedMatrix, h1LabelMap]);

  // ============ 嵌套5折交叉验证 + Logistic Regression (L2) + 交互特征 ============
  // 在4维信号基础上添加 S1×S4 和 S3×S4 交互特征，共6维
  type NestedCVLRInteractionResult = {
    fold: number;
    trainSize: number;
    testSize: number;
    trainH1: number;
    testH1: number;
    trainAUC: number;
    testAUC: number;
    weights: number[]; // 6维权重 [w1,w2,w3,w4, w1x4, w3x4]
    bias: number;
    testScores: number[]; // 测试集预测得分
    testLabels: number[]; // 测试集真实标签
  };

  const [nestedCvLRInteractionResults, setNestedCvLRInteractionResults] = useState<NestedCVLRInteractionResult[] | null>(null);
  const [nestedCvLRInteractionRunning, setNestedCvLRInteractionRunning] = useState(false);

  const runNestedCVWithLRInteraction = useCallback(() => {
    if (!normalizedMatrix) return;
    setNestedCvLRInteractionRunning(true);

    setTimeout(() => {
      const { pmids, matrix, s1Norm, s2Norm, s3Norm, s4Norm } = normalizedMatrix;
      const labels = pmids.map(pmid => (h1LabelMap.get(pmid) ? 1 : 0));

      // 分层抽样
      const h1Indices: number[] = [];
      const nonH1Indices: number[] = [];
      labels.forEach((l, i) => {
        if (l === 1) h1Indices.push(i);
        else nonH1Indices.push(i);
      });

      const shuffle = (arr: number[]) => {
        const a = [...arr];
        for (let i = a.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
      };

      const h1Shuffled = shuffle(h1Indices);
      const nonH1Shuffled = shuffle(nonH1Indices);

      const splitToFolds = (indices: number[]) => {
        const folds: number[][] = [[], [], [], [], []];
        indices.forEach((idx, i) => {
          folds[i % 5].push(idx);
        });
        return folds;
      };

      const h1Folds = splitToFolds(h1Shuffled);
      const nonH1Folds = splitToFolds(nonH1Shuffled);

      const cvFolds: NestedCVLRInteractionResult[] = [];

      for (let fold = 0; fold < 5; fold++) {
        const testIndices = [...h1Folds[fold], ...nonH1Folds[fold]];
        const trainIndices: number[] = [];
        for (let f = 0; f < 5; f++) {
          if (f !== fold) {
            trainIndices.push(...h1Folds[f], ...nonH1Folds[f]);
          }
        }

        // 训练集特征（6维：4个原始 + 2个交互）
        const trainX = trainIndices.map(i => {
          const s1 = s1Norm[i], s2 = s2Norm[i], s3 = s3Norm[i], s4 = s4Norm[i];
          return [s1, s2, s3, s4, s1 * s4, s3 * s4];
        });
        const trainY = trainIndices.map(i => labels[i]);

        // 测试集特征（6维）
        const testX = testIndices.map(i => {
          const s1 = s1Norm[i], s2 = s2Norm[i], s3 = s3Norm[i], s4 = s4Norm[i];
          return [s1, s2, s3, s4, s1 * s4, s3 * s4];
        });
        const testY = testIndices.map(i => labels[i]);

        // 训练LR模型
        const model = trainLogisticRegression(trainX, trainY, { lr: 0.1, epochs: 1000, lambda: 0.01 });

        // 预测
        const trainProbs = predictLogisticRegression(trainX, model);
        const testProbs = predictLogisticRegression(testX, model);

        // 计算AUC
        const trainAUC = computeAUC(trainProbs, trainY);
        const testAUC = computeAUC(testProbs, testY);

        cvFolds.push({
          fold: fold + 1,
          trainSize: trainIndices.length,
          testSize: testIndices.length,
          trainH1: trainIndices.filter(i => labels[i] === 1).length,
          testH1: testIndices.filter(i => labels[i] === 1).length,
          trainAUC,
          testAUC,
          weights: model.weights,
          bias: model.bias,
          testScores: testProbs,
          testLabels: testY,
        });
      }

      setNestedCvLRInteractionResults(cvFolds);
      setNestedCvLRInteractionRunning(false);
    }, 50);
  }, [normalizedMatrix, h1LabelMap]);

  // ============ Top-K 发现能力 ============
  const topKData = React.useMemo(() => {
    if (fusionResults.length === 0) return [];

    const totalH1 = fusionResults.filter(r => r.isH1).length;
    const totalPapers = fusionResults.length;
    const labels = fusionResults.map(r => r.isH1 ? 1 : 0);

    // 已按融合得分降序排列
    const ks = [10, 20, 30, 50, 100, 150, 200, 300, 500, totalH1, 1000].filter(k => k <= totalPapers);
    // 去重并排序
    const uniqueKs = [...new Set(ks)].sort((a, b) => a - b);

    return uniqueKs.map(k => {
      const topK = fusionResults.slice(0, k);
      const hits = topK.filter(r => r.isH1).length;
      const topKLabels = labels.slice(0, k);
      return {
        k,
        hits,
        precision: hits / k,
        recall: hits / totalH1,
        ndcg: ndcgAtK(labels, k),
        enrichment: enrichmentAtK(labels, k),
      };
    });
  }, [fusionResults]);

  // ============ LR+交互特征 Top-K 发现能力 ============
  const lrInteractionTopKData = React.useMemo(() => {
    if (!nestedCvLRInteractionResults || nestedCvLRInteractionResults.length === 0) return [];

    // 聚合所有测试集的预测结果
    const allTestPredictions: { score: number; isH1: boolean }[] = [];
    nestedCvLRInteractionResults.forEach(fold => {
      fold.testScores.forEach((score, idx) => {
        allTestPredictions.push({ score, isH1: fold.testLabels[idx] === 1 });
      });
    });

    // 按得分降序排列
    allTestPredictions.sort((a, b) => b.score - a.score);

    const totalH1 = allTestPredictions.filter(p => p.isH1).length;
    const totalPapers = allTestPredictions.length;
    const labels = allTestPredictions.map(p => p.isH1 ? 1 : 0);

    const ks = [10, 20, 30, 50, 100, 150, 200, 300, 500, totalH1, 1000].filter(k => k <= totalPapers);
    const uniqueKs = [...new Set(ks)].sort((a, b) => a - b);

    return uniqueKs.map(k => {
      const topK = allTestPredictions.slice(0, k);
      const hits = topK.filter(p => p.isH1).length;
      return {
        k,
        hits,
        precision: hits / k,
        recall: hits / totalH1,
        ndcg: ndcgAtK(labels, k),
        enrichment: enrichmentAtK(labels, k),
      };
    });
  }, [nestedCvLRInteractionResults]);

  // ============ 存档功能 ============
  const archiveFileRef = useRef<HTMLInputElement>(null);

  const exportArchive = () => {
    const archive = {
      version: 1,
      exportTime: new Date().toISOString(),
      papers,
      signal1Results,
      signal2Results,
      signal3Results,
      signal4Results,
      signal1Metrics,
      signal2Metrics,
      signal3Metrics,
      signal4Metrics,
    };
    const blob = new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `litmus-archive-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importArchive = async (file: File) => {
    try {
      const text = await file.text();
      const archive = JSON.parse(text);
      if (!archive.papers || !Array.isArray(archive.papers)) {
        alert('无效的存档文件：缺少papers字段');
        return;
      }
      setPapers(archive.papers);
      setDataLoaded(true);
      setDataSource({ paperFile: '从存档导入', h1File: '从存档导入' });
      if (archive.signal1Results) { setSignal1Results(archive.signal1Results); setSignal1Status('done'); }
      if (archive.signal2Results) { setSignal2Results(archive.signal2Results); setSignal2Status('done'); }
      if (archive.signal3Results) { setSignal3Results(archive.signal3Results); setSignal3Status('done'); }
      if (archive.signal4Results) { setSignal4Results(archive.signal4Results); setSignal4Status('done'); }
      if (archive.signal1Metrics) setSignal1Metrics(archive.signal1Metrics);
      if (archive.signal2Metrics) setSignal2Metrics(archive.signal2Metrics);
      if (archive.signal3Metrics) setSignal3Metrics(archive.signal3Metrics);
      if (archive.signal4Metrics) setSignal4Metrics(archive.signal4Metrics);
      alert('存档导入成功！');
    } catch (err) {
      alert(`存档导入失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // ============ 渲染辅助 ============
  const h1Count = papers.filter(p => p.isH1).length;
  const nonH1Count = papers.length - h1Count;

  const StatusBadge = ({ status }: { status: SignalStatus }) => {
    const config: Record<SignalStatus, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
      idle: { label: '待运行', variant: 'secondary' },
      running: { label: '运行中', variant: 'default' },
      done: { label: '已完成', variant: 'outline' },
      error: { label: '出错', variant: 'destructive' },
    };
    const c = config[status];
    return <Badge variant={c.variant}>{c.label}</Badge>;
  };

  const MetricsCard = ({ metrics, title }: { metrics: Metrics | null; title: string }) => {
    if (!metrics) return <div className="text-sm text-muted-foreground">运行后显示指标</div>;
    return (
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="text-center p-2 bg-muted/50 rounded">
          <div className="text-xs text-muted-foreground">AUC</div>
          <div className="text-lg font-bold">{metrics.auc.toFixed(3)}</div>
        </div>
        <div className="text-center p-2 bg-muted/50 rounded">
          <div className="text-xs text-muted-foreground">Precision@{h1Count}</div>
          <div className="text-lg font-bold">{(metrics.precisionAtK * 100).toFixed(1)}%</div>
        </div>
        <div className="text-center p-2 bg-muted/50 rounded">
          <div className="text-xs text-muted-foreground">H1均分</div>
          <div className="text-lg font-bold">{metrics.h1MeanScore.toFixed(3)}</div>
        </div>
        <div className="text-center p-2 bg-muted/50 rounded">
          <div className="text-xs text-muted-foreground">非H1均分</div>
          <div className="text-lg font-bold">{metrics.nonH1MeanScore.toFixed(3)}</div>
        </div>
        <div className="text-center p-2 bg-muted/50 rounded">
          <div className="text-xs text-muted-foreground">Cohen&apos;s d</div>
          <div className="text-lg font-bold">{metrics.cohensD.toFixed(3)}</div>
        </div>
      </div>
    );
  };

  // ============ 渲染 ============
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="container mx-auto px-4 py-4">
          <h1 className="text-2xl font-bold tracking-tight">LITMUS 实验平台</h1>
          <p className="text-sm text-muted-foreground">
            LLM-driven Innovation Typology and Multidimensional Unconventionality Scoring
          </p>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6">
        <Tabs defaultValue="data" className="space-y-6">
          <TabsList className="grid w-full grid-cols-6">
            <TabsTrigger value="data">数据上传</TabsTrigger>
            <TabsTrigger value="signal1">信号1: 影响力判断</TabsTrigger>
            <TabsTrigger value="signal2">信号2: MeSH广度</TabsTrigger>
            <TabsTrigger value="signal3">信号3: 知识网络桥梁性</TabsTrigger>
            <TabsTrigger value="signal4">信号4: 认知偏离度</TabsTrigger>
            <TabsTrigger value="fusion">信号融合</TabsTrigger>
            <TabsTrigger value="agents">多智能体</TabsTrigger>
          </TabsList>

          {/* ===== 数据上传 ===== */}
          <TabsContent value="data">
            {/* 断点恢复提示：检测到 IndexedDB 中有未完成会话时显示 */}
            {resumeInfo && (
              <div className="mb-4 flex items-center justify-between gap-4 rounded-md border border-blue-300 bg-blue-50 px-4 py-3">
                <div className="text-sm text-blue-900">
                  <span className="font-medium">检测到未完成的会话：</span>
                  论文 {resumeInfo.paperCount} 篇
                  {resumeInfo.s1Done > 0 && `，信号1已完成 ${resumeInfo.s1Done} 篇${resumeInfo.s1Status === 'done' ? '（全部完成）' : '（可断点续跑）'}`}
                  {resumeInfo.s2Done && '，信号2✓'}
                  {resumeInfo.s3Done && '，信号3✓'}
                  {resumeInfo.s4Done && '，信号4✓'}
                  <span className="ml-2 text-blue-700/70">
                    更新于 {new Date(resumeInfo.updatedAt).toLocaleString()}
                  </span>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button size="sm" onClick={handleResumeSession} disabled={resuming}>
                    {resuming ? '恢复中…' : '恢复会话'}
                  </Button>
                  <Button size="sm" variant="outline" onClick={handleDiscardSession} disabled={resuming}>
                    放弃
                  </Button>
                </div>
              </div>
            )}
            <div className="grid md:grid-cols-2 gap-6">
              <Card>
                <CardHeader>
                  <CardTitle>论文数据集</CardTitle>
                  <CardDescription>上传包含 PMID、Title、Abstract、MeSH 等字段的 Excel 文件</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <Input
                    ref={paperFileRef}
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    onChange={handlePaperFileUpload}
                  />
                  {parsing === 'paper' && (
                    <p className="text-sm text-blue-600 animate-pulse">解析中，大文件需数秒，请稍候…</p>
                  )}
                  {dataSource.paperFile && parsing !== 'paper' && (
                    <p className="text-sm text-muted-foreground">已加载: {dataSource.paperFile} ({papers.length} 篇)</p>
                  )}
                  <div className="text-sm">
                    <p className="font-medium mb-1">兼容列名:</p>
                    <p className="text-muted-foreground">PMID, Title, Abstract, Time/Year(年份), MeSH词/MeSH Terms, 论文类型/Paper Type</p>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>H1标签数据</CardTitle>
                  <CardDescription>上传包含 PMID、Classification、Rating 等字段的 F1000Prime 评价文件</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <Input
                    ref={h1FileRef}
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    onChange={handleH1FileUpload}
                  />
                  {parsing === 'h1' && (
                    <p className="text-sm text-blue-600 animate-pulse">解析中，请稍候…</p>
                  )}
                  {dataSource.h1File && parsing !== 'h1' && (
                    <p className="text-sm text-muted-foreground">已加载: {dataSource.h1File} (H1: {papers.filter(p => p.isH1).length} 篇)</p>
                  )}
                  <div className="text-sm">
                    <p className="font-medium mb-1">兼容列名:</p>
                    <p className="text-muted-foreground">PMID, Classifications/Classification, Evaluation Rating/Rating（在文件中即视为H1，分类与评级可为空）</p>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Citation数据</CardTitle>
                  <CardDescription>上传包含 PMID 和 CitationCount 的被引次数文件（用于未来影响力验证）</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <Input
                    ref={citationFileRef}
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    onChange={handleCitationFileUpload}
                  />
                  {parsing === 'citation' && (
                    <p className="text-sm text-blue-600 animate-pulse">解析中，请稍候…</p>
                  )}
                  {citationFile && parsing !== 'citation' && (
                    <p className="text-sm text-muted-foreground">已加载: {citationFile} ({citationData.size} 篇)</p>
                  )}
                  <div className="text-sm">
                    <p className="font-medium mb-1">期望列名:</p>
                    <p className="text-muted-foreground">PMID, CitationCount (或 Citations, 被引次数)</p>
                  </div>
                </CardContent>
              </Card>
            </div>

            {dataLoaded && (
              <Card className="mt-6">
                <CardHeader>
                  <CardTitle>数据概览</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                    <div className="text-center p-3 bg-muted/50 rounded">
                      <div className="text-2xl font-bold">{papers.length}</div>
                      <div className="text-sm text-muted-foreground">总论文数</div>
                    </div>
                    <div className="text-center p-3 bg-red-50 rounded">
                      <div className="text-2xl font-bold text-red-600">{h1Count}</div>
                      <div className="text-sm text-muted-foreground">H1论文</div>
                    </div>
                    <div className="text-center p-3 bg-blue-50 rounded">
                      <div className="text-2xl font-bold text-blue-600">{nonH1Count}</div>
                      <div className="text-sm text-muted-foreground">非H1论文</div>
                    </div>
                    <div className="text-center p-3 bg-muted/50 rounded">
                      <div className="text-2xl font-bold">{h1Count > 0 ? ((h1Count / papers.length) * 100).toFixed(1) : 0}%</div>
                      <div className="text-sm text-muted-foreground">H1比例</div>
                    </div>
                  </div>

                  <Accordion type="single" collapsible>
                    <AccordionItem value="preview">
                      <AccordionTrigger>数据预览 (前10篇)</AccordionTrigger>
                      <AccordionContent>
                        <ScrollArea className="h-[400px]">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead className="w-20">PMID</TableHead>
                                <TableHead className="w-60">标题</TableHead>
                                <TableHead className="w-20">H1</TableHead>
                                <TableHead className="w-32">MeSH词数</TableHead>
                                <TableHead className="w-32">分类</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {papers.slice(0, 10).map(p => (
                                <TableRow key={p.pmid}>
                                  <TableCell className="font-mono text-xs">{p.pmid}</TableCell>
                                  <TableCell className="text-xs truncate max-w-[240px]">{p.title}</TableCell>
                                  <TableCell>{p.isH1 ? <Badge variant="destructive">H1</Badge> : <Badge variant="secondary">-</Badge>}</TableCell>
                                  <TableCell>{p.meshTerms.length}</TableCell>
                                  <TableCell className="text-xs">{p.h1Classification.join(', ') || '-'}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </ScrollArea>
                      </AccordionContent>
                    </AccordionItem>
                  </Accordion>
                </CardContent>
              </Card>
            )}

            {/* 存档管理 */}
            <Card className="mt-6">
              <CardHeader>
                <CardTitle>存档管理</CardTitle>
                <CardDescription>导出当前数据和信号结果，或从存档文件恢复（无需重新运行信号）</CardDescription>
              </CardHeader>
              <CardContent className="flex gap-3">
                <Button onClick={exportArchive} disabled={!dataLoaded} variant="outline">
                  导出存档
                </Button>
                <Button onClick={() => archiveFileRef.current?.click()} variant="outline">
                  导入存档
                </Button>
                <input
                  ref={archiveFileRef}
                  type="file"
                  accept=".json"
                  className="hidden"
                  onChange={e => {
                    const file = e.target.files?.[0];
                    if (file) importArchive(file);
                    e.target.value = '';
                  }}
                />
                {dataLoaded && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <span>已加载: {papers.length} 篇论文</span>
                    {signal1Results.length > 0 && <span>· 信号1: {signal1Results.length}条</span>}
                    {signal2Results.length > 0 && <span>· 信号2: {signal2Results.length}条</span>}
                    {signal3Results.length > 0 && <span>· 信号3: {signal3Results.length}条</span>}
                    {signal4Results.length > 0 && <span>· 信号4: {signal4Results.length}条</span>}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ===== 信号1: LLM影响力与重要性判断 ===== */}
          <TabsContent value="signal1">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle>信号1: LLM影响力与重要性判断</CardTitle>
                    <CardDescription>利用大语言模型评估论文的科学影响力和重要性，对齐F1000Prime评价标准</CardDescription>
                  </div>
                  <StatusBadge status={signal1Status} />
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* 配置区 */}
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <Label>LLM模型</Label>
                    <Select value={llmModel} onValueChange={setLlmModel}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="doubao-seed-2-0-pro-260215">Doubao Seed Pro (旗舰)</SelectItem>
                        <SelectItem value="doubao-seed-2-0-lite-260215">Doubao Seed Lite (均衡)</SelectItem>
                        <SelectItem value="doubao-seed-2-0-mini-260215">Doubao Seed Mini (轻量)</SelectItem>
                        <SelectItem value="deepseek-v3-2-251201">DeepSeek V3</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Temperature</Label>
                    <Input type="number" step="0.1" min="0" max="2" value={llmTemperature} onChange={e => setLlmTemperature(e.target.value)} />
                  </div>
                  <div>
                    <Label>批次大小</Label>
                    <Input type="number" min="1" max="50" value={batchSize} onChange={e => setBatchSize(e.target.value)} />
                  </div>
                </div>

                <Button onClick={runSignal1} disabled={signal1Status === 'running' || !dataLoaded} className="w-full">
                  {signal1Status === 'running'
                    ? '运行中...'
                    : signal1Results.length > 0 && signal1Results.length < papers.length && signal1Status !== 'done'
                      ? `继续运行（剩余 ${papers.length - signal1Results.length} 篇，断点续跑）`
                      : signal1Status === 'done'
                        ? '重新运行信号1'
                        : '开始运行信号1'}
                </Button>
                {signal1Status !== 'running' && signal1Results.length > 0 && signal1Results.length < papers.length && signal1Status !== 'done' && (
                  <p className="text-xs text-muted-foreground">
                    已缓存 {signal1Results.length}/{papers.length} 篇，点击按钮将跳过已完成部分继续运行；中途断连/刷新不丢失进度。
                  </p>
                )}

                {signal1Status === 'running' && (
                  <div>
                    <div className="flex justify-between text-sm mb-1">
                      <span>进度</span>
                      <span>{signal1Progress}% ({signal1Results.length}/{papers.length})</span>
                    </div>
                    <Progress value={signal1Progress} />
                  </div>
                )}

                {signal1Results.length > 0 && (
                  <>
                    <div>
                      <h3 className="font-medium mb-2">区分能力指标</h3>
                      <MetricsCard metrics={signal1Metrics} title="信号1" />
                    </div>

                    {/* 影响力等级分布饼图 */}
                    <div className="grid md:grid-cols-2 gap-4">
                      <div>
                        <h4 className="text-sm font-medium mb-2">影响力等级分布</h4>
                        <ResponsiveContainer width="100%" height={250}>
                          <PieChart>
                            <Pie
                              data={(() => {
                                const counts: Record<string, number> = {};
                                signal1Results.forEach(r => {
                                  counts[r.primaryType] = (counts[r.primaryType] || 0) + 1;
                                });
                                return Object.entries(counts).map(([name, value]) => ({ name, value }));
                              })()}
                              dataKey="value"
                              nameKey="name"
                              cx="50%"
                              cy="50%"
                              outerRadius={80}
                              label={({ name, percent }: { name: string; percent: number }) => `${name}: ${(percent * 100).toFixed(0)}%`}
                            >
                              {(() => {
                                const counts: Record<string, number> = {};
                                signal1Results.forEach(r => { counts[r.primaryType] = (counts[r.primaryType] || 0) + 1; });
                                return Object.entries(counts).map(([name]) => (
                                  <Cell key={name} fill={TYPE_COLORS[name] || '#6b7280'} />
                                ));
                              })()}
                            </Pie>
                            <Tooltip />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>

                      {/* H1 vs 非H1 得分分布散点图 */}
                      <div>
                        <h4 className="text-sm font-medium mb-2">H1 vs 非H1 得分分布</h4>
                        <ResponsiveContainer width="100%" height={250}>
                          <ScatterChart>
                            <CartesianGrid />
                            <XAxis dataKey="x" name="PMID序号" type="number" />
                            <YAxis dataKey="y" name="得分" type="number" domain={[0, 1]} />
                            <ZAxis range={[30]} />
                            <Tooltip cursor={{ strokeDasharray: '3 3' }} />
                            <Scatter
                              name="非H1"
                              data={signal1Scatter.nonH1}
                              fill={NON_H1_COLOR}
                            />
                            <Scatter
                              name="H1"
                              data={signal1Scatter.h1}
                              fill={H1_COLOR}
                            />
                            <Legend />
                          </ScatterChart>
                        </ResponsiveContainer>
                      </div>
                    </div>

                    {/* 结果表格 */}
                    <Accordion type="single" collapsible>
                      <AccordionItem value="table">
                        <AccordionTrigger>详细结果 (按得分排序)</AccordionTrigger>
                        <AccordionContent>
                          <ScrollArea className="h-[400px]">
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>PMID</TableHead>
                                  <TableHead>影响力等级</TableHead>
                                  <TableHead>颠覆性发现</TableHead>
                                  <TableHead>技术进步</TableHead>
                                  <TableHead>范式挑战</TableHead>
                                  <TableHead>临床影响</TableHead>
                                  <TableHead>广泛重要性</TableHead>
                                  <TableHead>得分</TableHead>
                                  <TableHead>H1</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {[...signal1Results]
                                  .sort((a, b) => b.score - a.score)
                                  .slice(0, 50)
                                  .map(r => {
                                    const paper = papers.find(p => p.pmid === r.pmid);
                                    return (
                                      <TableRow key={r.pmid}>
                                        <TableCell className="font-mono text-xs">{r.pmid}</TableCell>
                                        <TableCell>
                                          <Badge style={{ backgroundColor: TYPE_COLORS[r.primaryType] || '#6b7280', color: '#fff' }}>
                                            {r.primaryType}
                                          </Badge>
                                        </TableCell>
                                        <TableCell>{(r.innovationTypes.newFinding * 100).toFixed(0)}%</TableCell>
                                        <TableCell>{(r.innovationTypes.technicalAdvance * 100).toFixed(0)}%</TableCell>
                                        <TableCell>{(r.innovationTypes.interestingHypothesis * 100).toFixed(0)}%</TableCell>
                                        <TableCell>{(r.innovationTypes.novelDrugTarget * 100).toFixed(0)}%</TableCell>
                                        <TableCell>{(r.innovationTypes.confirmation * 100).toFixed(0)}%</TableCell>
                                        <TableCell className="font-bold">{r.score.toFixed(3)}</TableCell>
                                        <TableCell>{paper?.isH1 ? <Badge variant="destructive">H1</Badge> : '-'}</TableCell>
                                      </TableRow>
                                    );
                                  })}
                              </TableBody>
                            </Table>
                          </ScrollArea>
                        </AccordionContent>
                      </AccordionItem>
                    </Accordion>
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ===== 信号2: MeSH广度与跨域性 ===== */}
          <TabsContent value="signal2">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle>信号2: MeSH主题广度与跨域性</CardTitle>
                    <CardDescription>基于MeSH Tree Number（来自 MeSH Browser API）将 MeSH 词映射到 8 大领域，衡量主题广度与跨域性</CardDescription>
                  </div>
                  {signal2TreeStats && (
                    <div className="text-xs text-muted-foreground text-right">
                      <div>MeSH Tree Number 覆盖率: <span className={signal2TreeStats.coverage > 0.7 ? 'text-green-600 font-medium' : signal2TreeStats.coverage > 0.3 ? 'text-yellow-600 font-medium' : 'text-red-600 font-medium'}>{(signal2TreeStats.coverage * 100).toFixed(0)}%</span></div>
                      <div>数据源: {signal2TreeStats.source === 'mesh-api' ? '✅ MeSH Browser API' : '⚠️ 关键词启发式 (fallback)'}</div>
                      <div>{signal2TreeStats.termsFoundInMesh} / {signal2TreeStats.totalUniqueTerms} 唯一 MeSH 词</div>
                    </div>
                  )}
                  <StatusBadge status={signal2Status} />
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="text-sm text-muted-foreground">
                  此信号为纯计算，无需LLM调用，可即时完成。
                </div>

                <Button onClick={runSignal2} disabled={signal2Status === 'running' || !dataLoaded} className="w-full">
                  {signal2Status === 'running' ? '计算中...' : '开始运行信号2'}
                </Button>

                {signal2Results.length > 0 && (
                  <>
                    <div>
                      <h3 className="font-medium mb-2">区分能力指标</h3>
                      <MetricsCard metrics={signal2Metrics} title="信号2" />
                    </div>

                    <div className="grid md:grid-cols-2 gap-4">
                      {/* H1 vs 非H1 MeSH数对比 */}
                      <div>
                        <h4 className="text-sm font-medium mb-2">H1 vs 非H1 MeSH词数分布</h4>
                        <ResponsiveContainer width="100%" height={250}>
                          <BarChart data={(() => {
                            const bins = ['0-2', '3-4', '5-6', '7-8', '9-10', '11+'];
                            const h1Bins = new Array(bins.length).fill(0);
                            const nonH1Bins = new Array(bins.length).fill(0);
                            signal2Results.forEach(r => {
                              const paper = papers.find(p => p.pmid === r.pmid);
                              const count = r.meshCount;
                              const binIdx = count <= 2 ? 0 : count <= 4 ? 1 : count <= 6 ? 2 : count <= 8 ? 3 : count <= 10 ? 4 : 5;
                              if (paper?.isH1) h1Bins[binIdx]++;
                              else nonH1Bins[binIdx]++;
                            });
                            return bins.map((name, i) => ({ name, H1: h1Bins[i], '非H1': nonH1Bins[i] }));
                          })()}>
                            <CartesianGrid strokeDasharray="3 3" />
                            <XAxis dataKey="name" />
                            <YAxis />
                            <Tooltip />
                            <Legend />
                            <Bar dataKey="H1" fill={H1_COLOR} />
                            <Bar dataKey="非H1" fill={NON_H1_COLOR} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>

                      {/* 跨域指数散点图 */}
                      <div>
                        <h4 className="text-sm font-medium mb-2">跨域指数 vs MeSH数</h4>
                        <ResponsiveContainer width="100%" height={250}>
                          <ScatterChart>
                            <CartesianGrid />
                            <XAxis dataKey="meshCount" name="MeSH词数" type="number" />
                            <YAxis dataKey="crossDomain" name="跨域指数" type="number" domain={[0, 1]} />
                            <ZAxis range={[30]} />
                            <Tooltip cursor={{ strokeDasharray: '3 3' }} />
                            <Scatter
                              name="非H1"
                              data={signal2Scatter.nonH1}
                              fill={NON_H1_COLOR}
                            />
                            <Scatter
                              name="H1"
                              data={signal2Scatter.h1}
                              fill={H1_COLOR}
                            />
                            <Legend />
                          </ScatterChart>
                        </ResponsiveContainer>
                      </div>
                    </div>

                    <Accordion type="single" collapsible>
                      <AccordionItem value="table">
                        <AccordionTrigger>详细结果 (按得分排序)</AccordionTrigger>
                        <AccordionContent>
                          <ScrollArea className="h-[400px]">
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>PMID</TableHead>
                                  <TableHead>有MeSH</TableHead>
                                  <TableHead>MeSH词数</TableHead>
                                  <TableHead>领域数</TableHead>
                                  <TableHead>跨域指数</TableHead>
                                  <TableHead>领域分布</TableHead>
                                  <TableHead>得分</TableHead>
                                  <TableHead>H1</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {[...signal2Results]
                                  .sort((a, b) => b.score - a.score)
                                  .slice(0, 50)
                                  .map(r => {
                                    const paper = papers.find(p => p.pmid === r.pmid);
                                    return (
                                      <TableRow key={r.pmid}>
                                        <TableCell className="font-mono text-xs">{r.pmid}</TableCell>
                                        <TableCell>{r.hasMeSH ? '✓' : '✗'}</TableCell>
                                        <TableCell>{r.meshCount}</TableCell>
                                        <TableCell>{r.uniqueDomains}</TableCell>
                                        <TableCell>{r.crossDomainIndex.toFixed(3)}</TableCell>
                                        <TableCell className="text-xs max-w-[200px] truncate">
                                          {Object.entries(r.domainDistribution).map(([k, v]) => `${k}:${v}`).join(', ')}
                                        </TableCell>
                                        <TableCell className="font-bold">{r.score.toFixed(3)}</TableCell>
                                        <TableCell>{paper?.isH1 ? <Badge variant="destructive">H1</Badge> : '-'}</TableCell>
                                      </TableRow>
                                    );
                                  })}
                              </TableBody>
                            </Table>
                          </ScrollArea>
                        </AccordionContent>
                      </AccordionItem>
                    </Accordion>
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ===== 信号3: 知识网络桥梁性 ===== */}
          <TabsContent value="signal3">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle>信号3: 知识网络桥梁性</CardTitle>
                    <CardDescription>TF-IDF+TextRank关键词提取 → 论文-关键词二分网络 → Betweenness Centrality识别桥梁论文</CardDescription>
                  </div>
                  <StatusBadge status={signal3Status} />
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="text-sm text-muted-foreground">
                  基于 Uzzi et al. (2013) Science 的 atypical combination 理论：高 betweenness 论文连接了通常不共现的知识领域，具有更高创新性和影响力潜力。纯计算，无需LLM调用，即时返回。
                </div>

                <Button onClick={runSignal3} disabled={signal3Status === 'running' || !dataLoaded} className="w-full">
                  {signal3Status === 'running' ? '计算中...' : '开始运行信号3'}
                </Button>

                {signal3Results.length > 0 && (
                  <>
                    <div>
                      <h3 className="font-medium mb-2">区分能力指标</h3>
                      <MetricsCard metrics={signal3Metrics} title="信号3" />
                    </div>

                    <div className="grid md:grid-cols-2 gap-4">
                      {/* Betweenness分布直方图 */}
                      <div>
                        <h4 className="text-sm font-medium mb-2">Betweenness分布 (H1 vs 非H1)</h4>
                        <ResponsiveContainer width="100%" height={250}>
                          <BarChart data={(() => {
                            const bins = Array.from({ length: 10 }, (_, i) => ({
                              range: `${(i * 0.1).toFixed(1)}-${((i + 1) * 0.1).toFixed(1)}`,
                              H1: 0, nonH1: 0,
                            }));
                            signal3Results.forEach(r => {
                              const paper = papers.find(p => p.pmid === r.pmid);
                              const binIdx = Math.min(Math.floor(r.score * 10), 9);
                              if (paper?.isH1) bins[binIdx].H1++;
                              else bins[binIdx].nonH1++;
                            });
                            return bins;
                          })()}>
                            <CartesianGrid strokeDasharray="3 3" />
                            <XAxis dataKey="range" tick={{ fontSize: 10 }} />
                            <YAxis />
                            <Tooltip />
                            <Legend />
                            <Bar dataKey="H1" fill={H1_COLOR} />
                            <Bar dataKey="nonH1" fill={NON_H1_COLOR} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>

                      {/* 关键词数量 vs 得分散点图 */}
                      <div>
                        <h4 className="text-sm font-medium mb-2">关键词数量 vs Betweenness得分</h4>
                        <ResponsiveContainer width="100%" height={250}>
                          <ScatterChart>
                            <CartesianGrid />
                            <XAxis dataKey="keywords" name="关键词数" type="number" />
                            <YAxis dataKey="score" name="Betweenness得分" type="number" domain={[0, 1]} />
                            <ZAxis range={[30]} />
                            <Tooltip cursor={{ strokeDasharray: '3 3' }} />
                            <Scatter
                              name="非H1"
                              data={signal3Scatter.nonH1}
                              fill={NON_H1_COLOR}
                            />
                            <Scatter
                              name="H1"
                              data={signal3Scatter.h1}
                              fill={H1_COLOR}
                            />
                            <Legend />
                          </ScatterChart>
                        </ResponsiveContainer>
                      </div>
                    </div>

                    <Accordion type="single" collapsible>
                      <AccordionItem value="table">
                        <AccordionTrigger>详细结果 (按得分排序)</AccordionTrigger>
                        <AccordionContent>
                          <ScrollArea className="h-[400px]">
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>PMID</TableHead>
                                  <TableHead>关键词数</TableHead>
                                  <TableHead>Betweenness</TableHead>
                                  <TableHead>标准化得分</TableHead>
                                  <TableHead>Top关键词</TableHead>
                                  <TableHead>H1</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {[...signal3Results]
                                  .sort((a, b) => b.score - a.score)
                                  .slice(0, 50)
                                  .map(r => {
                                    const paper = papers.find(p => p.pmid === r.pmid);
                                    return (
                                      <TableRow key={r.pmid}>
                                        <TableCell className="font-mono text-xs">{r.pmid}</TableCell>
                                        <TableCell>{r.keywordCount}</TableCell>
                                        <TableCell className="font-mono text-xs">{r.betweenness.toExponential(3)}</TableCell>
                                        <TableCell className="font-bold">{r.score.toFixed(3)}</TableCell>
                                        <TableCell className="max-w-[200px] truncate text-xs">{r.topKeywords.slice(0, 5).map(k => k.keyword).join(', ')}</TableCell>
                                        <TableCell>{paper?.isH1 ? <Badge variant="destructive">H1</Badge> : '-'}</TableCell>
                                      </TableRow>
                                    );
                                  })}
                              </TableBody>
                            </Table>
                          </ScrollArea>
                        </AccordionContent>
                      </AccordionItem>
                    </Accordion>
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ===== 信号4: 认知偏离度 ===== */}
          <TabsContent value="signal4">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle>信号4: 认知偏离度（内部相对法 + 概念频率法）</CardTitle>
                    <CardDescription>
                      测量论文在语义空间中与数据集中其他论文的偏离程度，以及使用概念的罕见程度
                    </CardDescription>
                  </div>
                  <StatusBadge status={signal4Status} />
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="text-sm text-muted-foreground">
                  <strong>设计原理：</strong>借鉴罗卓然论文的语义嵌入最大距离法和马铭论文的组合原创性思想。
                  <strong>内部相对法</strong>：计算每篇论文与数据集中其他所有论文的平均语义距离，距离越大越新颖。
                  <strong>概念频率法</strong>：统计MeSH词在数据集中的出现频率，低频词占比越高越新颖。
                  两个指标加权融合得到最终认知偏离度分数。
                </div>

                <Button onClick={runSignal4} disabled={signal4Status === 'running' || !dataLoaded} className="w-full">
                  {signal4Status === 'running' ? '计算中...' : '开始运行信号4'}
                </Button>

                {signal4Status === 'running' && (
                  <div>
                    <div className="flex justify-between text-sm mb-1">
                      <span>进度</span>
                      <span>{signal4Progress}%</span>
                    </div>
                    <Progress value={signal4Progress} />
                  </div>
                )}

                {signal4Results.length > 0 && (
                  <>
                    <div>
                      <h3 className="font-medium mb-2">区分能力指标</h3>
                      <MetricsCard metrics={signal4Metrics} title="信号4" />
                    </div>

                    {/* 认知偏离度分布图 */}
                    <div>
                      <h3 className="font-medium mb-2">认知偏离度分布（H1 vs 非H1）</h3>
                      <ResponsiveContainer width="100%" height={250}>
                        <BarChart
                          data={signal4Bins}
                        >
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis dataKey="range" tick={{ fontSize: 10 }} />
                          <YAxis />
                          <Tooltip />
                          <Legend />
                          <Bar dataKey="H1" fill={H1_COLOR} name="H1" />
                          <Bar dataKey="nonH1" fill={NON_H1_COLOR} name="非H1" />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>

                    {/* 两个子指标对比 */}
                    <div className="grid md:grid-cols-2 gap-4">
                      <div>
                        <h4 className="text-sm font-medium mb-2">语义偏离度 vs 概念罕见度</h4>
                        <ResponsiveContainer width="100%" height={200}>
                          <ScatterChart>
                            <CartesianGrid strokeDasharray="3 3" />
                            <XAxis dataKey="deviation" name="语义偏离度" type="number" domain={[0, 1]} tick={{ fontSize: 10 }} />
                            <YAxis dataKey="rarity" name="概念罕见度" type="number" domain={[0, 1]} tick={{ fontSize: 10 }} />
                            <Tooltip cursor={{ strokeDasharray: '3 3' }} />
                            <Scatter
                              data={signal4Scatter.h1}
                              fill={H1_COLOR}
                            />
                            <Scatter
                              data={signal4Scatter.nonH1}
                              fill={NON_H1_COLOR}
                            />
                          </ScatterChart>
                        </ResponsiveContainer>
                        <div className="text-xs text-muted-foreground text-center mt-1">
                          <span className="inline-block w-3 h-3 rounded-full mr-1" style={{ backgroundColor: H1_COLOR }}></span>H1
                          <span className="inline-block w-3 h-3 rounded-full ml-3 mr-1" style={{ backgroundColor: NON_H1_COLOR }}></span>非H1
                        </div>
                      </div>

                      <div>
                        <h4 className="text-sm font-medium mb-2">统计摘要</h4>
                        <div className="space-y-2 text-sm">
                          <>
                            <div className="flex justify-between"><span>H1平均认知偏离度:</span><span className="font-bold" style={{ color: H1_COLOR }}>{signal4Summary.h1Avg.toFixed(3)}</span></div>
                            <div className="flex justify-between"><span>非H1平均认知偏离度:</span><span className="font-bold" style={{ color: NON_H1_COLOR }}>{signal4Summary.nonH1Avg.toFixed(3)}</span></div>
                            <div className="flex justify-between border-t pt-2"><span>H1平均语义偏离度:</span><span>{signal4Summary.h1DevAvg.toFixed(3)}</span></div>
                            <div className="flex justify-between"><span>非H1平均语义偏离度:</span><span>{signal4Summary.nonH1DevAvg.toFixed(3)}</span></div>
                            <div className="flex justify-between border-t pt-2"><span>H1平均概念罕见度:</span><span>{signal4Summary.h1RarAvg.toFixed(3)}</span></div>
                            <div className="flex justify-between"><span>非H1平均概念罕见度:</span><span>{signal4Summary.nonH1RarAvg.toFixed(3)}</span></div>
                          </>
                        </div>
                      </div>
                    </div>

                    <Accordion type="single" collapsible>
                      <AccordionItem value="table">
                        <AccordionTrigger>详细结果</AccordionTrigger>
                        <AccordionContent>
                          <ScrollArea className="h-[500px]">
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>PMID</TableHead>
                                  <TableHead>认知偏离度</TableHead>
                                  <TableHead>语义偏离度</TableHead>
                                  <TableHead>概念罕见度</TableHead>
                                  <TableHead>H1</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {[...signal4Results]
                                  .sort((a, b) => b.score - a.score)
                                  .slice(0, 50)
                                  .map(r => {
                                    const paper = papers.find(p => p.pmid === r.pmid);
                                    return (
                                      <TableRow key={r.pmid}>
                                        <TableCell className="font-mono text-xs">{r.pmid}</TableCell>
                                        <TableCell className="font-bold">{r.score.toFixed(3)}</TableCell>
                                        <TableCell className="font-mono text-xs">{(r.deviationScore || 0).toFixed(3)}</TableCell>
                                        <TableCell className="font-mono text-xs">{(r.frequencyScore || 0).toFixed(3)}</TableCell>
                                        <TableCell>{h1LabelMap.get(r.pmid) ? <Badge variant="destructive">H1</Badge> : '-'}</TableCell>
                                      </TableRow>
                                    );
                                  })}
                              </TableBody>
                            </Table>
                          </ScrollArea>
                        </AccordionContent>
                      </AccordionItem>
                    </Accordion>
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ===== 信号融合 ===== */}
          <TabsContent value="fusion">
            <Card>
              <CardHeader>
                <CardTitle>信号融合与综合评估</CardTitle>
                <CardDescription>加权融合四个信号得分，计算综合创新性评估</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* 融合权重配置 */}
                <div>
                  <h3 className="font-medium mb-2">融合权重配置</h3>
                  <div className="grid grid-cols-4 gap-3">
                    <div>
                      <Label>信号1 (影响力) w1</Label>
                      <Input
                        type="number" step="0.05" min="0" max="1"
                        value={fusionWeights.w1}
                        onChange={e => setFusionWeights(prev => ({ ...prev, w1: parseFloat(e.target.value) || 0 }))}
                      />
                    </div>
                    <div>
                      <Label>信号2 (MeSH广度) w2</Label>
                      <Input
                        type="number" step="0.05" min="0" max="1"
                        value={fusionWeights.w2}
                        onChange={e => setFusionWeights(prev => ({ ...prev, w2: parseFloat(e.target.value) || 0 }))}
                      />
                    </div>
                    <div>
                      <Label>信号3 (桥梁性) w3</Label>
                      <Input
                        type="number" step="0.05" min="0" max="1"
                        value={fusionWeights.w3}
                        onChange={e => setFusionWeights(prev => ({ ...prev, w3: parseFloat(e.target.value) || 0 }))}
                      />
                    </div>
                    <div>
                      <Label>信号4 (认知偏离) w4</Label>
                      <Input
                        type="number" step="0.05" min="0" max="1"
                        value={fusionWeights.w4}
                        onChange={e => setFusionWeights(prev => ({ ...prev, w4: parseFloat(e.target.value) || 0 }))}
                      />
                    </div>
                  </div>
                </div>

                {/* 各信号完成状态 */}
                <div className="grid grid-cols-4 gap-3">
                  <div className="text-center p-2 bg-muted/50 rounded">
                    <div className="text-sm">信号1</div>
                    <StatusBadge status={signal1Results.length > 0 ? 'done' : 'idle'} />
                  </div>
                  <div className="text-center p-2 bg-muted/50 rounded">
                    <div className="text-sm">信号2</div>
                    <StatusBadge status={signal2Results.length > 0 ? 'done' : 'idle'} />
                  </div>
                  <div className="text-center p-2 bg-muted/50 rounded">
                    <div className="text-sm">信号3</div>
                    <StatusBadge status={signal3Results.length > 0 ? 'done' : 'idle'} />
                  </div>
                  <div className="text-center p-2 bg-muted/50 rounded">
                    <div className="text-sm">信号4</div>
                    <StatusBadge status={signal4Results.length > 0 ? 'done' : 'idle'} />
                  </div>
                </div>

                {fusionResults.length > 0 && (
                  <>
                    {/* ============ 无监督权重方法对比 ============ */}
                    {normalizedMatrix && methodResults.length > 0 && (
                      <div className="border rounded-lg p-4 space-y-4 bg-slate-50/50">
                        <div>
                          <h3 className="font-medium mb-1">权重确定方法对比</h3>
                          <p className="text-xs text-muted-foreground">
                            以下方法仅基于四信号数据分布确定权重，不使用H1标签（无监督融合）。可对比各方法的AUC表现。
                          </p>
                        </div>

                        {/* 方法对比表 */}
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>方法</TableHead>
                              <TableHead>w1 (S1)</TableHead>
                              <TableHead>w2 (S2)</TableHead>
                              <TableHead>w3 (S3)</TableHead>
                              <TableHead>w4 (S4)</TableHead>
                              <TableHead className="text-right">AUC</TableHead>
                              <TableHead className="text-right">操作</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {methodResults.map(m => (
                              <TableRow key={m.method} className={
                                m.method === 'manual' ? 'bg-purple-50/50' :
                                m.auc === Math.max(...methodResults.map(r => r.auc)) ? 'bg-green-50/50' : ''
                              }>
                                <TableCell className="font-medium">
                                  {m.label}
                                  {m.method === 'manual' && <Badge variant="outline" className="ml-2 text-[10px]">当前</Badge>}
                                  {m.auc === Math.max(...methodResults.map(r => r.auc)) && <Badge className="ml-2 text-[10px] bg-green-600">最优</Badge>}
                                </TableCell>
                                <TableCell className="font-mono">{m.weights.w1.toFixed(3)}</TableCell>
                                <TableCell className="font-mono">{m.weights.w2.toFixed(3)}</TableCell>
                                <TableCell className="font-mono">{m.weights.w3.toFixed(3)}</TableCell>
                                <TableCell className="font-mono">{m.weights.w4.toFixed(3)}</TableCell>
                                <TableCell className="text-right font-bold font-mono">{m.auc.toFixed(4)}</TableCell>
                                <TableCell className="text-right">
                                  {m.method !== 'manual' && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="text-xs h-7"
                                      onClick={() => applyUnsupervisedWeights(m.method)}
                                    >
                                      应用此权重
                                    </Button>
                                  )}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>

                        {/* Bootstrap 稳定性分析 */}
                        <div className="border-t pt-4">
                          <div className="flex items-center justify-between mb-2">
                            <div>
                              <h4 className="text-sm font-medium">Bootstrap 稳定性分析</h4>
                              <p className="text-xs text-muted-foreground">
                                500次有放回重采样，验证权重是否样本特异。CI越窄越稳定。
                              </p>
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={runBootstrap}
                              disabled={bootstrapRunning}
                            >
                              {bootstrapRunning ? '计算中...' : '运行 Bootstrap (B=500)'}
                            </Button>
                          </div>

                          {bootstrapResults && (
                            <div className="space-y-3">
                              {(['entropy', 'critic', 'pca'] as const).map(method => {
                                const stats = bootstrapResults[method];
                                if (!stats) return null;
                                const labels = ['w1 (影响力)', 'w2 (广度)', 'w3 (桥梁性)', 'w4 (偏离度)'];
                                const methodName = method === 'entropy' ? '熵权法' : method === 'critic' ? 'CRITIC法' : 'PCA法';
                                return (
                                  <div key={method} className="border rounded p-3">
                                    <div className="text-sm font-medium mb-2">{methodName} - 权重稳定性</div>
                                    <div className="grid grid-cols-4 gap-2">
                                      {stats.map((s, i) => (
                                        <div key={i} className="text-xs">
                                          <div className="text-muted-foreground">{labels[i]}</div>
                                          <div className="font-mono font-medium">{s.mean.toFixed(3)}</div>
                                          <div className="text-muted-foreground font-mono">
                                            [{s.ciLow.toFixed(3)}, {s.ciHigh.toFixed(3)}]
                                          </div>
                                          <div className="text-muted-foreground font-mono">
                                            SD={s.std.toFixed(4)}
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>

                        {/* 嵌套5折交叉验证 */}
                        <div className="border-t pt-4">
                          <div className="flex items-center justify-between mb-2">
                            <div>
                              <h4 className="text-sm font-medium">嵌套5折交叉验证（无数据泄漏）</h4>
                              <p className="text-xs text-muted-foreground">
                                外层5折评估性能；内层在训练集(80%)上网格搜索最优权重 → 在测试集(20%)上评估。每篇论文恰好被测试一次。
                              </p>
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={runNestedCrossValidation}
                              disabled={nestedCvRunning}
                            >
                              {nestedCvRunning ? '计算中...' : '运行嵌套5折CV'}
                            </Button>
                          </div>

                          {nestedCvResults && (
                            <div className="space-y-3">
                              {/* 汇总统计 */}
                              <div className="grid grid-cols-5 gap-2">
                                {(['nested_optimal', 'equal', 'entropy', 'critic', 'pca'] as const).map(method => {
                                  const aucs = nestedCvResults.map(f => f.methods[method]?.auc ?? 0);
                                  const mean = aucs.reduce((a, b) => a + b, 0) / aucs.length;
                                  const variance = aucs.reduce((a, v) => a + (v - mean) ** 2, 0) / (aucs.length - 1 || 1);
                                  const std = Math.sqrt(variance);
                                  const methodName = method === 'nested_optimal' ? '内层搜索最优' : method === 'equal' ? '等权重' : method === 'entropy' ? '熵权法' : method === 'critic' ? 'CRITIC法' : 'PCA法';
                                  return (
                                    <div key={method} className={`border rounded p-2 text-center ${method === 'nested_optimal' ? 'border-purple-300 bg-purple-50/50' : ''}`}>
                                      <div className="text-xs text-muted-foreground">{methodName}</div>
                                      <div className="text-lg font-bold font-mono">{mean.toFixed(3)}</div>
                                      <div className="text-xs text-muted-foreground font-mono">±{std.toFixed(3)}</div>
                                      <div className="text-[10px] text-muted-foreground">
                                        [{Math.min(...aucs).toFixed(3)}, {Math.max(...aucs).toFixed(3)}]
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>

                              {/* 每折详情表 */}
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>折</TableHead>
                                    <TableHead>训练/测试</TableHead>
                                    <TableHead>H1(训/测)</TableHead>
                                    <TableHead>内层最优权重</TableHead>
                                    <TableHead>训练AUC</TableHead>
                                    <TableHead className="text-right">最优测试AUC</TableHead>
                                    <TableHead className="text-right">等权重</TableHead>
                                    <TableHead className="text-right">熵权法</TableHead>
                                    <TableHead className="text-right">CRITIC</TableHead>
                                    <TableHead className="text-right">PCA</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {nestedCvResults.map(fold => (
                                    <TableRow key={fold.fold}>
                                      <TableCell className="font-medium">Fold {fold.fold}</TableCell>
                                      <TableCell className="font-mono text-xs">{fold.trainSize}/{fold.testSize}</TableCell>
                                      <TableCell className="font-mono text-xs">{fold.trainH1}/{fold.testH1}</TableCell>
                                      <TableCell className="font-mono text-[10px]">
                                        {fold.bestWeights.w1.toFixed(2)}/{fold.bestWeights.w2.toFixed(2)}/{fold.bestWeights.w3.toFixed(2)}/{fold.bestWeights.w4.toFixed(2)}
                                      </TableCell>
                                      <TableCell className="font-mono text-xs">{fold.bestTrainAUC.toFixed(3)}</TableCell>
                                      <TableCell className="text-right font-mono font-bold">{fold.methods['nested_optimal']?.auc.toFixed(3) ?? '-'}</TableCell>
                                      <TableCell className="text-right font-mono">{fold.methods['equal']?.auc.toFixed(3) ?? '-'}</TableCell>
                                      <TableCell className="text-right font-mono">{fold.methods['entropy']?.auc.toFixed(3) ?? '-'}</TableCell>
                                      <TableCell className="text-right font-mono">{fold.methods['critic']?.auc.toFixed(3) ?? '-'}</TableCell>
                                      <TableCell className="text-right font-mono">{fold.methods['pca']?.auc.toFixed(3) ?? '-'}</TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            </div>
                          )}
                        </div>

                        {/* 嵌套5折CV + Logistic Regression */}
                        <div className="border-t pt-4">
                          <div className="flex items-center justify-between mb-2">
                            <div>
                              <h4 className="text-sm font-medium">嵌套5折CV + Logistic Regression (L2)</h4>
                              <p className="text-xs text-muted-foreground">
                                内层训练LR模型（L2正则化）→ 外层测试集评估。无数据泄漏，可学习非线性权重关系。
                              </p>
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={runNestedCVWithLR}
                              disabled={nestedCvLRRunning}
                            >
                              {nestedCvLRRunning ? '训练中...' : '运行嵌套CV+LR'}
                            </Button>
                          </div>

                          {nestedCvLRResults && (
                            <div className="space-y-3">
                              {/* 汇总统计 */}
                              <div className="grid grid-cols-2 gap-2">
                                {(() => {
                                  const testAUCs = nestedCvLRResults.map(f => f.testAUC);
                                  const mean = testAUCs.reduce((a, b) => a + b, 0) / testAUCs.length;
                                  const variance = testAUCs.reduce((a, v) => a + (v - mean) ** 2, 0) / (testAUCs.length - 1 || 1);
                                  const std = Math.sqrt(variance);
                                  return (
                                    <>
                                      <div className="border rounded p-2 text-center border-purple-300 bg-purple-50/50">
                                        <div className="text-xs text-muted-foreground">LR测试AUC</div>
                                        <div className="text-lg font-bold font-mono">{mean.toFixed(3)}</div>
                                        <div className="text-xs text-muted-foreground font-mono">±{std.toFixed(3)}</div>
                                        <div className="text-[10px] text-muted-foreground">
                                          [{Math.min(...testAUCs).toFixed(3)}, {Math.max(...testAUCs).toFixed(3)}]
                                        </div>
                                      </div>
                                      <div className="border rounded p-2 text-center">
                                        <div className="text-xs text-muted-foreground">LR训练AUC</div>
                                        <div className="text-lg font-bold font-mono">
                                          {(nestedCvLRResults.reduce((a, f) => a + f.trainAUC, 0) / nestedCvLRResults.length).toFixed(3)}
                                        </div>
                                        <div className="text-xs text-muted-foreground font-mono">
                                          平均过拟合: {((nestedCvLRResults.reduce((a, f) => a + f.trainAUC, 0) / nestedCvLRResults.length) - mean).toFixed(3)}
                                        </div>
                                      </div>
                                    </>
                                  );
                                })()}
                              </div>

                              {/* 每折详情表 */}
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>折</TableHead>
                                    <TableHead>训练/测试</TableHead>
                                    <TableHead>H1(训/测)</TableHead>
                                    <TableHead>训练AUC</TableHead>
                                    <TableHead className="text-right">测试AUC</TableHead>
                                    <TableHead>LR权重 (w1/w2/w3/w4)</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {nestedCvLRResults.map(fold => (
                                    <TableRow key={fold.fold}>
                                      <TableCell className="font-medium">Fold {fold.fold}</TableCell>
                                      <TableCell className="font-mono text-xs">{fold.trainSize}/{fold.testSize}</TableCell>
                                      <TableCell className="font-mono text-xs">{fold.trainH1}/{fold.testH1}</TableCell>
                                      <TableCell className="font-mono text-xs">{fold.trainAUC.toFixed(3)}</TableCell>
                                      <TableCell className="text-right font-mono font-bold">{fold.testAUC.toFixed(3)}</TableCell>
                                      <TableCell className="font-mono text-[10px]">
                                        {fold.weights.map(w => w.toFixed(3)).join(' / ')}
                                      </TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            </div>
                          )}
                        </div>

                        {/* 嵌套5折CV + Logistic Regression + 交互特征 */}
                        <div className="border-t pt-4">
                          <div className="flex items-center justify-between mb-2">
                            <div>
                              <h4 className="text-sm font-medium">嵌套5折CV + LR + 交互特征 (S1×S4, S3×S4)</h4>
                              <p className="text-xs text-muted-foreground">
                                在4维信号基础上添加2个交互特征（共6维），捕捉信号间的非线性关系。
                              </p>
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={runNestedCVWithLRInteraction}
                              disabled={nestedCvLRInteractionRunning}
                            >
                              {nestedCvLRInteractionRunning ? '训练中...' : '运行嵌套CV+LR(交互)'}
                            </Button>
                          </div>

                          {nestedCvLRInteractionResults && (
                            <div className="space-y-3">
                              {/* 汇总统计 */}
                              <div className="grid grid-cols-2 gap-2">
                                {(() => {
                                  const testAUCs = nestedCvLRInteractionResults.map(f => f.testAUC);
                                  const mean = testAUCs.reduce((a, b) => a + b, 0) / testAUCs.length;
                                  const variance = testAUCs.reduce((a, v) => a + (v - mean) ** 2, 0) / (testAUCs.length - 1 || 1);
                                  const std = Math.sqrt(variance);
                                  return (
                                    <>
                                      <div className="border rounded p-2 text-center border-purple-300 bg-purple-50/50">
                                        <div className="text-xs text-muted-foreground">LR+交互 测试AUC</div>
                                        <div className="text-lg font-bold font-mono">{mean.toFixed(3)}</div>
                                        <div className="text-xs text-muted-foreground font-mono">±{std.toFixed(3)}</div>
                                        <div className="text-[10px] text-muted-foreground">
                                          [{Math.min(...testAUCs).toFixed(3)}, {Math.max(...testAUCs).toFixed(3)}]
                                        </div>
                                      </div>
                                      <div className="border rounded p-2 text-center">
                                        <div className="text-xs text-muted-foreground">LR训练AUC</div>
                                        <div className="text-lg font-bold font-mono">
                                          {(nestedCvLRInteractionResults.reduce((a, f) => a + f.trainAUC, 0) / nestedCvLRInteractionResults.length).toFixed(3)}
                                        </div>
                                        <div className="text-xs text-muted-foreground font-mono">
                                          平均过拟合: {((nestedCvLRInteractionResults.reduce((a, f) => a + f.trainAUC, 0) / nestedCvLRInteractionResults.length) - mean).toFixed(3)}
                                        </div>
                                      </div>
                                    </>
                                  );
                                })()}
                              </div>

                              {/* 每折详情表 */}
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>折</TableHead>
                                    <TableHead>训练/测试</TableHead>
                                    <TableHead>H1(训/测)</TableHead>
                                    <TableHead>训练AUC</TableHead>
                                    <TableHead className="text-right">测试AUC</TableHead>
                                    <TableHead>LR权重 (w1/w2/w3/w4/w1×4/w3×4)</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {nestedCvLRInteractionResults.map(fold => (
                                    <TableRow key={fold.fold}>
                                      <TableCell className="font-medium">Fold {fold.fold}</TableCell>
                                      <TableCell className="font-mono text-xs">{fold.trainSize}/{fold.testSize}</TableCell>
                                      <TableCell className="font-mono text-xs">{fold.trainH1}/{fold.testH1}</TableCell>
                                      <TableCell className="font-mono text-xs">{fold.trainAUC.toFixed(3)}</TableCell>
                                      <TableCell className="text-right font-mono font-bold">{fold.testAUC.toFixed(3)}</TableCell>
                                      <TableCell className="font-mono text-[10px]">
                                        {fold.weights.map(w => w.toFixed(3)).join(' / ')}
                                      </TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>

                              {/* LR+交互特征 Top-K 发现能力 */}
                              {lrInteractionTopKData.length > 0 && (
                                <div className="border-t pt-3">
                                  <h5 className="text-sm font-medium mb-2">LR+交互特征 Top-K 发现能力</h5>
                                  <p className="text-xs text-muted-foreground mb-2">
                                    聚合5折测试集预测结果，按LR得分从高到低排序，计算不同K值的Precision、Recall、NDCG和Enrichment。
                                  </p>
                                  <Table>
                                    <TableHeader>
                                      <TableRow>
                                        <TableHead className="text-right">K</TableHead>
                                        <TableHead className="text-right">发现数 (Hits)</TableHead>
                                        <TableHead className="text-right">Precision</TableHead>
                                        <TableHead className="text-right">Recall</TableHead>
                                        <TableHead className="text-right">NDCG</TableHead>
                                        <TableHead className="text-right">Enrichment</TableHead>
                                      </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                      {lrInteractionTopKData.map(row => (
                                        <TableRow key={row.k}>
                                          <TableCell className="text-right font-mono font-medium">{row.k}</TableCell>
                                          <TableCell className="text-right font-mono">{row.hits}</TableCell>
                                          <TableCell className="text-right font-mono">{row.precision.toFixed(3)}</TableCell>
                                          <TableCell className="text-right font-mono">{row.recall.toFixed(3)}</TableCell>
                                          <TableCell className="text-right font-mono">{row.ndcg.toFixed(3)}</TableCell>
                                          <TableCell className="text-right font-mono">{row.enrichment.toFixed(2)}x</TableCell>
                                        </TableRow>
                                      ))}
                                    </TableBody>
                                  </Table>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    <div>
                      <h3 className="font-medium mb-2">融合指标</h3>
                      <MetricsCard metrics={fusionMetrics} title="融合" />
                    </div>

                    {/* Top-K 发现能力 */}
                    {topKData.length > 0 && (
                      <div>
                        <h3 className="font-medium mb-1">Top-K 发现能力</h3>
                        <p className="text-xs text-muted-foreground mb-2">
                          按融合得分从高到低排序，取前K篇论文，计算命中H1的数量、精确率、召回率、NDCG和Enrichment。
                          总论文 {fusionResults.length} 篇，H1论文 {fusionResults.filter(r => r.isH1).length} 篇（占比 {(fusionResults.filter(r => r.isH1).length / fusionResults.length * 100).toFixed(1)}%）
                        </p>
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead className="text-right">K</TableHead>
                              <TableHead className="text-right">发现数 (Hits)</TableHead>
                              <TableHead className="text-right">Precision</TableHead>
                              <TableHead className="text-right">Recall</TableHead>
                              <TableHead className="text-right">NDCG</TableHead>
                              <TableHead className="text-right">Enrichment</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {topKData.map(row => (
                              <TableRow key={row.k}>
                                <TableCell className="text-right font-mono font-medium">{row.k}</TableCell>
                                <TableCell className="text-right font-mono">{row.hits}</TableCell>
                                <TableCell className="text-right font-mono">{row.precision.toFixed(3)}</TableCell>
                                <TableCell className="text-right font-mono">{row.recall.toFixed(3)}</TableCell>
                                <TableCell className="text-right font-mono">{row.ndcg.toFixed(3)}</TableCell>
                                <TableCell className="text-right font-mono">{row.enrichment.toFixed(2)}x</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>

                        {/* Precision@K 和 Enrichment@K 曲线 */}
                        <div className="mt-6">
                          <h4 className="text-sm font-medium mb-3">Precision@K 与 Enrichment@K 曲线</h4>
                          <div className="grid grid-cols-2 gap-4">
                            <div>
                              <p className="text-xs text-muted-foreground mb-2">Precision@K：Top-K中H1论文的比例</p>
                              <ResponsiveContainer width="100%" height={280}>
                                <LineChart data={topKData}>
                                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                                  <XAxis dataKey="k" type="number" scale="log" domain={['dataMin', 'dataMax']} label={{ value: 'K (log scale)', position: 'insideBottom', offset: -5, style: { fontSize: 11 } }} />
                                  <YAxis label={{ value: 'Precision', angle: -90, position: 'insideLeft', style: { fontSize: 11 } }} domain={[0, 1]} />
                                  <Tooltip formatter={(value: number) => value.toFixed(3)} labelFormatter={(label: number) => `K=${label}`} />
                                  <ReferenceLine y={fusionResults.filter(r => r.isH1).length / fusionResults.length} stroke="#ef4444" strokeDasharray="3 3" label={{ value: '随机基线', position: 'right', style: { fontSize: 10, fill: '#ef4444' } }} />
                                  <Line type="monotone" dataKey="precision" stroke="#3b82f6" strokeWidth={2} dot={{ r: 4 }} name="Precision" />
                                </LineChart>
                              </ResponsiveContainer>
                            </div>
                            <div>
                              <p className="text-xs text-muted-foreground mb-2">Enrichment@K：Top-K中H1密度 / 整体H1密度</p>
                              <ResponsiveContainer width="100%" height={280}>
                                <LineChart data={topKData}>
                                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                                  <XAxis dataKey="k" type="number" scale="log" domain={['dataMin', 'dataMax']} label={{ value: 'K (log scale)', position: 'insideBottom', offset: -5, style: { fontSize: 11 } }} />
                                  <YAxis label={{ value: 'Enrichment', angle: -90, position: 'insideLeft', style: { fontSize: 11 } }} domain={[0, 'auto']} />
                                  <Tooltip formatter={(value: number) => `${value.toFixed(2)}x`} labelFormatter={(label: number) => `K=${label}`} />
                                  <ReferenceLine y={1} stroke="#ef4444" strokeDasharray="3 3" label={{ value: '无富集', position: 'right', style: { fontSize: 10, fill: '#ef4444' } }} />
                                  <Line type="monotone" dataKey="enrichment" stroke="#8b5cf6" strokeWidth={2} dot={{ r: 4 }} name="Enrichment" />
                                </LineChart>
                              </ResponsiveContainer>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Citation验证 */}
                    {citationValidation && citationValidation.length > 0 && (
                      <div className="mt-6">
                        <h3 className="font-medium mb-1">未来影响力验证 (Citation Analysis)</h3>
                        <p className="text-xs text-muted-foreground mb-2">
                          按融合得分排序的Top-K论文的平均被引次数 vs 随机基线。Enrichment {'>'} 1 表示Top-K论文的被引次数高于随机水平。
                          Citation Percentile = 同年份论文中的被引百分位（消除年份偏差）。Mann-Whitney U检验：* p{'<'}0.05, ** p{'<'}0.01, *** p{'<'}0.001。
                          共 {citationValidation[0].totalCount} 篇论文有citation数据。
                        </p>
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead className="text-right">K</TableHead>
                              <TableHead className="text-right">Top-K平均被引</TableHead>
                              <TableHead className="text-right">随机基线</TableHead>
                              <TableHead className="text-right">Enrichment</TableHead>
                              <TableHead className="text-right">Top-K平均Percentile</TableHead>
                              <TableHead className="text-right">Percentile Enrichment</TableHead>
                              <TableHead className="text-right">p-value (MWU)</TableHead>
                              <TableHead className="text-right">Top-K有数据数</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {citationValidation.map(row => (
                              <TableRow key={row.k}>
                                <TableCell className="text-right font-mono font-medium">{row.k}</TableCell>
                                <TableCell className="text-right font-mono">{row.avgTopK.toFixed(2)}</TableCell>
                                <TableCell className="text-right font-mono">{row.avgRandom.toFixed(2)}</TableCell>
                                <TableCell className="text-right font-mono">
                                  <span className={row.enrichment >= 1 ? 'text-green-600' : 'text-red-600'}>
                                    {row.enrichment.toFixed(2)}x
                                  </span>
                                </TableCell>
                                <TableCell className="text-right font-mono">{row.avgPercentileTopK.toFixed(1)}</TableCell>
                                <TableCell className="text-right font-mono">
                                  <span className={row.percentileEnrichment >= 1 ? 'text-green-600' : 'text-red-600'}>
                                    {row.percentileEnrichment.toFixed(2)}x
                                  </span>
                                </TableCell>
                                <TableCell className="text-right font-mono">
                                  <span className={row.significant ? 'text-green-600 font-medium' : 'text-muted-foreground'}>
                                    {row.pValue < 0.0001 ? row.pValue.toExponential(2) : row.pValue.toFixed(4)} {row.stars}
                                  </span>
                                </TableCell>
                                <TableCell className="text-right font-mono">{row.topKCount}/{row.k}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>

                        {/* 箱线图：Top-K vs Random Citation分布 */}
                        {boxPlotData && boxPlotData.length > 0 && (
                          <div className="mt-4">
                            <div className="flex items-center justify-between mb-2">
                              <h4 className="text-sm font-medium">Top-K vs Random Citation分布（箱线图）</h4>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  const dataStr = JSON.stringify(boxPlotData, null, 2);
                                  const blob = new Blob([dataStr], { type: 'application/json' });
                                  const url = URL.createObjectURL(blob);
                                  const link = document.createElement('a');
                                  link.href = url;
                                  link.download = 'boxplot_citation_data.json';
                                  link.click();
                                  URL.revokeObjectURL(url);
                                }}
                              >
                                导出箱线图数据
                              </Button>
                            </div>
                            <p className="text-xs text-muted-foreground mb-2">
                              展示Top-K论文与随机论文的citation分布对比。箱体=Q1-Q3，横线=中位数，须线=min-max。
                            </p>
                            <div className="border rounded-lg p-4 bg-white">
                              <svg width="100%" height={300} viewBox="0 0 800 300" className="overflow-visible">
                                {/* 坐标轴 */}
                                <line x1="80" y1="250" x2="780" y2="250" stroke="#666" strokeWidth="1" />
                                <line x1="80" y1="20" x2="80" y2="250" stroke="#666" strokeWidth="1" />
                                <text x="400" y="295" textAnchor="middle" className="text-xs fill-gray-600">Citation Count</text>
                                <text x="20" y="135" textAnchor="middle" className="text-xs fill-gray-600" transform="rotate(-90, 20, 135)">K值</text>

                                {/* X轴刻度 */}
                                {(() => {
                                  const maxVal = Math.max(...boxPlotData.flatMap(d => [d.topK.max, d.random.max]));
                                  const ticks = [0, maxVal * 0.25, maxVal * 0.5, maxVal * 0.75, maxVal];
                                  return ticks.map((t, i) => (
                                    <g key={i}>
                                      <line x1={80 + (t / maxVal) * 700} y1="250" x2={80 + (t / maxVal) * 700} y2="255" stroke="#666" />
                                      <text x={80 + (t / maxVal) * 700} y="270" textAnchor="middle" className="text-xs fill-gray-600">{Math.round(t)}</text>
                                    </g>
                                  ));
                                })()}

                                {/* Y轴标签 */}
                                {boxPlotData.map((d, i) => (
                                  <text key={i} x="70" y={40 + i * 50} textAnchor="end" className="text-xs fill-gray-600">K={d.k}</text>
                                ))}

                                {/* 箱线图 */}
                                {boxPlotData.map((d, i) => {
                                  const y = 40 + i * 50;
                                  const maxVal = Math.max(...boxPlotData.flatMap(dd => [dd.topK.max, dd.random.max]));
                                  const scale = (v: number) => 80 + (v / maxVal) * 700;

                                  return (
                                    <g key={i}>
                                      {/* Top-K 箱线图 */}
                                      <line x1={scale(d.topK.min)} y1={y} x2={scale(d.topK.max)} y2={y} stroke="#3b82f6" strokeWidth="2" />
                                      <rect x={scale(d.topK.q1)} y={y - 15} width={scale(d.topK.q3) - scale(d.topK.q1)} height={30} fill="#3b82f6" opacity={0.3} stroke="#3b82f6" strokeWidth="1" />
                                      <line x1={scale(d.topK.median)} y1={y - 15} x2={scale(d.topK.median)} y2={y + 15} stroke="#3b82f6" strokeWidth="2" />

                                      {/* Random 箱线图 */}
                                      <line x1={scale(d.random.min)} y1={y + 25} x2={scale(d.random.max)} y2={y + 25} stroke="#ef4444" strokeWidth="2" />
                                      <rect x={scale(d.random.q1)} y={y + 10} width={scale(d.random.q3) - scale(d.random.q1)} height={30} fill="#ef4444" opacity={0.3} stroke="#ef4444" strokeWidth="1" />
                                      <line x1={scale(d.random.median)} y1={y + 10} x2={scale(d.random.median)} y2={y + 40} stroke="#ef4444" strokeWidth="2" />
                                    </g>
                                  );
                                })}

                                {/* 图例 */}
                                <rect x="620" y="10" width="15" height="15" fill="#3b82f6" opacity={0.3} stroke="#3b82f6" />
                                <text x="640" y="22" className="text-xs fill-gray-700">Top-K</text>
                                <rect x="700" y="10" width="15" height="15" fill="#ef4444" opacity={0.3} stroke="#ef4444" />
                                <text x="720" y="22" className="text-xs fill-gray-700">Random</text>
                              </svg>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="grid md:grid-cols-2 gap-4">
                      {/* 融合得分分布 */}
                      <div>
                        <h4 className="text-sm font-medium mb-2">融合得分分布</h4>
                        <ResponsiveContainer width="100%" height={250}>
                          <BarChart data={(() => {
                            const bins = Array.from({ length: 10 }, (_, i) => ({
                              range: `${(i * 0.1).toFixed(1)}-${((i + 1) * 0.1).toFixed(1)}`,
                              H1: 0, nonH1: 0,
                            }));
                            fusionResults.forEach(r => {
                              const binIdx = Math.min(Math.floor(r.fusedScore * 10), 9);
                              if (r.isH1) bins[binIdx].H1++;
                              else bins[binIdx].nonH1++;
                            });
                            return bins;
                          })()}>
                            <CartesianGrid strokeDasharray="3 3" />
                            <XAxis dataKey="range" tick={{ fontSize: 10 }} />
                            <YAxis />
                            <Tooltip />
                            <Legend />
                            <Bar dataKey="H1" fill={H1_COLOR} />
                            <Bar dataKey="nonH1" fill={NON_H1_COLOR} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>

                      {/* 各信号贡献雷达图用柱状图替代 */}
                      <div>
                        <h4 className="text-sm font-medium mb-2">Top-45论文各信号平均得分</h4>
                        <ResponsiveContainer width="100%" height={250}>
                          <BarChart data={(() => {
                            const top45 = fusionResults.slice(0, Math.min(45, fusionResults.length));
                            const h1InTop45 = top45.filter(r => r.isH1).length;
                            const avgS1 = top45.reduce((a, r) => a + r.signal1Score, 0) / top45.length;
                            const avgS2 = top45.reduce((a, r) => a + r.signal2Score, 0) / top45.length;
                            const avgS3 = top45.reduce((a, r) => a + r.signal3Score, 0) / top45.length;
                            const avgS4 = top45.reduce((a, r) => a + r.signal4Score, 0) / top45.length;
                            return [
                              { signal: '影响力判断', 均分: avgS1.toFixed(2) },
                              { signal: 'MeSH广度', 均分: avgS2.toFixed(2) },
                              { signal: '桥梁性', 均分: avgS3.toFixed(2) },
                              { signal: '认知偏离', 均分: avgS4.toFixed(2) },
                            ];
                          })()}>
                            <CartesianGrid strokeDasharray="3 3" />
                            <XAxis dataKey="signal" />
                            <YAxis domain={[0, 1]} />
                            <Tooltip />
                            <Bar dataKey="均分" fill="#8b5cf6" />
                          </BarChart>
                        </ResponsiveContainer>
                        <p className="text-xs text-muted-foreground mt-1">
                          Top-45中H1论文数: {fusionResults.slice(0, Math.min(45, fusionResults.length)).filter(r => r.isH1).length} / 45
                          (Precision@45 = {(fusionResults.slice(0, Math.min(45, fusionResults.length)).filter(r => r.isH1).length / 45 * 100).toFixed(1)}%)
                        </p>
                      </div>
                    </div>

                    {/* 融合结果表格 */}
                    <Accordion type="single" collapsible>
                      <AccordionItem value="table">
                        <AccordionTrigger>融合结果 (按融合得分排序)</AccordionTrigger>
                        <AccordionContent>
                          <ScrollArea className="h-[500px]">
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>排名</TableHead>
                                  <TableHead>PMID</TableHead>
                                  <TableHead>信号1</TableHead>
                                  <TableHead>信号2</TableHead>
                                  <TableHead>信号3</TableHead>
                                  <TableHead>信号4</TableHead>
                                  <TableHead>融合得分</TableHead>
                                  <TableHead>H1</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {fusionResults.slice(0, 60).map((r, i) => (
                                  <TableRow key={r.pmid} className={r.isH1 ? 'bg-red-50' : ''}>
                                    <TableCell>{i + 1}</TableCell>
                                    <TableCell className="font-mono text-xs">{r.pmid}</TableCell>
                                    <TableCell>{r.signal1Score.toFixed(3)}</TableCell>
                                    <TableCell>{r.signal2Score.toFixed(3)}</TableCell>
                                    <TableCell>{r.signal3Score.toFixed(3)}</TableCell>
                                    <TableCell>{r.signal4Score.toFixed(3)}</TableCell>
                                    <TableCell className="font-bold">{r.fusedScore.toFixed(3)}</TableCell>
                                    <TableCell>{r.isH1 ? <Badge variant="destructive">H1</Badge> : '-'}</TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </ScrollArea>
                        </AccordionContent>
                      </AccordionItem>
                    </Accordion>

                    {/* 导出功能 */}
                    <Button
                      variant="outline"
                      onClick={() => {
                        const csvHeader = 'PMID,Signal1,Signal2,Signal3,Signal4,FusedScore,IsH1\n';
                        const csvRows = fusionResults.map(r =>
                          `${r.pmid},${r.signal1Score.toFixed(4)},${r.signal2Score.toFixed(4)},${r.signal3Score.toFixed(4)},${r.signal4Score.toFixed(4)},${r.fusedScore.toFixed(4)},${r.isH1 ? 1 : 0}`
                        ).join('\n');
                        const blob = new Blob([csvHeader + csvRows], { type: 'text/csv' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = 'litmus_fusion_results.csv';
                        a.click();
                        URL.revokeObjectURL(url);
                      }}
                    >
                      导出融合结果 (CSV)
                    </Button>
                  </>
                )}

                {fusionResults.length === 0 && (
                  <div className="text-center py-8 text-muted-foreground">
                    请先运行至少一个信号实验，融合结果将在此显示
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ==================== 多智能体系统面板 ==================== */}
          <TabsContent value="agents">
            <MultiAgentPanel
              papers={papers}
              onAdoptResults={({ s1, s2, s3, s4 }) => {
                // 回灌各信号结果并标记完成，下游融合/指标/图表全部复用既有逻辑
                if (s1.length > 0) { setSignal1Results(s1); setSignal1Status('done'); }
                if (s2.length > 0) { setSignal2Results(s2); setSignal2Status('done'); }
                if (s3.length > 0) { setSignal3Results(s3); setSignal3Status('done'); }
                if (s4.length > 0) { setSignal4Results(s4); setSignal4Status('done'); }
              }}
            />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
