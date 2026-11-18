// GET /api/multi-agent/status?taskId=xxx：查询任务状态与各智能体快照
import { NextResponse } from 'next/server';
import { getAgentRuntime } from '@/agents/orchestrator-agent';
import { taskStore } from '@/state/task-state';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const taskId = searchParams.get('taskId');

  const { agents, orchestrator } = getAgentRuntime();

  // 未指定 taskId：返回所有 agent 当前快照（全局状态）
  if (!taskId) {
    return NextResponse.json({
      agents: [orchestrator.getSnapshot(), ...agents.map((a) => a.getSnapshot())],
    });
  }

  const task = taskStore.get(taskId);
  if (!task) {
    return NextResponse.json({ error: '任务不存在或已被淘汰' }, { status: 404 });
  }

  return NextResponse.json({
    taskId: task.taskId,
    phase: task.phase,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    paperCount: task.papers.length,
    weights: task.weights,
    error: task.error,
    agents: Array.from(task.agents.values()),
    hasResults: {
      signal1: !!task.signal1Results,
      signal2: !!task.signal2Results,
      signal3: !!task.signal3Results,
      signal4: !!task.signal4Results,
      fused: !!task.fusedResults,
    },
    signalStats: task.signalStats,
    fusionAnomalies: task.fusionAnomalies,
  });
}
