// ============================================================
// 信号3工具：知识网络桥梁性（纯计算，无状态）
// 从 api/signal3/route.ts 平移，算法未改：
//   TF-IDF + TextRank 关键词抽取 → 论文-关键词二分网络
//   → 论文图投影（df>500通用词不展开clique）→ 采样Brandes中介中心性
// ============================================================
import { processDocument, extractKeywords } from '@/lib/keyword-extraction';
import { buildNetworkAndCompute } from '@/lib/bipartite-network';

export interface S3PaperInput {
  pmid: string;
  title?: string;
  abstract?: string;
}

export interface S3ToolResult {
  pmid: string;
  keywordCount: number;
  betweenness: number;
  normalizedBetweenness: number;
  bridgingKeywords: string[];
  topKeywords: Array<{ keyword: string; score: number }>;
  score: number;
}

export interface S3ToolOutput {
  results: S3ToolResult[];
  stats: {
    totalPapers: number;
    totalKeywords: number;
    avgBetweenness: number;
    maxBetweenness: number;
    zeroBetweennessCount: number;
    avgKeywordCount: number;
  };
}

export async function runSignal3(papers: S3PaperInput[], topK = 15): Promise<S3ToolOutput> {
  // Step 1: 分词
  const docs = papers.map((p) => processDocument(p.pmid, p.title || '', p.abstract || ''));

  // Step 2: TF-IDF + TextRank 关键词抽取
  const keywordMap = extractKeywords(docs, topK);

  // Step 3: 转换格式
  const paperKeywords = new Map<
    string,
    Array<{ stem: string; original: string; frequency: number; combinedScore: number }>
  >();
  for (const [pmid, kws] of keywordMap) {
    paperKeywords.set(
      pmid,
      kws.map((kw) => ({
        stem: kw.stem,
        original: kw.original,
        frequency: kw.frequency,
        combinedScore: kw.combinedScore,
      })),
    );
  }

  // Step 4: 构建投影网络 + 采样Brandes中介中心性（异步让出事件循环）
  const betweennessResults = await buildNetworkAndCompute(paperKeywords);
  const betweennessLookup = new Map(betweennessResults.map((r) => [r.paperId, r]));

  // Step 5: 逐篇评分
  const results: S3ToolResult[] = papers.map((paper) => {
    const kwList = keywordMap.get(paper.pmid) || [];
    const bwResult = betweennessLookup.get(paper.pmid);

    const betweenness = bwResult?.betweenness || 0;
    const normalizedBetweenness = bwResult?.normalizedBetweenness || 0;
    const bridgingKeywords = bwResult?.bridgingKeywords || [];

    const topKeywords = kwList.slice(0, 5).map((kw) => ({
      keyword: kw.original,
      score: kw.combinedScore,
    }));

    return {
      pmid: paper.pmid,
      keywordCount: kwList.length,
      betweenness,
      normalizedBetweenness,
      bridgingKeywords,
      topKeywords,
      score: normalizedBetweenness,
    };
  });

  const zeroBetweennessCount = results.filter((r) => r.betweenness === 0).length;
  const avgKeywordCount = results.reduce((s, r) => s + r.keywordCount, 0) / results.length;

  return {
    results,
    stats: {
      totalPapers: papers.length,
      totalKeywords: betweennessResults.reduce((s, r) => s + r.uniqueKeywords, 0),
      avgBetweenness: results.reduce((s, r) => s + r.betweenness, 0) / results.length,
      maxBetweenness: Math.max(...results.map((r) => r.betweenness)),
      zeroBetweennessCount,
      avgKeywordCount,
    },
  };
}
