import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';

// ============================================================================
// 任务状态查询 API
// 查询后台任务的进度和状态
// ============================================================================

interface TaskStatus {
  id: string;
  signal_type: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  total_papers: number;
  processed_papers: number;
  error_message?: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  paper_file_name?: string;
  h1_file_name?: string;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const taskId = searchParams.get('taskId');
    const signalType = searchParams.get('signalType');
    const limit = parseInt(searchParams.get('limit') || '10');

    const client = getSupabaseClient();

    // 如果指定了 taskId，返回单个任务详情
    if (taskId) {
      const { data: task, error: taskError } = await client
        .from('background_tasks')
        .select('*')
        .eq('id', taskId)
        .maybeSingle();

      if (taskError) {
        throw new Error(`Failed to query task: ${taskError.message}`);
      }

      if (!task) {
        return NextResponse.json({ error: 'Task not found' }, { status: 404 });
      }

      // 获取该任务的指标
      const { data: metrics } = await client
        .from('task_metrics')
        .select('*')
        .eq('task_id', taskId);

      // 获取处理进度详情（按信号类型）
      const { data: resultCounts } = await client
        .from('task_results')
        .select('signal_type')
        .eq('task_id', taskId);

      // 统计各信号类型的处理数量
      const signalProgress: Record<string, number> = {};
      if (resultCounts) {
        for (const r of resultCounts as Array<{ signal_type: string }>) {
          signalProgress[r.signal_type] = (signalProgress[r.signal_type] || 0) + 1;
        }
      }

      return NextResponse.json({
        task: task as TaskStatus,
        metrics: metrics || [],
        signalProgress,
      });
    }

    // 否则返回任务列表
    let query = client
      .from('background_tasks')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    // 可选过滤条件
    if (signalType) {
      query = query.eq('signal_type', signalType);
    }

    const { data: tasks, error: tasksError } = await query;

    if (tasksError) {
      throw new Error(`Failed to query tasks: ${tasksError.message}`);
    }

    return NextResponse.json({
      tasks: (tasks || []) as TaskStatus[],
      total: tasks?.length || 0,
    });
  } catch (error) {
    console.error('[task/status] Error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: String(error) },
      { status: 500 }
    );
  }
}