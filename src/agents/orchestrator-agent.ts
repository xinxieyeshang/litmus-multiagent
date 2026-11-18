// ============================================================
// 协调智能体（Orchestrator）：任务管理与决策中枢
//
// 职责：
// - 接收测度任务（API层调用 startTask）
// - 分解任务并分配给四个专业智能体（TASK_ASSIGNED）
// - 收集执行状态与结果（TASK_COMPLETED / TASK_FAILED / PROGRESS）
// - 处理信息请求（INFO_REQUEST -> 查询任务数据 -> INFO_RESPONSE）
// - 四信号齐集后，【剥离H1标签】组包 FUSION_REQUEST 给融合智能体
// - 融合完成后更新任务阶段为 completed
//
// 硬约束：
// - 不执行任何科学计算；指标公式/标准化/权重/数据划分/H1标签不可变
// - 组包给 fusion_agent 的 payload 类型层面不含 H1 字段
// ============================================================
import { BaseAgent } from './base-agent';
import type { AgentMessage, AgentName } from '@/communication/agent-protocol';
import { messageBus } from '@/communication/message-bus';
import {
  taskStore,
  nextTaskId,
  type LitmusTask,
  type LockedWeights,
  type TaskPaper,
} from '@/state/task-state';
import { Signal1Agent } from './signal1-agent';
import { Signal2Agent } from './signal2-agent';
import { Signal3Agent } from './signal3-agent';
import { Signal4Agent } from './signal4-agent';
import { FusionAgent } from './fusion-agent';

const SIGNAL_AGENTS: AgentName[] = [
  'signal1_agent',
  'signal2_agent',
  'signal3_agent',
  'signal4_agent',
];

export interface StartTaskInput {
  papers: TaskPaper[];
  h1Map: Record<string, { isH1: boolean; h1Classification: string[]; h1Rating: string }>;
  weights: LockedWeights;
  config?: { model?: string; temperature?: number; batchSize?: number; topK?: number };
}

export class OrchestratorAgent extends BaseAgent {
  readonly name = 'orchestrator' as const;
  readonly displayName = '协调智能体';
  readonly description = '任务分解、分配、状态收集与融合触发（不执行科学计算）';

  /** API 层入口：创建任务并启动整个多智能体流程 */
  startTask(input: StartTaskInput): string {
    const taskId = nextTaskId();
    const now = Date.now();

    const task: LitmusTask = {
      taskId,
      phase: 'signals_running',
      createdAt: now,
      updatedAt: now,
      papers: input.papers,
      h1Map: input.h1Map,
      // 权重在创建时刻锁定（Object.freeze 防御性冻结，杜绝运行期篡改）
      weights: Object.freeze({ ...input.weights }),
      config: input.config ?? {},
      agents: new Map(),
    };

    // 初始化各 agent 运行态
    for (const name of [...SIGNAL_AGENTS, 'fusion_agent' as AgentName, 'orchestrator' as AgentName]) {
      task.agents.set(name, {
        name,
        status: name === 'orchestrator' ? 'RUNNING' : 'IDLE',
        done: 0,
        total: input.papers.length,
        detail: '',
        lastUpdate: now,
      });
    }

    taskStore.create(task);

    // 分解任务并分配给四个专业智能体（并行）
    taskStore.updateAgent(taskId, 'orchestrator', { detail: '任务已分解，分配给四个专业智能体' });
    for (const agent of SIGNAL_AGENTS) {
      this.send(taskId, agent, 'TASK_ASSIGNED', 'info', {
        papers: input.papers,
        model: input.config?.model,
        temperature: input.config?.temperature,
        batchSize: input.config?.batchSize,
        topK: input.config?.topK,
      });
    }
    return taskId;
  }

