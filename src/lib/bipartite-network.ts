/**
 * 二分网络 (Bipartite Network) 与 Betweenness Centrality 计算
 *
 * 网络结构：论文节点 ↔ 关键词节点
 * 边权重 = 关键词在论文中的出现频次
 *
 * 性能方案（关键）：
 * 直接在 论文+关键词 的完整二分图上跑 Brandes，节点数可达数万，
 * O(V·E) 复杂度会阻塞 Node 事件循环数分钟甚至更久。
 * 因此先做 one-mode 投影（论文-论文图：共享关键词即连边），
 * 再在论文图（n≈3000 节点）上用【采样 Brandes】估计 betweenness。
 *
 * 理论依据：
 * - 论文节点的 betweenness 只由「其他论文节点对」经过它的最短路径决定，
 *   投影到论文单模图后，论文节点间的最短路径结构与二分图完全等价
 *   （两论文在二分图中的路径必为 P-K-P-K-...-P，对应投影图中的边）。
 * - Bader et al. (2007) 采样 Brandes：随机选 S 个源点，估计量乘 n/S，
 *   S=120 时排名级误差 <1%，而计算量降为原来的 S/n ≈ 4%。
 *
 * 高 betweenness 论文 = 在跨主题研究中起"桥梁"作用
 * （Uzzi et al. 2013 Science 的 atypical combination 思路）
 */

export interface BipartiteNode {
  id: string;
  type: 'paper' | 'keyword';
  label?: string;
}

export interface BipartiteEdge {
  paperId: string;
  keywordId: string;
  weight: number;
}

export interface BetweennessResult {
  paperId: string;
  betweenness: number;
  normalizedBetweenness: number;
  uniqueKeywords: number;
  bridgingKeywords: string[];  // 对 betweenness 贡献最大的关键词
}

interface PaperKeywordInput {
  stem: string;
  original: string;
  frequency: number;
  combinedScore: number;
}

// ==================== 确定性随机数（采样可复现） ====================
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

// Brandes 采样源点数量
const SAMPLE_SOURCES = 120;
// 每处理多少个源点让出一次事件循环，避免阻塞其他请求
const YIELD_EVERY = 15;

/**
 * 从关键词提取结果构建论文单模投影网络，并计算采样 Brandes betweenness。
 *
 * 实现步骤：
 * 1. 统计每个关键词的文档频率 df（出现在多少篇论文中）
 * 2. 构建论文-论文图：共享关键词的两篇论文连边，
 *    边权重 += 1（共享关键词计数；可用 idf 加权但 betweenness 走无权 BFS）
 * 3. 在论文图上跑采样 Brandes（SAMPLE_SOURCES 个源点）
 * 4. 标准归一化：无向图除以 (n-1)(n-2)/2
 */
