// ============================================================
// 信号4工具：认知偏离度（纯计算，无状态）
// 从 api/signal4/route.ts 平移，公式未改：
//   语义偏离度（均值向量恒等式，O(N·D)）+ 低频MeSH词占比
//   noveltyScore = 0.5 * semanticDeviation + 0.5 * conceptRarity
//
// 数学恒等式：avgSim_i = [N·(u_i·ū) - 1] / (N-1)，与逐对余弦严格一致
// ============================================================
import { EmbeddingClient } from 'coze-coding-dev-sdk';

export interface S4PaperInput {
  pmid: string;
  title: string;
  abstract: string;
  meshTerms: string[];
}

export interface S4ToolResult {
  pmid: string;
  semanticDeviation: number;
  conceptRarity: number;
  noveltyScore: number;
  score: number;
  avgSimilarity: number;
  lowFreqMeshCount: number;
  totalMeshCount: number;
  embeddingFailed?: boolean;
}

export interface S4ToolOutput {
  results: S4ToolResult[];
  summary: {
    totalPapers: number;
    avgNoveltyScore: number;
    medianFreq: number;
    uniqueMeshTerms: number;
    embeddingDim: number;
    embeddingFailedCount: number;
  };
}

async function embedText(text: string): Promise<number[]> {
  const client = new EmbeddingClient();
  const result = await client.embedText(text);
  return result as unknown as number[];
}

function l2Normalize(v: number[]): number[] {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return v.slice();
  const out = new Array<number>(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

export async function runSignal4(
  papers: S4PaperInput[],
  opts: {
    batchSize?: number;
    onBatchDone?: (doneCount: number, total: number) => void;
  } = {},
): Promise<S4ToolOutput> {
  const batchSize = opts.batchSize ?? 50;

  // Step 1: 逐篇生成 L2 归一化 embedding（记录失败清单供agent质检）
  const unitVectors = new Map<string, number[]>();
  const failedPmids = new Set<string>();
  let embeddingDim = 0;

  for (let i = 0; i < papers.length; i += batchSize) {
    const batch = papers.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (paper) => {
        try {
          const text = `${paper.title}. ${paper.abstract}`.slice(0, 2000);
          const embedding = await embedText(text);
          if (embeddingDim === 0) embeddingDim = embedding.length;
          unitVectors.set(paper.pmid, l2Normalize(embedding));
        } catch {
          failedPmids.add(paper.pmid);
        }
      }),
    );
    opts.onBatchDone?.(Math.min(i + batchSize, papers.length), papers.length);
  }

  // Step 2: 均值向量法计算语义偏离度
  const pmids = Array.from(unitVectors.keys());
  const dim = pmids.length > 0 ? unitVectors.get(pmids[0])!.length : 0;
  const sumVector = new Array<number>(dim).fill(0);
  for (const pmid of pmids) {
    const u = unitVectors.get(pmid)!;
    for (let d = 0; d < dim; d++) sumVector[d] += u[d];
  }

  const avgSimilarities = new Map<string, number>();
  const n = pmids.length;
  for (const pmid of pmids) {
    const u = unitVectors.get(pmid)!;
    let dotWithSum = 0;
    for (let d = 0; d < dim; d++) dotWithSum += u[d] * sumVector[d];
    const sumExcludingSelf = dotWithSum - 1;
    const avgSim = n > 1 ? sumExcludingSelf / (n - 1) : 0;
    avgSimilarities.set(pmid, avgSim);
  }

  // Step 3: MeSH 词频率统计（概念频率法）
  const meshFrequency = new Map<string, number>();
  for (const paper of papers) {
    for (const mesh of paper.meshTerms || []) {
      const normalized = mesh.toLowerCase().trim();
      if (normalized) {
        meshFrequency.set(normalized, (meshFrequency.get(normalized) || 0) + 1);
      }
    }
  }
  const frequencies = Array.from(meshFrequency.values()).sort((a, b) => a - b);
  const medianFreq = frequencies.length > 0 ? frequencies[Math.floor(frequencies.length / 2)] : 1;

  // Step 4: 逐篇综合分数（embedding失败的保持原行为：avgSim=0 → deviation=1）
  const results: S4ToolResult[] = papers.map((paper) => {
    const avgSim = avgSimilarities.get(paper.pmid) || 0;
    const semanticDeviation = 1 - avgSim;

    let lowFreqCount = 0;
    let totalCount = 0;
    for (const mesh of paper.meshTerms || []) {
      const normalized = mesh.toLowerCase().trim();
      if (normalized) {
        totalCount++;
        const freq = meshFrequency.get(normalized) || 0;
        if (freq <= medianFreq) lowFreqCount++;
      }
    }
    const conceptRarity = totalCount > 0 ? lowFreqCount / totalCount : 0;
    const noveltyScore = 0.5 * semanticDeviation + 0.5 * conceptRarity;

    return {
      pmid: paper.pmid,
      semanticDeviation,
      conceptRarity,
      noveltyScore,
      score: noveltyScore,
      avgSimilarity: avgSim,
      lowFreqMeshCount: lowFreqCount,
      totalMeshCount: totalCount,
      embeddingFailed: failedPmids.has(paper.pmid),
    };
  });

  return {
    results,
    summary: {
      totalPapers: results.length,
      avgNoveltyScore: results.reduce((sum, r) => sum + r.noveltyScore, 0) / results.length,
      medianFreq,
      uniqueMeshTerms: meshFrequency.size,
      embeddingDim,
      embeddingFailedCount: failedPmids.size,
    },
  };
}
