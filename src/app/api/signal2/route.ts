// 信号2：MeSH主题广度与跨域性 API
// 改进：使用 MeSH Tree Number（来自 MeSH Browser API）进行精确领域分类，
// 找不到时 fallback 到关键词启发式匹配。
import { NextRequest, NextResponse } from 'next/server';
import {
  batchFetchTreeNumbers,
  computeDomainDistributionByTree,
} from '@/lib/mesh-tree';
import { computeCrossDomainIndex } from '@/lib/mesh-domains';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { papers } = body as {
      papers: Array<{ pmid: string; meshTerms: string[] }>;
    };

    if (!papers || !Array.isArray(papers) || papers.length === 0) {
      return NextResponse.json({ error: 'No papers provided' }, { status: 400 });
    }

    // 1. 收集所有 MeSH 词，去重
    const allMeshTerms = papers.flatMap(p => p.meshTerms || []);
    const uniqueTerms = Array.from(new Set(allMeshTerms.filter(t => t && t.trim())));

    // 2. 批量从 MeSH Browser API 获取 Tree Number（带超时和 fallback）
    const fetchResult = await batchFetchTreeNumbers(uniqueTerms);
    const treeCoverage = uniqueTerms.length > 0
      ? fetchResult.found / uniqueTerms.length
      : 1.0;

    // 3. 计算全数据集的MeSH统计
    const allMeshCounts = papers.map(p => (p.meshTerms || []).length);
    const papersWithMesh = allMeshCounts.filter(c => c > 0);
    const avgMeshCount = papersWithMesh.length > 0
      ? papersWithMesh.reduce((a, b) => a + b, 0) / papersWithMesh.length
      : 0;

    // 4. 对每篇论文做领域分布和得分计算
    const results = papers.map(paper => {
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

      // 使用 tree number 分类（带 keyword fallback）
      const { distribution: domainDistribution } =
        computeDomainDistributionByTree(meshTerms);
      const uniqueDomains = Object.keys(domainDistribution).length;
      const crossDomainIndex = computeCrossDomainIndex(domainDistribution);

      // 4 个特征
      const meshRelativeDensity = avgMeshCount > 0 ? meshCount / avgMeshCount : 1;
      const meshCountScore = Math.min(meshRelativeDensity / 2, 1);

      const logDomains = Math.log2(uniqueDomains + 1);
      const domainScore = Math.min(logDomains / 2.5, 1);

      const crossScore = crossDomainIndex;

      const domainValues = Object.values(domainDistribution);
      const maxDomainRatio = domainValues.length > 0
        ? Math.max(...domainValues) / meshCount
        : 1;
      const balanceScore = 1 - maxDomainRatio;

      const score = domainScore * 0.30 + crossScore * 0.25 +
                    meshCountScore * 0.20 + balanceScore * 0.25;

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

    return NextResponse.json({
      results,
      treeNumberStats: {
        totalUniqueTerms: uniqueTerms.length,
        termsFoundInMesh: fetchResult.found,
        coverage: treeCoverage,
        errors: fetchResult.errors.length,
        // 数据来源标识，便于 UI 显示
        source: treeCoverage > 0.5 ? 'mesh-api' : 'keyword-fallback',
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: `Signal 2 processing failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}