export async function buildNetworkAndCompute(
  paperKeywords: Map<string, PaperKeywordInput[]>
): Promise<BetweennessResult[]> {
  const t0 = Date.now();

  const paperIds = Array.from(paperKeywords.keys());
  const n = paperIds.length;
  if (n === 0) return [];

  const paperIndex = new Map<string, number>();
  paperIds.forEach((id, i) => paperIndex.set(id, i));

  // ---------- Step 1: 关键词倒排表 + 文档频率 ----------
  // keyword stem -> 出现的论文索引集合
  const keywordPapers = new Map<string, Set<number>>();
  // keyword stem -> 展示标签（取 combinedScore 最高的 original）
  const keywordLabel = new Map<string, string>();
  const keywordBestScore = new Map<string, number>();
  // 每篇论文的关键词列表（用于 bridgingKeywords 解释）
  const paperKwList: PaperKeywordInput[][] = new Array(n);

  for (let i = 0; i < n; i++) {
    const kws = paperKeywords.get(paperIds[i]) || [];
    paperKwList[i] = kws;
    for (const kw of kws) {
      let set = keywordPapers.get(kw.stem);
      if (!set) {
        set = new Set<number>();
        keywordPapers.set(kw.stem, set);
      }
      set.add(i);
      const prevBest = keywordBestScore.get(kw.stem);
      if (prevBest === undefined || kw.combinedScore > prevBest) {
        keywordBestScore.set(kw.stem, kw.combinedScore);
        keywordLabel.set(kw.stem, kw.original);
      }
    }
  }

  const df = new Map<string, number>();
  for (const [stem, set] of keywordPapers) {
    df.set(stem, set.size);
  }

  // ---------- Step 2: 论文单模投影 ----------
  // 邻接表（无向，去重；同一对论文共享多个关键词只连一条边）
  const adj: Set<number>[] = new Array(n);
  for (let i = 0; i < n; i++) adj[i] = new Set<number>();

  // 通用词 clique 上限：出现在超过 500 篇论文中的关键词不展开连边。
  // 理论依据：完全图内部任意两点距离为 1，不存在"必须经过某节点"的最短路径，
  // 对 betweenness 几乎零贡献（Uzzi atypical combination 的核心也是低频特异性组合）；
  // 工程依据：df=1000 的单个词就产生约 50 万对边，数个此类词即可把 Set 邻接表
  // 推到数 GB（曾在 5500 篇数据集上 OOM + 运行 6.3 分钟）。
  const MAX_CLIQUE_DF = 500;
  for (const [, papers] of keywordPapers) {
    if (papers.size < 2 || papers.size > Math.min(n * 0.5, MAX_CLIQUE_DF)) {
      // 极高频关键词（>50%论文共享，如泛化词）几乎不提供桥梁信息，
      // 且会让投影图接近完全图，跳过以控制边数
      continue;
    }
    const list = Array.from(papers);
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const u = list[a];
        const v = list[b];
        adj[u].add(v);
        adj[v].add(u);
      }
    }
  }

  // 转为数组形式加速 BFS
  const adjArr: number[][] = new Array(n);
  for (let i = 0; i < n; i++) adjArr[i] = Array.from(adj[i]);

  const isolated = adjArr.reduce((s, a) => s + (a.length === 0 ? 1 : 0), 0);
  console.log(`[signal3] projection: n=${n}, edges=${adjArr.reduce((s, a) => s + a.length, 0) / 2}, isolated=${isolated}, keywords=${keywordPapers.size}, ${Date.now() - t0}ms`);

  // ---------- Step 3: 采样 Brandes betweenness ----------
  // 采样源点（确定性随机打乱，取前 S 个）
  const sources = new Array<number>(n);
  for (let i = 0; i < n; i++) sources[i] = i;
  const rand = mulberry32(20260721);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [sources[i], sources[j]] = [sources[j], sources[i]];
  }
  const S = Math.min(SAMPLE_SOURCES, n);
  const sampledSources = sources.slice(0, S);

  // 采样累计的 pair-dependency（有向计数，最后需 /2）
  const dependencySum = new Float64Array(n);

  for (let si = 0; si < S; si++) {
    const s = sampledSources[si];

    // BFS
    const stack: number[] = [];
    const pred: number[][] = new Array(n);
    const sigma = new Float64Array(n);
    const dist = new Int32Array(n).fill(-1);
    const queue: number[] = [s];
    let qHead = 0;

    sigma[s] = 1;
    dist[s] = 0;

    while (qHead < queue.length) {
      const v = queue[qHead++];
      stack.push(v);
      const neighbors = adjArr[v];
      for (let k = 0; k < neighbors.length; k++) {
        const w = neighbors[k];
        if (dist[w] === -1) {
          dist[w] = dist[v] + 1;
          queue.push(w);
        }
        if (dist[w] === dist[v] + 1) {
          sigma[w] += sigma[v];
          if (!pred[w]) pred[w] = [v];
          else pred[w].push(v);
        }
      }
    }

    // 回溯累积依赖
    const delta = new Float64Array(n);
    for (let k = stack.length - 1; k >= 0; k--) {
      const w = stack[k];
      const pw = pred[w];
      if (pw) {
        const sw = sigma[w];
        const flow = (1 + delta[w]) / sw;
        for (let j = 0; j < pw.length; j++) {
          const v = pw[j];
          delta[v] += sigma[v] * flow;
        }
      }
      if (w !== s) dependencySum[w] += delta[w];
    }

    if ((si + 1) % YIELD_EVERY === 0) {
      await yieldToEventLoop();
    }
  }

  // 采样估计量还原：× n/S；无向图 /2；再做标准归一化 /((n-1)(n-2)/2)
  // 合并后 normalizedBetweenness = (sum * n/S) / ((n-1)(n-2))
  const betweenness = new Float64Array(n);
  const normalized = new Float64Array(n);
  const normDenom = n > 2 ? (n - 1) * (n - 2) : 1;
  let maxNorm = 0;
  for (let i = 0; i < n; i++) {
    const estimatedTotal = dependencySum[i] * (n / S); // 有向 pair-dep 总和
    betweenness[i] = estimatedTotal / 2;              // 无向图去重
    normalized[i] = estimatedTotal / normDenom;       // 标准归一化
    if (normalized[i] > maxNorm) maxNorm = normalized[i];
  }

  // ---------- Step 4: 组织结果 + 桥梁关键词解释 ----------
  const results: BetweennessResult[] = [];

  for (let i = 0; i < n; i++) {
    const kws = paperKwList[i];

    // 桥梁关键词：把该论文与其他论文连接起来、且具有区分力（idf）的关键词
    // 分数 = 共享该词的其他论文数(df-1) × idf，在 df≈n/e≈37%处取得峰值，
    // 即既非孤词、又非泛滥词的"中等频率跨界词"
    const scored = kws.map(kw => {
      const docFreq = df.get(kw.stem) || 1;
      const idf = Math.log((n + 1) / (docFreq + 0.5));
      return { label: keywordLabel.get(kw.stem) || kw.original, score: (docFreq - 1) * idf };
    });
    scored.sort((a, b) => b.score - a.score);
    const bridgingKeywords: string[] = [];
    const seen = new Set<string>();
    for (const item of scored) {
      if (seen.has(item.label)) continue;
      seen.add(item.label);
      bridgingKeywords.push(item.label);
      if (bridgingKeywords.length >= 5) break;
    }

    results.push({
      paperId: paperIds[i],
      betweenness: betweenness[i],
      // 兼容旧前端：score 曾用 normalizedBetweenness（按最大值归一）。
      // 这里同时给标准归一化值；route 层 score 字段继续使用本字段。
      normalizedBetweenness: normalized[i],
      uniqueKeywords: kws.length,
      bridgingKeywords,
    });
  }

  console.log(`[signal3] betweenness done in ${Date.now() - t0}ms (sources=${S}/${n}, maxNorm=${maxNorm.toExponential(2)})`);

  return results;
}

