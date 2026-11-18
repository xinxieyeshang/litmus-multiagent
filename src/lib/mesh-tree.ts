/**
 * MeSH Tree Number 领域映射
 * 基于 MeSH 官方树状结构（second-level prefix）映射到 8 大领域
 * 数据源：https://id.nlm.nih.gov/mesh/
 */

import { classifyMeshTerm as classifyByKeyword } from './mesh-domains';

/**
 * MeSH 树状结构二级前缀 → 8 大领域映射
 * 按最长前缀优先匹配
 */
const MESH_TREE_TO_DOMAIN: Array<{ prefix: string; domain: string }> = [
  // ========== 分子与细胞生物学 ==========
  { prefix: 'A11', domain: '分子与细胞生物学' }, // Cells
  { prefix: 'D12', domain: '分子与细胞生物学' }, // Amino Acids, Peptides, and Proteins
  { prefix: 'D13', domain: '分子与细胞生物学' }, // Nucleic Acids, Nucleotides, and Nucleosides
  { prefix: 'D08', domain: '分子与细胞生物学' }, // Enzymes and Coenzymes
  { prefix: 'D09', domain: '分子与细胞生物学' }, // Carbohydrates
  { prefix: 'D10', domain: '分子与细胞生物学' }, // Lipids
  { prefix: 'D05', domain: '分子与细胞生物学' }, // Macromolecular Substances
  { prefix: 'G04', domain: '分子与细胞生物学' }, // Cell Physiological Phenomena
  { prefix: 'G05', domain: '分子与细胞生物学' }, // Genetic Processes
  { prefix: 'G06', domain: '分子与细胞生物学' }, // Biochemical Phenomena
  { prefix: 'G07', domain: '分子与细胞生物学' }, // Physiological Processes (general)
  // ========== 免疫与感染 ==========
  { prefix: 'A15', domain: '免疫与感染' }, // Hemic and Immune Systems
  { prefix: 'A18', domain: '免疫与感染' }, // Immune System Phenomena (deprecated, mapped to A15)
  { prefix: 'C01', domain: '免疫与感染' }, // Bacterial Infections and Mycoses
  { prefix: 'C02', domain: '免疫与感染' }, // Virus Diseases
  { prefix: 'C03', domain: '免疫与感染' }, // Parasitic Diseases
  { prefix: 'C20', domain: '免疫与感染' }, // Immunologic Diseases
  { prefix: 'B04', domain: '免疫与感染' }, // Viruses
  { prefix: 'B03', domain: '免疫与感染' }, // Bacteria
  { prefix: 'D20', domain: '免疫与感染' }, // Complex Mixtures (antibodies, antigens)
  { prefix: 'D23', domain: '免疫与感染' }, // Biological Factors
  { prefix: 'D24', domain: '免疫与感染' }, // Immunologic Factors (antigens)
  // ========== 神经科学 ==========
  { prefix: 'A08', domain: '神经科学' }, // Nervous System
  { prefix: 'A09', domain: '神经科学' }, // Sense Organs (部分)
  { prefix: 'C10', domain: '神经科学' }, // Nervous System Diseases
  { prefix: 'C11', domain: '神经科学' }, // Eye Diseases
  { prefix: 'F02', domain: '神经科学' }, // Psychological Processes
  { prefix: 'F03', domain: '神经科学' }, // Mental Disorders
  // ========== 临床医学 ==========
  { prefix: 'C04', domain: '临床医学' }, // Neoplasms
  { prefix: 'C05', domain: '临床医学' }, // Musculoskeletal Diseases
  { prefix: 'C06', domain: '临床医学' }, // Digestive System Diseases
  { prefix: 'C07', domain: '临床医学' }, // Stomatognathic Diseases
  { prefix: 'C08', domain: '临床医学' }, // Respiratory Tract Diseases
  { prefix: 'C09', domain: '临床医学' }, // Otorhinolaryngologic Diseases
  { prefix: 'C12', domain: '临床医学' }, // Urogenital Diseases
  { prefix: 'C13', domain: '临床医学' }, // Female Urogenital Diseases
  { prefix: 'C14', domain: '临床医学' }, // Cardiovascular Diseases
  { prefix: 'C15', domain: '临床医学' }, // Hemic and Lymphatic Diseases
  { prefix: 'C16', domain: '临床医学' }, // Congenital, Hereditary Diseases
  { prefix: 'C17', domain: '临床医学' }, // Skin and Connective Tissue Diseases
  { prefix: 'C18', domain: '临床医学' }, // Nutritional and Metabolic Diseases
  { prefix: 'C19', domain: '临床医学' }, // Endocrine System Diseases
  { prefix: 'C21', domain: '临床医学' }, // Disorders of Environmental Origin
  { prefix: 'C22', domain: '临床医学' }, // Animal Diseases
  { prefix: 'C23', domain: '临床医学' }, // Pathological Conditions
  { prefix: 'C24', domain: '临床医学' }, // Occupational Diseases
  { prefix: 'C25', domain: '临床医学' }, // Chemically-Induced Disorders
  { prefix: 'C26', domain: '临床医学' }, // Wounds and Injuries
  { prefix: 'E01', domain: '临床医学' }, // Diagnosis
  { prefix: 'E02', domain: '临床医学' }, // Therapeutics
  { prefix: 'E03', domain: '临床医学' }, // Anesthesia and Analgesia
  { prefix: 'E04', domain: '临床医学' }, // Surgical Procedures
  { prefix: 'E06', domain: '临床医学' }, // Dentistry
  { prefix: 'E07', domain: '临床医学' }, // Equipment and Supplies
  { prefix: 'N02', domain: '临床医学' }, // Health Care Facilities
  // ========== 流行病学与公共卫生 ==========
  { prefix: 'N01', domain: '流行病学与公共卫生' }, // Population Characteristics
  { prefix: 'N03', domain: '流行病学与公共卫生' }, // Health Care Economics
  { prefix: 'N04', domain: '流行病学与公共卫生' }, // Health Services Administration
  { prefix: 'N05', domain: '流行病学与公共卫生' }, // Quality of Health Care
  // ========== 药理学与药物 ==========
  { prefix: 'D26', domain: '药理学与药物' }, // Pharmaceutical Preparations
  { prefix: 'D27', domain: '药理学与药物' }, // Chemical Actions and Uses
  { prefix: 'D01', domain: '药理学与药物' }, // Inorganic Chemicals
  { prefix: 'D02', domain: '药理学与药物' }, // Organic Chemicals
  { prefix: 'D03', domain: '药理学与药物' }, // Heterocyclic Compounds
  { prefix: 'D04', domain: '药理学与药物' }, // Polycyclic Compounds
  { prefix: 'D06', domain: '药理学与药物' }, // Hormones
  { prefix: 'D25', domain: '药理学与药物' }, // Biomedical Materials
  // ========== 方法与技术 ==========
  { prefix: 'E05', domain: '方法与技术' }, // Investigative Techniques
  { prefix: 'H01', domain: '方法与技术' }, // Natural Science Disciplines
  { prefix: 'H02', domain: '方法与技术' }, // Health Occupations
  { prefix: 'L01', domain: '方法与技术' }, // Information Science
  { prefix: 'L02', domain: '方法与技术' }, // Information Services
  // ========== 生态与环境 ==========
  { prefix: 'B01', domain: '生态与环境' }, // Eukaryota
  { prefix: 'B02', domain: '生态与环境' }, // Archaea
  { prefix: 'G16', domain: '生态与环境' }, // Biological Phenomena, Biogeographic
  { prefix: 'G17', domain: '生态与环境' }, // Mathematical Concepts
  { prefix: 'N06', domain: '生态与环境' }, // Environment and Public Health
  { prefix: 'J01', domain: '生态与环境' }, // Technology, Industry, Agriculture
  { prefix: 'J02', domain: '生态与环境' }, // Food and Beverages
  { prefix: 'J03', domain: '生态与环境' }, // Non-Medical Public and Private Facilities
  // ========== 其他类别（应被独立处理） ==========
  { prefix: 'A01', domain: '解剖学' }, // Body Regions
  { prefix: 'A02', domain: '解剖学' }, // Digestive System
  { prefix: 'A03', domain: '解剖学' }, // Digestive System (deprecated)
  { prefix: 'A04', domain: '解剖学' }, // Respiratory System
  { prefix: 'A05', domain: '解剖学' }, // Urogenital System
  { prefix: 'A06', domain: '解剖学' }, // Endocrine System
  { prefix: 'A07', domain: '解剖学' }, // Cardiovascular System
  { prefix: 'A10', domain: '解剖学' }, // Tissues
  { prefix: 'A12', domain: '解剖学' }, // Fluids and Secretions
  { prefix: 'A13', domain: '解剖学' }, // Animal Structures
  { prefix: 'A14', domain: '解剖学' }, // Stomatognathic System
  { prefix: 'A16', domain: '解剖学' }, // Embryonic Structures
  { prefix: 'A17', domain: '解剖学' }, // Integumentary System
  { prefix: 'F01', domain: '行为心理' }, // Behavior and Behavior Mechanisms
  { prefix: 'F04', domain: '行为心理' }, // Disciplines and Activities
  { prefix: 'I01', domain: '社会科学' }, // Social Sciences
  { prefix: 'I02', domain: '社会科学' }, // Education
  { prefix: 'I03', domain: '社会科学' }, // Human Activities
  { prefix: 'K01', domain: '人文' }, // Humanities
  { prefix: 'M01', domain: '人群' }, // Named Groups
  { prefix: 'V01', domain: '出版' }, // Publication Characteristics
  { prefix: 'V02', domain: '出版' }, // Publication Formats
  { prefix: 'V03', domain: '出版' }, // Publication Components
  { prefix: 'Z01', domain: '地理' }, // Geographic Locations
];

