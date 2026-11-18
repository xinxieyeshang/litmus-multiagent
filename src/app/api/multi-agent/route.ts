// POST /api/multi-agent：启动多智能体测度任务
// Body: { papers, h1Map?, weights?, config? }
// 返回: { taskId }
import { NextResponse } from 'next/server';
import { getAgentRuntime, type StartTaskInput } from '@/agents/orchestrator-agent';
import type { LockedWeights, TaskPaper } from '@/state/task-state';

export const maxDuration = 60;

const DEFAULT_WEIGHTS: LockedWeights = {
  signal1: 0.5,
  signal2: 0.3,
  signal3: 0.05,
  signal4: 0.15,
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      papers?: TaskPaper[];
      h1Map?: StartTaskInput['h1Map'];
      weights?: Partial<LockedWeights>;
      config?: StartTaskInput['config'];
    };

    if (!body.papers || !Array.isArray(body.papers) || body.papers.length === 0) {
      return NextResponse.json({ error: 'papers 不能为空' }, { status: 400 });
    }

    // 权重在任务创建时锁定（实验前确定），前端可传入但启动后不可改
    const weights: LockedWeights = {
      signal1: body.weights?.signal1 ?? DEFAULT_WEIGHTS.signal1,
      signal2: body.weights?.signal2 ?? DEFAULT_WEIGHTS.signal2,
      signal3: body.weights?.signal3 ?? DEFAULT_WEIGHTS.signal3,
      signal4: body.weights?.signal4 ?? DEFAULT_WEIGHTS.signal4,
    };

    // 规范化 papers
    const papers: TaskPaper[] = body.papers.map((p) => ({
      pmid: String(p.pmid ?? ''),
      title: String(p.title ?? ''),
      abstract: String(p.abstract ?? ''),
      meshTerms: Array.isArray(p.meshTerms) ? p.meshTerms.map(String) : [],
      year: String(p.year ?? ''),
      paperType: String(p.paperType ?? ''),
    }));

    const { orchestrator } = getAgentRuntime();
    const taskId = orchestrator.startTask({
      papers,
      h1Map: body.h1Map ?? {},
      weights,
      config: body.config,
    });

    return NextResponse.json({ taskId });
  } catch (err) {
    console.error('[multi-agent] start error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '任务启动失败' },
      { status: 500 },
    );
  }
}
