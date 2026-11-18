import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';

// ============================================================================
// 任务取消 API
// 将运行中的任务标记为已取消
// ============================================================================

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const taskId = body.taskId;

    if (!taskId) {
      return NextResponse.json({ error: 'Missing taskId' }, { status: 400 });
    }

    const client = getSupabaseClient();

    // 检查任务是否存在且状态允许取消
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
    
    // 只有 pending 或 running 状态的任务可以取消
    if (currentStatus !== 'pending' && currentStatus !== 'running') {
      return NextResponse.json({ 
        error: 'Cannot cancel task', 
        message: `Task is already ${currentStatus}` 
      }, { status: 400 });
    }

    // 更新任务状态为 cancelled
    const { error: updateError } = await client
      .from('background_tasks')
      .update({ 
        status: 'cancelled', 
        completed_at: new Date().toISOString(),
        error_message: 'Task cancelled by user'
      })
      .eq('id', taskId);

    if (updateError) {
      throw new Error(`Failed to cancel task: ${updateError.message}`);
    }

    console.log(`[task] Task ${taskId} cancelled`);

    return NextResponse.json({
      taskId,
      status: 'cancelled',
      message: 'Task cancelled successfully',
    });
  } catch (error) {
    console.error('[task/cancel] Error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: String(error) },
      { status: 500 }
    );
  }
}