/**
 * MeSH 树状结构一级分类（前缀字母 → 中文类别名）
 * 用于覆盖未在第二级 prefix 中定义的项目
 */
const MESH_TOP_LEVEL: Record<string, string> = {
  A: '解剖学',
  B: '生态与环境',
  C: '临床医学',
  D: '药理学与药物',
  E: '方法与技术',
  F: '神经科学',
  G: '分子与细胞生物学',
  H: '方法与技术',
  I: '社会科学',
  J: '生态与环境',
  K: '人文',
  L: '方法与技术',
  M: '人群',
  N: '流行病学与公共卫生',
  V: '出版',
  Z: '地理',
};

/**
 * 根据树状编号分类到 8 大领域
 * @param treeNumber MeSH 树状编号，如 "D03.633.100.221.173"
 * @returns 8 大领域之一，未匹配返回 "其他"
 */
export function classifyByTreeNumber(treeNumber: string): string {
  // 1. 优先匹配 second-level prefix (前 3 个字符，如 "D03")
  if (treeNumber.length >= 3) {
    const prefix = treeNumber.substring(0, 3);
    for (const { prefix: p, domain } of MESH_TREE_TO_DOMAIN) {
      if (p === prefix) return domain;
    }
  }
  // 2. fallback 到 top-level (第一个字符)
  if (treeNumber.length >= 1) {
    const top = treeNumber.charAt(0);
    if (MESH_TOP_LEVEL[top]) return MESH_TOP_LEVEL[top];
  }
  return '其他';
}

