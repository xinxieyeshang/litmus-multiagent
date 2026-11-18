'use client';

// ============================================================
// 多智能体系统面板
// - 权重实验前锁定（启动后只读）
// - 六个智能体实时状态卡片
// - SSE 消息流（agent 间通信全过程可见）
// - 完成后拉取结果回灌现有分析面板
// ============================================================
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { Paper, Signal1Result, Signal2Result, Signal3Result, Signal4Result } from '@/lib/types';

interface AgentSnapshot {
  name: string;
  status: 'IDLE' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'RETRYING';
  done: number;
  total: number;
  detail: string;
  lastUpdate: number;
}

interface AgentMessageView {
  message_id: string;
  task_id: string;
  from: string;
  to: string;
  message_type: string;
  status: string;
  payload: unknown;
  timestamp: number;
}

interface AdoptPayload {
  s1: Signal1Result[];
  s2: Signal2Result[];
  s3: Signal3Result[];
  s4: Signal4Result[];
}

interface MultiAgentPanelProps {
  papers: Paper[];
  onAdoptResults: (payload: AdoptPayload) => void;
}

const AGENT_DISPLAY: Record<string, { label: string; desc: string }> = {
  orchestrator: { label: '协调智能体', desc: '任务分解与状态收集' },
  signal1_agent: { label: '影响力评价智能体', desc: 'LLM五维评分' },
  signal2_agent: { label: 'MeSH领域智能体', desc: '主题广度与跨域性' },
  signal3_agent: { label: '知识网络智能体', desc: '关键词桥梁性' },
  signal4_agent: { label: '认知新颖性智能体', desc: '语义偏离+概念罕见' },
  fusion_agent: { label: '融合与验证智能体', desc: '锁定权重融合' },
};

const STATUS_STYLE: Record<string, string> = {
  IDLE: 'bg-gray-100 text-gray-600',
  RUNNING: 'bg-blue-100 text-blue-700',
  RETRYING: 'bg-amber-100 text-amber-700',
  COMPLETED: 'bg-green-100 text-green-700',
  FAILED: 'bg-red-100 text-red-700',
};

