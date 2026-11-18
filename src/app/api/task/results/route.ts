import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';

// ============================================================================
// 任务结果导出 API
// 获取任务的完整结果数据，支持分页和导出
// ============================================================================

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const taskId = searchParams.get('taskId');
    const signalType = searchParams.get('signalType');
    const limit = parseInt(searchParams.get('limit') || '1000');
    const offset = parseInt(searchParams.get('offset') || '0');
    const format = searchParams.get('format') || 'json';

    if (!taskId) {
      return NextResponse.json({ error: 'Missing taskId' }, { status: 400 });
    }

    const client = getSupabaseClient();

    // 验证任务存在
    const { data: task, error: taskError } = await client
      .from('background_tasks')
      .select('id, status, signal_type, total_papers')
      .eq('id', taskId)
      .maybeSingle();

    if (taskError) {
      throw new Error(`Failed to query task: ${taskError.message}`);
    }

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const taskData = task as { id: string; status: string; signal_type: string; total_papers: number };

    // 获取结果数据
    let resultsQuery = client
      .from('task_results')
      .select('pmid, signal_type, result_data, score')
      .eq('task_id', taskId)
      .order('pmid')
      .range(offset, offset + limit - 1);

    if (signalType) {
      resultsQuery = resultsQuery.eq('signal_type', signalType);
    }

    const { data: results, error: resultsError } = await resultsQuery;

    if (resultsError) {
      throw new Error(`Failed to query results: ${resultsError.message}`);
    }

    // 获取论文原始数据（用于合并）
    const { data: papers, error: papersError } = await client
      .from('paper_cache')
      .select('pmid, title, is_h1, h1_classification, h1_rating')
      .eq('task_id', taskId)
      .range(offset, offset + limit - 1);

    if (papersError) {
      console.error('[task/results] Failed to query papers:', papersError);
    }

    // 合并结果和原始数据
    const paperMap = new Map<string, { title?: string; is_h1: boolean; h1_classification?: string[]; h1_rating?: string }>();
    if (papers) {
      for (const p of (papers as Array<{ pmid: string; title?: string; is_h1: boolean; h1_classification?: string[]; h1_rating?: string }>)) {
        paperMap.set(p.pmid, p);
      }
    }

    const mergedResults = (results || []).map(r => {
      const rData = r as { pmid: string; signal_type: string; result_data: Record<string, unknown>; score: number | null };
      const paperInfo = paperMap.get(rData.pmid);
      return {
        pmid: rData.pmid,
        title: paperInfo?.title,
        signal_type: rData.signal_type,
        result: rData.result_data,
        score: rData.score ? rData.score / 100 : null, // 转换回 0-1 范围
        is_h1: paperInfo?.is_h1 || false,
        h1_classification: paperInfo?.h1_classification || [],
        h1_rating: paperInfo?.h1_rating || '',
      };
    });

    // 获取指标数据
    const { data: metrics } = await client
      .from('task_metrics')
      .select('*')
      .eq('task_id', taskId);

    // 如果请求 CSV 格式，返回简化数据
    if (format === 'csv') {
      const csvRows = mergedResults.map(r => ({
        pmid: r.pmid,
        title: r.title || '',
        signal_type: r.signal_type,
        score: r.score?.toFixed(4) || '',
        is_h1: r.is_h1 ? 'Yes' : 'No',
        h1_classification: (r.h1_classification || []).join(';'),
        h1_rating: r.h1_rating || '',
      }));
      
      return NextResponse.json({
        format: 'csv',
        task: taskData,
        data: csvRows,
        metrics: metrics || [],
        total: mergedResults.length,
        hasMore: mergedResults.length === limit,
      });
    }

    return NextResponse.json({
      task: taskData,
      results: mergedResults,
      metrics: metrics || [],
      pagination: {
        offset,
        limit,
        total: mergedResults.length,
        hasMore: mergedResults.length === limit,
      },
    });
  } catch (error) {
    console.error('[task/results] Error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: String(error) },
      { status: 500 }
    );
  }
}