// =====================================================
// MeSH Browser API 集成
// =====================================================

const MESH_API_BASE = 'https://id.nlm.nih.gov/mesh';
const FETCH_TIMEOUT_MS = 5000; // 单次请求超时
const OVERALL_TIMEOUT_MS = 30000; // 整体超时
const CONCURRENCY = 8; // 并发请求数

/**
 * 进程级缓存：MeSH 词 → 树状编号列表
 * 同一进程内重复出现的 MeSH 词只查询一次
 */
const treeNumberCache = new Map<string, string[]>();

interface FetchResult {
  found: number;
  total: number;
  byKeyword: number; // 多少个走 keyword fallback
  errors: string[];
}

/**
 * 内部：从 MeSH Browser API 获取单个 MeSH 词的树状编号
 */
async function fetchTreeNumberForTerm(
  term: string,
  signal?: AbortSignal,
): Promise<string[]> {
  // 检查缓存
  if (treeNumberCache.has(term)) {
    return treeNumberCache.get(term)!;
  }

  try {
    // 步骤1: 查询 descriptor UI (重试 3 次)
    const lookupUrl = `${MESH_API_BASE}/lookup/descriptor?label=${encodeURIComponent(term)}&match=exact`;
    let lookupData: Array<{ resource?: string }> | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const lookupResp = await fetch(lookupUrl, {
          headers: { Accept: 'application/json' },
          signal,
        });
        if (lookupResp.ok) {
          lookupData = (await lookupResp.json()) as Array<{ resource?: string }>;
          break;
        }
        if (lookupResp.status === 404) break; // 词不存在，没必要重试
      } catch (e) {
        if ((e as { name?: string })?.name === 'AbortError') throw e;
        if (attempt === 2) throw e;
        await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
      }
    }
    if (!lookupData || !Array.isArray(lookupData) || !lookupData[0]?.resource) {
      treeNumberCache.set(term, []); // 缓存空结果避免重试
      return [];
    }

    // 步骤2: 查询详细 tree numbers (重试 3 次)
    const ui = lookupData[0].resource.split('/').pop();
    if (!ui) {
      treeNumberCache.set(term, []);
      return [];
    }
    const detailUrl = `${MESH_API_BASE}/${ui}.json`;
    let detailData: { treeNumber?: string | string[] } | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const detailResp = await fetch(detailUrl, {
          headers: { Accept: 'application/json' },
          signal,
        });
        if (detailResp.ok) {
          detailData = (await detailResp.json()) as { treeNumber?: string | string[] };
          break;
        }
      } catch (e) {
        if ((e as { name?: string })?.name === 'AbortError') throw e;
        if (attempt === 2) throw e;
        await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
      }
    }
    if (!detailData) {
      treeNumberCache.set(term, []);
      return [];
    }
    // treeNumber 字段可能是字符串或字符串数组（API 行为不一致）
    const rawTreeNumber = detailData.treeNumber;
    const treeNumberUris: string[] = Array.isArray(rawTreeNumber)
      ? rawTreeNumber
      : rawTreeNumber
        ? [rawTreeNumber]
        : [];
    // treeNumber 字段是完整 URI 列表，如 "http://id.nlm.nih.gov/mesh/D03.633.100.221.173"
    const treeNumbers = treeNumberUris.map((uri: string) => {
      const parts = uri.split('/');
      return parts[parts.length - 1];
    });

    treeNumberCache.set(term, treeNumbers);
    return treeNumbers;
  } catch (e) {
    // 区分 abort 和其他错误
    if ((e as { name?: string })?.name === 'AbortError') {
      throw e;
    }
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[mesh-tree] error for "${term}": ${(e as Error).message}`);
    }
    // 静默失败：缓存空结果
    treeNumberCache.set(term, []);
    return [];
  }
}

/**
 * 批量获取一组 MeSH 词的树状编号（带并发控制和整体超时）
 */
export async function batchFetchTreeNumbers(
  meshTerms: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<FetchResult> {
  const unique = Array.from(new Set(meshTerms.filter(t => t && t.trim())));
  const result: FetchResult = {
    found: 0,
    total: unique.length,
    byKeyword: 0,
    errors: [],
  };

  if (unique.length === 0) return result;

  // 过滤出未缓存的项
  const toFetch = unique.filter(t => !treeNumberCache.has(t));
  if (toFetch.length === 0) {
    // 全部命中缓存
    result.found = unique.filter(t => (treeNumberCache.get(t) || []).length > 0).length;
    return result;
  }

  // 整体超时
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OVERALL_TIMEOUT_MS);

  let processed = 0;
  try {
    for (let i = 0; i < toFetch.length; i += CONCURRENCY) {
      const batch = toFetch.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(term =>
          fetchTreeNumberForTerm(term, controller.signal).catch(() => []),
        ),
      );
      for (const s of settled) {
        if (s.status === 'rejected') {
          result.errors.push(String(s.reason));
        }
      }
      processed += batch.length;
      onProgress?.(processed, toFetch.length);
    }
  } finally {
    clearTimeout(timeoutId);
  }

  // 统计命中率
  result.found = unique.filter(t => (treeNumberCache.get(t) || []).length > 0).length;
  return result;
}

/**
 * 给定一组 MeSH 词，统计其领域分布
 * 优先使用 MeSH Tree Number 分类，找不到时 fallback 到关键词匹配
 */
export function computeDomainDistributionByTree(
  meshTerms: string[],
): { distribution: Record<string, number>; byTree: number; byKeyword: number } {
  const distribution: Record<string, number> = {};
  let byTree = 0;
  let byKeyword = 0;

  for (const term of meshTerms) {
    const treeNumbers = treeNumberCache.get(term);
    let domain: string | null = null;

    if (treeNumbers && treeNumbers.length > 0) {
      // 使用第一个 tree number（最具体的）
      // 注：MeSH 树状编号前 3 字符是 second-level prefix，最长前缀匹配
      domain = classifyByTreeNumber(treeNumbers[0]);
      byTree++;
    } else {
      // Fallback 到关键词匹配
      domain = classifyByKeyword(term);
      byKeyword++;
    }

    distribution[domain] = (distribution[domain] || 0) + 1;
  }

  return { distribution, byTree, byKeyword };
}

/**
 * 获取论文的主要领域（MeSH 词中出现频率最高的领域）
 * 用于 Signal 4 的领域种子聚类
 */
export function getPrimaryDomainFromDistribution(
  distribution: Record<string, number>,
): string {
  if (!distribution || Object.keys(distribution).length === 0) {
    return '未知';
  }
  // 找出现次数最多的领域
  let maxDomain = '未知';
  let maxCount = 0;
  for (const [domain, count] of Object.entries(distribution)) {
    if (count > maxCount) {
      maxCount = count;
      maxDomain = domain;
    }
  }
  return maxDomain;
}

/**
 * 批量分类论文的主要领域（异步，会调用 MeSH API 获取 tree numbers）
 * 返回：Map<pmid, primaryDomain>
 */
export async function classifyPapersByPrimaryDomain(
  papers: Array<{ pmid: string; meshTerms?: string[] | string }>,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, string>> {
  // 收集所有唯一的 meshTerms
  const allTerms = new Set<string>();
  for (const p of papers) {
    const terms = Array.isArray(p.meshTerms) ? p.meshTerms : [];
    for (const term of terms) {
      if (term && term.trim()) allTerms.add(term.trim());
    }
  }

  // 批量获取 tree numbers（填充缓存）
  if (allTerms.size > 0) {
    await batchFetchTreeNumbers(Array.from(allTerms), onProgress);
  }

  // 对每篇论文计算领域分布，取主要领域
  const result = new Map<string, string>();
  for (const p of papers) {
    const terms = Array.isArray(p.meshTerms) ? p.meshTerms : [];
    const { distribution } = computeDomainDistributionByTree(terms);
    const primaryDomain = getPrimaryDomainFromDistribution(distribution);
    result.set(p.pmid, primaryDomain);
  }

  return result;
}

/**
 * 清除进程内缓存（用于测试）
 */
export function clearTreeNumberCache(): void {
  treeNumberCache.clear();
}

/**
 * 获取当前缓存统计信息
 */
export function getCacheStats(): { size: number; hitRate?: number } {
  return { size: treeNumberCache.size };
}
