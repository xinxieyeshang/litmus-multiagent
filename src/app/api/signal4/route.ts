import { NextResponse } from 'next/server';
import { EmbeddingClient } from 'coze-coding-dev-sdk';
import { getSupabaseClient } from '@/storage/database/supabase-client';

// ============ Signal 4: 认知偏离度 (Cognitive Deviation) ============
// 结合两篇论文的核心思想：
// 1. 马铭：原创性 = 组合首次出现
// 2. 罗卓然：Novelty Score = 1 - max cos(dt, di)
//
// 本信号采用方案2（内部相对法）+ 方案3（概念频率法）的组合：
// - S4_embedding = 1 - mean(cos(v_i, v_j))，对所有j≠i
// - S4_frequency = 低频MeSH词占比
// - S4 = 0.5 × S4_embedding + 0.5 × S4_frequency

export const runtime = 'nodejs';
export const maxDuration = 600;

// ============ 类型定义 ============
interface Paper {
  pmid: string;
  title: string;
  abstract: string;
  meshTerms: string[];
  year?: string;
  paperType?: string;
  isH1?: boolean;
  h1Classification?: string[];
  h1Rating?: string;
}

interface Signal4Result {
  pmid: string;
  title: string;
  isH1: boolean;
  h1Classification: string[];
  h1Rating: string;
  // 内部相对法：语义偏离度
  semanticDeviation: number; // 1 - mean(cos(v_i, v_j))
  // 概念频率法：低频MeSH词占比
  conceptRarity: number; // 低频MeSH词数 / 总MeSH词数
  // 综合分数
  noveltyScore: number; // 0.5 * semanticDeviation + 0.5 * conceptRarity
  // 辅助信息
  avgSimilarity: number; // 平均余弦相似度
  lowFreqMeshCount: number; // 低频MeSH词数量
  totalMeshCount: number; // 总MeSH词数量
}

// ============ Embedding 工具 ============
async function embedText(text: string): Promise<number[]> {
  const client = new EmbeddingClient();
  const result = await client.embedText(text);
  return result as unknown as number[];
}