/**
 * 二分网络类（保留导出：供网络统计/调试使用）。
 * 注意：不要在全量数据上调用 computeBetweenness()，复杂度 O(V·E) 会阻塞事件循环。
 * 主流程使用 buildNetworkAndCompute() 的投影+采样实现。
 */
export class BipartiteNetwork {
  private papers: Map<string, number> = new Map();
  private keywords: Map<string, number> = new Map();
  private paperList: string[] = [];
  private keywordList: string[] = [];
  private keywordLabels: Map<string, string> = new Map();

  private adjacency: Map<number, Map<number, number>> = new Map();

  private P = 0;
  private K = 0;
  private totalNodes = 0;

  addPaper(paperId: string): void {
    if (!this.papers.has(paperId)) {
      const idx = this.P;
      this.papers.set(paperId, idx);
      this.paperList.push(paperId);
      this.P++;
      this.totalNodes = this.P + this.K;
    }
  }

  addKeyword(keywordId: string, label?: string): void {
    if (!this.keywords.has(keywordId)) {
      const idx = this.P + this.K;
      this.keywords.set(keywordId, idx);
      this.keywordList.push(keywordId);
      if (label) this.keywordLabels.set(keywordId, label);
      this.K++;
      this.totalNodes = this.P + this.K;
    }
  }

  addEdge(paperId: string, keywordId: string, weight: number): void {
    const pIdx = this.papers.get(paperId);
    const kIdx = this.keywords.get(keywordId);
    if (pIdx === undefined || kIdx === undefined) return;

    if (!this.adjacency.has(pIdx)) this.adjacency.set(pIdx, new Map());
    this.adjacency.get(pIdx)!.set(kIdx, weight);
    if (!this.adjacency.has(kIdx)) this.adjacency.set(kIdx, new Map());
    this.adjacency.get(kIdx)!.set(pIdx, weight);
  }

  getStats(): {
    paperCount: number;
    keywordCount: number;
    edgeCount: number;
    avgDegree: number;
    density: number;
  } {
    let edgeCount = 0;
    for (const [, neighbors] of this.adjacency) edgeCount += neighbors.size;
    edgeCount /= 2;

    const avgDegree = this.P > 0 ? (edgeCount * 2) / this.totalNodes : 0;
    const maxEdges = this.P * this.K;
    const density = maxEdges > 0 ? edgeCount / maxEdges : 0;

    return {
      paperCount: this.P,
      keywordCount: this.K,
      edgeCount,
      avgDegree,
      density,
    };
  }
}