  protected async onMessage(msg: AgentMessage): Promise<void> {
    const taskId = msg.task_id;

    switch (msg.message_type) {
      case 'TASK_STARTED':
      case 'TASK_PROGRESS':
      case 'RETRY_DECIDED':
      case 'FALLBACK_USED':
      case 'ANOMALY_REPORT':
        // 状态类消息已落执行日志，此处无需额外处理
        break;

      case 'TASK_COMPLETED': {
        const payload = msg.payload as {
          results?: unknown[];
          stats?: unknown;
          treeNumberStats?: unknown;
          summary?: unknown;
          checks?: unknown[];
          branches?: unknown;
        };
        const task = taskStore.get(taskId);
        if (!task) return;

        // 归档各信号结果与统计
        const statsPatch: Record<string, unknown> = { ...(task.signalStats ?? {}) };
        if (payload.stats !== undefined) statsPatch[msg.from] = payload.stats;
        if (payload.treeNumberStats !== undefined) statsPatch[`${msg.from}_treeNumberStats`] = payload.treeNumberStats;
        if (payload.summary !== undefined) statsPatch[`${msg.from}_summary`] = payload.summary;

        const patch: Partial<LitmusTask> = { signalStats: statsPatch };
        if (msg.from === 'signal1_agent') patch.signal1Results = payload.results;
        if (msg.from === 'signal2_agent') patch.signal2Results = payload.results;
        if (msg.from === 'signal3_agent') patch.signal3Results = payload.results;
        if (msg.from === 'signal4_agent') patch.signal4Results = payload.results;
        taskStore.update(taskId, patch);

        this.maybeTriggerFusion(taskId);
        break;
      }

      case 'TASK_FAILED': {
        const payload = msg.payload as { agent: AgentName; reason: string };
        taskStore.update(taskId, {
          phase: 'failed',
          error: `${payload.agent} 执行失败：${payload.reason}`,
        });
        taskStore.updateAgent(taskId, 'orchestrator', {
          status: 'FAILED',
          detail: `${payload.agent} 失败，任务终止`,
        });
        break;
      }

      case 'INFO_REQUEST': {
        this.handleInfoRequest(msg);
        break;
      }

      case 'FUSION_COMPLETED': {
        const payload = msg.payload as {
          fusedResults: LitmusTask['fusedResults'];
          weightsUsed: unknown;
          degenerateSignals: string[];
          anomalies: string[];
        };
        taskStore.update(taskId, {
          phase: 'completed',
          fusedResults: payload.fusedResults,
          fusionAnomalies: payload.anomalies,
        });
        const statsPatch: Record<string, unknown> = {
          ...(taskStore.get(taskId)?.signalStats ?? {}),
          fusion: {
            weightsUsed: payload.weightsUsed,
            degenerateSignals: payload.degenerateSignals,
          },
        };
        taskStore.update(taskId, { signalStats: statsPatch });
        taskStore.updateAgent(taskId, 'orchestrator', {
          status: 'COMPLETED',
          detail: `融合完成，产出 ${payload.fusedResults?.length ?? 0} 条综合结果`,
        });
        break;
      }

      case 'FUSION_ANOMALY':
        // 融合校验异常：记录即可，FUSION_COMPLETED 仍会到来
        break;

      default:
        break;
    }
  }

  /** 四信号齐集后触发融合（组包时剥离H1，fusion输入类型上无H1字段） */
  private maybeTriggerFusion(taskId: string): void {
    const task = taskStore.get(taskId);
    if (!task || task.phase !== 'signals_running') return;
    if (
      !task.signal1Results ||
      !task.signal2Results ||
      !task.signal3Results ||
      !task.signal4Results
    ) {
      return;
    }

    taskStore.update(taskId, { phase: 'fusion_running' });
    taskStore.updateAgent(taskId, 'orchestrator', { detail: '四信号齐集，请求融合智能体执行融合' });

    // H1 剥离点：此处只取 { pmid, score }，绝不携带 h1Map 中任何字段
    const pickScore = (arr: unknown[]): Array<{ pmid: string; score: number }> =>
      (arr as Array<{ pmid: string; score: number }>)
        .filter((r) => r && typeof r.pmid === 'string')
        .map((r) => ({ pmid: r.pmid, score: typeof r.score === 'number' ? r.score : 0 }));

    this.send(taskId, 'fusion_agent', 'FUSION_REQUEST', 'info', {
      s1: pickScore(task.signal1Results),
      s2: pickScore(task.signal2Results),
      s3: pickScore(task.signal3Results),
      s4: pickScore(task.signal4Results),
      weights: task.weights,
      taskPmids: task.papers.map((p) => p.pmid),
    });
  }

  /** 处理专业智能体的补充信息请求（仅从任务数据中查询，回 INFO_RESPONSE） */
  private handleInfoRequest(msg: AgentMessage): void {
    const taskId = msg.task_id;
    const task = taskStore.get(taskId);
    const payload = msg.payload as {
      requestId?: string;
      fromAgent?: AgentName;
      queryType?: string;
      pmids?: string[];
    };
    if (!task || !payload.requestId || !payload.fromAgent) return;

    // 目前支持：按 pmid 查询论文完整文本（供 S1 校验摘要缺失等场景）
    let data: unknown = null;
    if (payload.queryType === 'papers_by_pmid' && Array.isArray(payload.pmids)) {
      const set = new Set(payload.pmids);
      data = task.papers.filter((p) => set.has(p.pmid));
    }

    this.send(taskId, payload.fromAgent, 'INFO_RESPONSE', 'info', {
      requestId: payload.requestId,
      found: data !== null,
      data,
    });
  }
}

// ============================================================
// 运行时注册（globalThis 单例，防 HMR 重复注册）
// ============================================================
interface AgentRuntime {
  orchestrator: OrchestratorAgent;
  agents: BaseAgent[];
}

const globalKey = '__litmus_agent_runtime__';

export function getAgentRuntime(): AgentRuntime {
  const g = globalThis as Record<string, unknown>;
  if (!g[globalKey]) {
    const orchestrator = new OrchestratorAgent(messageBus);
    const agents: BaseAgent[] = [
      new Signal1Agent(messageBus),
      new Signal2Agent(messageBus),
      new Signal3Agent(messageBus),
      new Signal4Agent(messageBus),
      new FusionAgent(messageBus),
    ];
    g[globalKey] = { orchestrator, agents } satisfies AgentRuntime;
  }
  const runtime = g[globalKey] as AgentRuntime;
  // 激活订阅（幂等）：必须先于任何任务启动返回，
  // 否则 startTask 同步发布的 TASK_ASSIGNED 会丢失。
  // 防御式调用：HMR 后 globalThis 可能残留旧版实例（无 activate）
  for (const agent of [runtime.orchestrator, ...runtime.agents]) {
    if (typeof agent.activate === 'function') agent.activate();
  }
  return runtime;
}
