// ============================================================
// 信号2工具：MeSH主题广度与跨域性（纯计算，无状态）
// 从 api/signal2/route.ts 平移，公式未改：
//   score = domainScore*0.30 + crossScore*0.25 + meshCountScore*0.20 + balanceScore*0.25
//   MeSH=0 论文固定 0.25 分防二值化
// 分类：优先 NLM 官方树状编号 API，失败回退本地关键词匹配
// ============================================================
import {
  batchFetchTreeNumbers,
  computeDomainDistributionByTree,
} from '@/lib/mesh-tree';
import { computeCrossDomainIndex } from '@/lib/mesh-domains';

export interface S2PaperInput {
  pmid: string;
  meshTerms: string[];
}

export interface S2ToolResult {
  pmid: string;
  meshCount: number;
  uniqueDomains: number;
  crossDomainIndex: number;
  domainDistribution: Record<string, number>;
  hasMesh: boolean;
  score: number;
}

export interface S2ToolOutput {
  results: S2ToolResult[];
  treeNumberStats: {
    totalUniqueTerms: number;
    termsFoundInMesh: number;
    coverage: number;
    errors: number;
    source: 'mesh-api' | 'keyword-fallback';
  };
}

export async function runSignal2(papers: S2PaperInput[]): Promise<S2ToolOutput> {
  // 1. 收集所有 MeSH 词去重
  const allMeshTerms = papers.flatMap((p) => p.meshTerms || []);
  const uniqueTerms = Array.from(new Set(allMeshTerms.filter((t) => t && t.trim())));

  // 2. 批量从 MeSH Browser API 获取 Tree Number（带超时与内部回退）
  const fetchResult = await batchFetchTreeNumbers(uniqueTerms);
  const treeCoverage = uniqueTerms.length > 0 ? fetchResult.found / uniqueTerms.length : 1.0;

  // 3. 全数据集 MeSH 统计
  const allMeshCounts = papers.map((p) => (p.meshTerms || []).length);
  const papersWithMesh = allMeshCounts.filter((c) => c > 0);
  const avgMeshCount =
    papersWithMesh.length > 0
      ? papersWithMesh.reduce((a, b) => a + b, 0) / papersWithMesh.length
      : 0;

  // 4. 逐篇计算领域分布与得分
  const results: S2ToolResult[] = papers.map((paper) => {
    const meshTerms = paper.meshTerms || [];
    const meshCount = meshTerms.length;
    const hasMesh = meshCount > 0;

    if (!hasMesh) {
      return {
        pmid: paper.pmid,
        meshCount: 0,
        uniqueDomains: 0,
        crossDomainIndex: 0,
        domainDistribution: {},
        hasMesh: false,
        score: 0.25,
      };
    }

    const { distribution: domainDistribution } = computeDomainDistributionByTree(meshTerms);
    const uniqueDomains = Object.keys(domainDistribution).length;
    const crossDomainIndex = computeCrossDomainIndex(domainDistribution);

    const meshRelativeDensity = avgMeshCount > 0 ? meshCount / avgMeshCount : 1;
    const meshCountScore = Math.min(meshRelativeDensity / 2, 1);

    const logDomains = Math.log2(uniqueDomains + 1);
    const domainScore = Math.min(logDomains / 2.5, 1);

    const crossScore = crossDomainIndex;

    const domainValues = Object.values(domainDistribution);
    const maxDomainRatio = domainValues.length > 0 ? Math.max(...domainValues) / meshCount : 1;
    const balanceScore = 1 - maxDomainRatio;

    const score =
      domainScore * 0.30 + crossScore * 0.25 + meshCountScore * 0.20 + balanceScore * 0.25;

    return {
      pmid: paper.pmid,
      meshCount,
      uniqueDomains,
      crossDomainIndex,
      domainDistribution,
      hasMesh: true,
      score,
    };
  });

  return {
    results,
    treeNumberStats: {
      totalUniqueTerms: uniqueTerms.length,
      termsFoundInMesh: fetchResult.found,
      coverage: treeCoverage,
      errors: fetchResult.errors.length,
      source: treeCoverage > 0.5 ? 'mesh-api' : 'keyword-fallback',
    },
  };
}
