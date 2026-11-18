// GET /api/multi-agent/result?taskId=xxx：拉取完整结果
// 返回各信号原始结果 + 融合结果 + H1标签（仅此端点回传H1，供前端指标计算）
import { NextResponse } from 'next/server';
import { taskStore } from '@/state/task-state';
import { getAgentRuntime } from '@/agents/orchestrator-agent';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const taskId = searchParams.get('taskId');
  if (!taskId) {
    return NextResponse.json({ error: '缺少 taskId' }, { status: 400 });
  }

  getAgentRuntime();
  const task = taskStore.get(taskId);
  if (!task) {
    return NextResponse.json({ error: '任务不存在或已被淘汰' }, { status: 404 });
  }

  return NextResponse.json({
    taskId: task.taskId,
    phase: task.phase,
    paperCount: task.papers.length,
    weights: task.weights,
    signal1Results: task.signal1Results,
    signal2Results: task.signal2Results,
    signal3Results: task.signal3Results,
    signal4Results: task.signal4Results,
    signalStats: task.signalStats,
    fusedResults: task.fusedResults,
    fusionAnomalies: task.fusionAnomalies,
    // H1标签仅在最终结果端点回传给前端（智能体流转全程隔离）
    h1Map: task.h1Map,
    error: task.error,
  });
}
