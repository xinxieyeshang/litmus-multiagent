import { NextRequest, NextResponse } from 'next/server';
import { processDocument, extractKeywords } from '@/lib/keyword-extraction';
import { buildNetworkAndCompute } from '@/lib/bipartite-network';
import type { Signal3Result } from '@/lib/types';

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const papers: Array<{ pmid: string; title?: string; abstract?: string }> = body.papers;
    const topK = body.topK || body.topKeywords || 15;

    if (!papers || !Array.isArray(papers) || papers.length === 0) {
      return NextResponse.json({ error: 'No papers provided' }, { status: 400 });
    }

    // Step 1: Tokenize all papers using processDocument
    const docs = papers.map(p =>
      processDocument(p.pmid, p.title || '', p.abstract || '')
    );

    // Step 2: Extract keywords using TF-IDF + TextRank
    const keywordMap = extractKeywords(docs, topK);

    // Step 3: Convert ExtractedKeyword[] to format expected by buildNetworkAndCompute
    const paperKeywords = new Map<string, Array<{ stem: string; original: string; frequency: number; combinedScore: number }>>();
    for (const [pmid, kws] of keywordMap) {
      paperKeywords.set(pmid, kws.map(kw => ({
        stem: kw.stem,
        original: kw.original,
        frequency: kw.frequency,
        combinedScore: kw.combinedScore,
      })));
    }

    // Step 4: Build paper-level projection network and compute sampled Brandes betweenness.
    // Async: periodically yields to event loop so it never freezes the whole server.
    const betweennessResults = await buildNetworkAndCompute(paperKeywords);

    // Create lookup map by paperId
    const betweennessLookup = new Map(betweennessResults.map(r => [r.paperId, r]));

    // Step 5: Score each paper
    const results: Signal3Result[] = papers.map(paper => {
      const kwList = keywordMap.get(paper.pmid) || [];
      const bwResult = betweennessLookup.get(paper.pmid);

      const betweenness = bwResult?.betweenness || 0;
      const normalizedBetweenness = bwResult?.normalizedBetweenness || 0;
      const bridgingKeywords = bwResult?.bridgingKeywords || [];

      const topKeywords = kwList
        .slice(0, 5)
        .map(kw => ({
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

    return NextResponse.json({
      results,
      stats: {
        totalPapers: papers.length,
        totalKeywords: betweennessResults.reduce((s, r) => s + r.uniqueKeywords, 0),
        avgBetweenness: results.reduce((s, r) => s + r.betweenness, 0) / results.length,
        maxBetweenness: Math.max(...results.map(r => r.betweenness)),
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Signal 3 error:', message);
    return NextResponse.json({ error: `Keyword network analysis failed: ${message}` }, { status: 500 });
  }
}