// L2 归一化：u = v / ||v||，归一化后 cos(a, b) = u_a · u_b
function l2Normalize(v: number[]): number[] {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return v.slice();
  const out = new Array<number>(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

// ============ 主处理函数 ============
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { papers, batchSize = 50 } = body as { papers: Paper[]; batchSize?: number };

    if (!papers || papers.length === 0) {
      return NextResponse.json({ error: '请提供论文数据' }, { status: 400 });
    }

    console.log(`[Signal4] Processing ${papers.length} papers...`);
    // Step 1: 为每篇论文生成 L2 归一化 embedding（Title + Abstract）
    console.log('[Signal4] Step 1: Generating embeddings...');
    // 存储归一化向量 u = v/||v||，归一化后 cos(a,b) = u_a · u_b
    const unitVectors: Map<string, number[]> = new Map();

    for (let i = 0; i < papers.length; i += batchSize) {
      const batch = papers.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (paper) => {
          try {
            const text = `${paper.title}. ${paper.abstract}`.slice(0, 2000);
            const embedding = await embedText(text);
            unitVectors.set(paper.pmid, l2Normalize(embedding));
          } catch (err) {
            console.error(`[Signal4] Embedding error for ${paper.pmid}:`, err);
          }
        })
      );
      console.log(`[Signal4] Embedded ${Math.min(i + batchSize, papers.length)}/${papers.length}`);
    }

    // Step 2: 计算每篇论文的语义偏离度（内部相对法，均值向量快速算法）
    //
    // 数学恒等式（与逐对比较结果严格一致，非近似）：
    //   归一化后 cos(v_i, v_j) = u_i · u_j
    //   avgSim_i = (1/(N-1)) Σ_{j≠i} cos(v_i, v_j)
    //            = (1/(N-1)) [u_i · Σ_j u_j - 1]
    //   设全体均值向量 ū = (1/N) Σ_j u_j，则：
    //   avgSim_i = [N·(u_i · ū) - 1] / (N-1)
    //
    // 因此无需构建 N×N 相似度矩阵，复杂度 O(N²·D) → O(N·D)，
    // 5000 篇时从数分钟降到毫秒级，且每篇分数与旧实现逐篇相同（仅 1e-15 级浮点误差）。
    console.log('[Signal4] Step 2: Computing semantic deviation (mean-vector fast path)...');
    const pmids = Array.from(unitVectors.keys());
    const dim = pmids.length > 0 ? unitVectors.get(pmids[0])!.length : 0;
    const sumVector = new Array<number>(dim).fill(0);
    for (const pmid of pmids) {
      const u = unitVectors.get(pmid)!;
      for (let d = 0; d < dim; d++) sumVector[d] += u[d];
    }

    const avgSimilarities: Map<string, number> = new Map();
    const n = pmids.length;
    for (const pmid of pmids) {
      const u = unitVectors.get(pmid)!;
      let dotWithSum = 0;
      for (let d = 0; d < dim; d++) dotWithSum += u[d] * sumVector[d];
      // u_i · (Σ_j u_j) - 1 即为 Σ_{j≠i} cos(v_i, v_j)（自身点积 u_i·u_i = 1）
      const sumExcludingSelf = dotWithSum - 1;
      const avgSim = n > 1 ? sumExcludingSelf / (n - 1) : 0;
      avgSimilarities.set(pmid, avgSim);
    }

    // Step 3: 计算MeSH词频率（概念频率法）
    console.log('[Signal4] Step 3: Computing MeSH term frequencies...');
    const meshFrequency: Map<string, number> = new Map();
    
    // 统计所有MeSH词的出现频率
    for (const paper of papers) {
      for (const mesh of paper.meshTerms || []) {
        const normalized = mesh.toLowerCase().trim();
        if (normalized) {
          meshFrequency.set(normalized, (meshFrequency.get(normalized) || 0) + 1);
        }
      }
    }

    // 计算中位数频率
    const frequencies = Array.from(meshFrequency.values()).sort((a, b) => a - b);
    const medianFreq = frequencies.length > 0 
      ? frequencies[Math.floor(frequencies.length / 2)] 
      : 1;

    // Step 4: 计算每篇论文的综合新颖性分数
    console.log('[Signal4] Step 4: Computing novelty scores...');
    const results: Signal4Result[] = papers.map((paper) => {
      // 语义偏离度 = 1 - 平均相似度
      const avgSim = avgSimilarities.get(paper.pmid) || 0;
      const semanticDeviation = 1 - avgSim;

      // 概念罕见度 = 低频MeSH词占比
      let lowFreqCount = 0;
      let totalCount = 0;
      for (const mesh of paper.meshTerms || []) {
        const normalized = mesh.toLowerCase().trim();
        if (normalized) {
          totalCount++;
          const freq = meshFrequency.get(normalized) || 0;
          if (freq <= medianFreq) {
            lowFreqCount++;
          }
        }
      }
      const conceptRarity = totalCount > 0 ? lowFreqCount / totalCount : 0;

      // 综合分数
      const noveltyScore = 0.5 * semanticDeviation + 0.5 * conceptRarity;

      return {
        pmid: paper.pmid,
        title: paper.title,
        isH1: paper.isH1 || false,
        h1Classification: paper.h1Classification || [],
        h1Rating: paper.h1Rating || '',
        semanticDeviation,
        conceptRarity,
        noveltyScore,
        score: noveltyScore, // 用于融合
        deviationScore: semanticDeviation, // 别名
        frequencyScore: conceptRarity, // 别名
        avgSimilarity: avgSim,
        lowFreqMeshCount: lowFreqCount,
        totalMeshCount: totalCount,
      };
    });

    // Step 5: 存储结果到Supabase（可选）
    try {
      const supabase = getSupabaseClient();
      const taskId = `signal5_${Date.now()}`;
      
      // 存储结果
      if (results.length > 0) {
        await supabase.from('task_results').insert(
          results.map(r => ({
            task_id: taskId,
            pmid: r.pmid,
            signal_type: 'signal5',
            result_data: {
              semanticDeviation: r.semanticDeviation,
              conceptRarity: r.conceptRarity,
              noveltyScore: r.noveltyScore,
              avgSimilarity: r.avgSimilarity,
              lowFreqMeshCount: r.lowFreqMeshCount,
              totalMeshCount: r.totalMeshCount,
            },
            score: r.noveltyScore,
            is_h1: r.isH1,
            h1_classification: r.h1Classification,
            h1_rating: r.h1Rating,
          }))
        );
        console.log(`[Signal4] Stored ${results.length} results to Supabase`);
      }
    } catch (dbErr) {
      console.warn('[Signal4] Failed to store results to Supabase:', dbErr);
      // 不阻塞返回
    }

    console.log(`[Signal4] Completed. Results: ${results.length}`);

    return NextResponse.json({
      results,
      summary: {
        totalPapers: results.length,
        avgNoveltyScore: results.reduce((sum, r) => sum + r.noveltyScore, 0) / results.length,
        medianFreq,
        uniqueMeshTerms: meshFrequency.size,
      },
    });
  } catch (error) {
    console.error('Signal 5 error:', error);
    return NextResponse.json(
      { error: `Signal 5 处理失败: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}
