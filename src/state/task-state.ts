// ============================================================
// 任务状态管理：全局测度任务的生命周期与数据
//
// 安全约束（代码层硬隔离，不可被任何agent绕过）：
// 1. weights 在任务创建时写入 readonly，之后全系统只读
// 2. 任务的 papers 带 H1 标签，但 fusion 输入组包时在 orchestrator 剥离，
//    FusionAgent 的数据接口类型上不存在 H1 字段
// ============================================================
import type { AgentName, AgentStatus } from '@/communication/agent-protocol';

export type TaskPhase =
  | 'created'          // 已创建，待启动
  | 'signals_running'  // 四个信号智能体执行中
  | 'fusion_running'   // 融合智能体执行中
  | 'completed'        // 全部完成
  | 'failed'           // 任务失败
  | 'cancelled';

/** 融合权重（任务创建时锁定） */
export interface LockedWeights {
  readonly signal1: number;
  readonly signal2: number;
  readonly signal3: number;
  readonly signal4: number;
}

export interface TaskPaper {
  pmid: string;
  title: string;
  abstract: string;
  meshTerms: string[];
  year: string;
  paperType: string;
}

export interface AgentRuntimeInfo {
  name: AgentName;
  status: AgentStatus;
  done: number;
  total: number;
  detail: string;
  lastUpdate: number;
}

export interface FusedPaperResult {
  pmid: string;
  fusedScore: number;
  s1Norm: number;
  s2Norm: number;
  s3Norm: number;
  s4Norm: number;
}

export interface LitmusTask {
  taskId: string;
  phase: TaskPhase;
  createdAt: number;
  updatedAt: number;
  papers: TaskPaper[];
  /** H1 标签单独存放，与信号结果隔离存储，仅最终回传给前端 */
  h1Map: Record<string, { isH1: boolean; h1Classification: string[]; h1Rating: string }>;
  readonly weights: LockedWeights;
  config: {
    model?: string;
    temperature?: number;
    batchSize?: number;
    topK?: number;
  };
  agents: Map<AgentName, AgentRuntimeInfo>;
  // 各信号原始结果（由对应 agent 完成后写入）
  signal1Results?: unknown[];
  signal2Results?: unknown[];
  signal3Results?: unknown[];
  signal4Results?: unknown[];
  signalStats?: Record<string, unknown>;
  fusedResults?: FusedPaperResult[];
  fusionAnomalies?: string[];
  error?: string;
}

const MAX_TASKS = 10;

class TaskStore {
  private tasks = new Map<string, LitmusTask>();

  create(task: LitmusTask): void {
    this.tasks.set(task.taskId, task);
    // 淘汰最旧任务
    if (this.tasks.size > MAX_TASKS) {
      const oldest = Array.from(this.tasks.values()).sort(
        (a, b) => a.createdAt - b.createdAt,
      )[0];
      this.tasks.delete(oldest.taskId);
    }
  }

  get(taskId: string): LitmusTask | undefined {
    return this.tasks.get(taskId);
  }

  update(taskId: string, patch: Partial<LitmusTask>): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    Object.assign(t, patch, { updatedAt: Date.now() });
  }

  updateAgent(taskId: string, agent: AgentName, info: Partial<AgentRuntimeInfo>): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    const existing = t.agents.get(agent);
    if (existing) {
      Object.assign(existing, info, { lastUpdate: Date.now() });
    }
    t.updatedAt = Date.now();
  }
}

const globalKey = '__litmus_task_store__';
export const taskStore: TaskStore =
  (globalThis as Record<string, unknown>)[globalKey] as TaskStore ??
  ((globalThis as Record<string, unknown>)[globalKey] = new TaskStore());

let taskSeq = 0;
export function nextTaskId(): string {
  return `LITMUS_${Date.now().toString(36).toUpperCase()}_${(taskSeq++).toString(36).toUpperCase()}`;
}