const PHASE_LABEL: Record<string, string> = {
  created: '已创建',
  signals_running: '信号执行中',
  fusion_running: '融合中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

export function MultiAgentPanel({ papers, onAdoptResults }: MultiAgentPanelProps) {
  const [weights, setWeights] = useState({ signal1: 0.5, signal2: 0.3, signal3: 0.05, signal4: 0.15 });
  const [taskId, setTaskId] = useState<string | null>(null);
  const [phase, setPhase] = useState<string>('idle');
  const [agentStates, setAgentStates] = useState<AgentSnapshot[]>([]);
  const [messages, setMessages] = useState<AgentMessageView[]>([]);
  const [signalStats, setSignalStats] = useState<Record<string, unknown> | undefined>();
  const [fusionAnomalies, setFusionAnomalies] = useState<string[]>([]);
  const [adopted, setAdopted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const eventSourceRef = useRef<EventSource | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const running = phase === 'signals_running' || phase === 'fusion_running';

  const closeStreams = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => closeStreams, [closeStreams]);

  // 消息流自动滚动
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const fetchStatus = useCallback(async (tid: string) => {
    try {
      const res = await fetch(`/api/multi-agent/status?taskId=${encodeURIComponent(tid)}`);
      if (!res.ok) return;
      const data = await res.json();
      setPhase(data.phase);
      setAgentStates(data.agents ?? []);
      setSignalStats(data.signalStats);
      setFusionAnomalies(data.fusionAnomalies ?? []);
      if (data.error) setError(data.error);
      return data.phase as string;
    } catch {
      return null;
    }
  }, []);

  const adoptResults = useCallback(
    async (tid: string) => {
      try {
        const res = await fetch(`/api/multi-agent/result?taskId=${encodeURIComponent(tid)}`);
        if (!res.ok) throw new Error('结果拉取失败');
        const data = await res.json();
        const h1Map = (data.h1Map ?? {}) as Record<string, { isH1: boolean; h1Classification: string[]; h1Rating: string }>;

        // S4 结果类型含 H1 字段：回灌时从前端 h1Map 合并（agent 全程未接触）
        const s4 = ((data.signal4Results ?? []) as Array<Record<string, unknown>>).map((r) => {
          const h1 = h1Map[r.pmid as string] ?? { isH1: false, h1Classification: [], h1Rating: '' };
          return { ...r, isH1: h1.isH1, h1Classification: h1.h1Classification, h1Rating: h1.h1Rating } as Signal4Result;
        });

        onAdoptResults({
          s1: (data.signal1Results ?? []) as Signal1Result[],
          s2: (data.signal2Results ?? []) as Signal2Result[],
          s3: (data.signal3Results ?? []) as Signal3Result[],
          s4,
        });
        setAdopted(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : '结果回灌失败');
      }
    },
    [onAdoptResults],
  );

  const startTask = useCallback(async () => {
    if (papers.length === 0) {
      setError('请先在「数据上传」面板上传论文数据');
      return;
    }
    setStarting(true);
    setError(null);
    setAdopted(false);
    setMessages([]);
    setAgentStates([]);
    setFusionAnomalies([]);
    setSignalStats(undefined);

    try {
      // H1 标签从 papers 剥离为独立 h1Map 传输（TaskPaper 类型本身不含H1字段）
      const h1Map: Record<string, { isH1: boolean; h1Classification: string[]; h1Rating: string }> = {};
      const taskPapers = papers.map((p) => {
        h1Map[p.pmid] = { isH1: p.isH1, h1Classification: p.h1Classification, h1Rating: p.h1Rating };
        return {
          pmid: p.pmid,
          title: p.title,
          abstract: p.abstract,
          meshTerms: p.meshTerms,
          year: p.year,
          paperType: p.paperType,
        };
      });

      const res = await fetch('/api/multi-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ papers: taskPapers, h1Map, weights, config: { batchSize: 20 } }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? '任务启动失败');
      }
      const { taskId: tid } = (await res.json()) as { taskId: string };
      setTaskId(tid);
      setPhase('signals_running');

      // SSE 消息流
      const es = new EventSource(`/api/multi-agent/stream?taskId=${encodeURIComponent(tid)}`);
      eventSourceRef.current = es;
      es.onmessage = (ev) => {
        try {
          const parsed = JSON.parse(ev.data) as { type: string; data?: AgentMessageView };
          if (parsed.type === 'message' && parsed.data) {
            setMessages((prev) => (prev.length >= 500 ? [...prev.slice(-400), parsed.data!] : [...prev, parsed.data!]));
          }
        } catch {
          // 忽略解析失败
        }
      };

      // 状态轮询（agent 快照）
      const poll = async () => {
        const ph = await fetchStatus(tid);
        if (ph === 'completed' || ph === 'failed') {
          closeStreams();
          if (ph === 'completed') {
            setTimeout(() => void adoptResults(tid), 300);
          }
        }
      };
      pollRef.current = setInterval(() => void poll(), 2000);
      void poll();
    } catch (err) {
      setError(err instanceof Error ? err.message : '任务启动失败');
      setPhase('idle');
    } finally {
      setStarting(false);
    }
  }, [papers, weights, fetchStatus, adoptResults, closeStreams]);

  const renderPayload = (msg: AgentMessageView): string => {
    const p = msg.payload as Record<string, unknown> | null;
    if (!p) return '';
    if (typeof p.detail === 'string') return p.detail;
    if (typeof p.reason === 'string') return p.reason;
    if (Array.isArray(p.anomalies)) return (p.anomalies as string[]).join('；');
    if (typeof p.anomalyType === 'string') return `${p.anomalyType}: ${String(p.detail ?? '')}`;
    if (Array.isArray(p.results)) return `返回 ${p.results.length} 条结果`;
    if (Array.isArray(p.fusedResults)) return `融合 ${p.fusedResults.length} 条综合结果`;
    return '';
  };

  return (
    <div className="space-y-4">
      {/* 配置区 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">多智能体测度系统</CardTitle>
          <CardDescription className="text-xs">
            协调智能体分解任务 → 四个专业智能体并行执行 → 融合与验证智能体按锁定权重融合。
            融合权重在启动时锁定，运行期任何智能体不可修改；H1 标签全程与智能体隔离，仅最终结果回传。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {(['signal1', 'signal2', 'signal3', 'signal4'] as const).map((key, i) => (
              <div key={key} className="space-y-1">
                <Label className="text-xs">信号{i + 1}权重</Label>
                <Input
                  type="number"
                  step={0.05}
                  min={0}
                  max={1}
                  disabled={running}
                  value={weights[key]}
                  onChange={(e) => setWeights((w) => ({ ...w, [key]: Number(e.target.value) }))}
                  className="h-8 font-mono text-sm"
                />
              </div>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={() => void startTask()} disabled={starting || running || papers.length === 0}>
              {starting ? '启动中…' : running ? '多智能体执行中…' : '启动多智能体测度'}
            </Button>
            {taskId && (
              <span className="text-xs text-muted-foreground font-mono">
                任务 {taskId} · {PHASE_LABEL[phase] ?? phase}
              </span>
            )}
            {papers.length === 0 && (
              <span className="text-xs text-red-500">未加载论文数据</span>
            )}
          </div>
          {error && <div className="text-xs text-red-600 bg-red-50 rounded px-2 py-1">{error}</div>}
          {adopted && (
            <div className="text-xs text-green-700 bg-green-50 rounded px-2 py-1">
              结果已回灌至信号1-4与融合面板，可切换查看 AUC / Precision@K 等完整分析
            </div>
          )}
        </CardContent>
      </Card>

      {/* 智能体状态卡片 */}
      {agentStates.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
          {agentStates.map((a) => {
            const meta = AGENT_DISPLAY[a.name] ?? { label: a.name, desc: '' };
            const pct = a.total > 0 ? Math.round((a.done / a.total) * 100) : 0;
            return (
              <Card key={a.name} className="overflow-hidden">
                <CardContent className="p-3 space-y-2">
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-xs font-medium truncate">{meta.label}</span>
                    <Badge className={`text-[10px] px-1.5 py-0 ${STATUS_STYLE[a.status] ?? ''}`}>{a.status}</Badge>
                  </div>
                  <Progress value={pct} className="h-1.5" />
                  <div className="text-[10px] text-muted-foreground truncate">
                    {a.done}/{a.total} {a.detail}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* 质检报告 */}
      {signalStats && Object.keys(signalStats).length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">智能体质检报告</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            {Object.entries(signalStats).map(([key, val]) => (
              <div key={key} className="border rounded p-2">
                <div className="font-medium text-muted-foreground mb-1">{key}</div>
                <pre className="font-mono text-[11px] whitespace-pre-wrap break-all max-h-40 overflow-auto">
                  {JSON.stringify(val, null, 2)}
                </pre>
              </div>
            ))}
            {fusionAnomalies.length > 0 && (
              <div className="border border-amber-200 bg-amber-50 rounded p-2">
                <div className="font-medium text-amber-700 mb-1">融合校验异常</div>
                <ul className="list-disc pl-4 space-y-0.5 text-amber-800">
                  {fusionAnomalies.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* 消息流 */}
      {messages.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">智能体消息流（{messages.length}）</CardTitle>
            <CardDescription className="text-xs">星型拓扑：专业智能体 ↔ 协调智能体，全部消息落执行日志</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="max-h-80 overflow-auto space-y-1 font-mono text-[11px]">
              {messages.map((m) => (
                <div key={m.message_id} className="flex gap-2 items-baseline">
                  <span className="text-muted-foreground shrink-0">
                    {new Date(m.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}
                  </span>
                  <span className="shrink-0 text-purple-600">{m.from}</span>
                  <span className="shrink-0 text-muted-foreground">→</span>
                  <span className="shrink-0 text-blue-600">{m.to}</span>
                  <span
                    className={`shrink-0 ${
                      m.status === 'failed' ? 'text-red-600' : m.status === 'warning' ? 'text-amber-600' : m.status === 'success' ? 'text-green-600' : 'text-gray-500'
                    }`}
                  >
                    {m.message_type}
                  </span>
                  <span className="text-muted-foreground truncate">{renderPayload(m)}</span>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
