import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';

// ============================================================================
// 任务删除 API
// 删除任务及其所有关联数据（结果、论文缓存、指标）
// ============================================================================

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const taskId = body.taskId;

    if (!taskId) {
      return NextResponse.json({ error: 'Missing taskId' }, { status: 400 });
    }

    const client = getSupabaseClient();

    // 检查任务是否存在
    const { data: task, error: taskError } = await client
      .from('background_tasks')
      .select('id, status')
      .eq('id', taskId)
      .maybeSingle();

    if (taskError) {
      throw new Error(`Failed to query task: ${taskError.message}`);
    }

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const currentStatus = (task as { status: string }).status;
    
    // 不允许删除正在运行的任务
    if (currentStatus === 'running') {
      return NextResponse.json({ 
        error: 'Cannot delete running task', 
        message: 'Please cancel the task first' 
      }, { status: 400 });
    }

    // 删除关联数据（由于设置了 onDelete: cascade，会自动删除）
    // 但为了确保，我们手动删除
    
    // 删除结果
    const { error: resultsError } = await client
      .from('task_results')
      .delete()
      .eq('task_id', taskId);
    
    if (resultsError) {
      console.error('[task/delete] Failed to delete results:', resultsError);
    }

    // 删除论文缓存
    const { error: papersError } = await client
      .from('paper_cache')
      .delete()
      .eq('task_id', taskId);
    
    if (papersError) {
      console.error('[task/delete] Failed to delete papers:', papersError);
    }

    // 删除指标
    const { error: metricsError } = await client
      .from('task_metrics')
      .delete()
      .eq('task_id', taskId);
    
    if (metricsError) {
      console.error('[task/delete] Failed to delete metrics:', metricsError);
    }

    // 删除任务本身
    const { error: taskDeleteError } = await client
      .from('background_tasks')
      .delete()
      .eq('id', taskId);

    if (taskDeleteError) {
      throw new Error(`Failed to delete task: ${taskDeleteError.message}`);
    }

    console.log(`[task] Task ${taskId} and all associated data deleted`);

    return NextResponse.json({
      taskId,
      message: 'Task and all associated data deleted successfully',
    });
  } catch (error) {
    console.error('[task/delete] Error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: String(error) },
      { status: 500 }
    );
  }
}