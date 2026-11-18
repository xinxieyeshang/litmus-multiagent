// ============================================================
// 智能体基类：状态机 + 任务上下文 + 消息收发 + 执行反馈
//
// Agent 自主权限边界（硬约束）：
//   可自主：重试、调用备用工具、异常处理策略、请求补充信息、标记失败
//   禁止：修改指标公式、标准化方式、融合权重、数据划分、H1标签
// ============================================================
import type { MessageBus } from '@/communication/message-bus';
import {
  createMessage,
  type AgentMessage,
  type AgentName,
  type AgentStatus,
  type MessageStatus,
  type MessageType,
} from '@/communication/agent-protocol';
import { taskStore } from '@/state/task-state';

export abstract class BaseAgent {
  abstract readonly name: AgentName;
  abstract readonly displayName: string;
  abstract readonly description: string;

  protected bus: MessageBus;
  protected status: AgentStatus = 'IDLE';
  protected currentTaskId: string | null = null;
  protected progress = { done: 0, total: 0, detail: '' };
  private unsubscribe: (() => void) | null = null;

  constructor(bus: MessageBus) {
    this.bus = bus;
  }

  /**
   * 激活订阅（幂等）。抽象属性 this.name 依赖子类实例字段，
   * 不能在基类构造函数中访问（TS2715），必须由运行时在
   * 实例化完成后显式调用——且必须先于任何任务启动，
   * 否则同步发布的 TASK_ASSIGNED 会因订阅未生效而丢失。
   */
  activate(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.bus.subscribe(this.name, (msg) => {
      // 异步处理消息，不阻塞总线
      void this.onMessage(msg).catch((err) => {
        console.error(`[${this.name}] onMessage error:`, err);
        if (this.currentTaskId) {
          this.failTask(
            this.currentTaskId,
            err instanceof Error ? err.message : String(err),
          );
        }
      });
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** 子类实现：处理分配给自己的消息 */
  protected abstract onMessage(msg: AgentMessage): Promise<void>;

  /** 发送消息并同步任务状态 */
  protected send<T>(
    taskId: string,
    to: AgentName | 'broadcast',
    type: MessageType,
    status: MessageStatus,
    payload: T,
  ): void {
    this.bus.publish(createMessage(taskId, this.name, to, type, status, payload));
  }

  protected setStatus(taskId: string, status: AgentStatus): void {
    this.status = status;
    taskStore.updateAgent(taskId, this.name, {
      status,
      done: this.progress.done,
      total: this.progress.total,
      detail: this.progress.detail,
    });
  }

  protected updateProgress(taskId: string, done: number, total: number, detail: string): void {
    this.progress = { done, total, detail };
    taskStore.updateAgent(taskId, this.name, {
      status: this.status,
      done,
      total,
      detail,
    });
    // 进度消息节流：每5%或总数变化时上报，避免消息洪泛
    if (total > 0 && (done === total || done % Math.max(1, Math.floor(total / 20)) === 0)) {
      this.send(taskId, 'orchestrator', 'TASK_PROGRESS', 'info', {
        agent: this.name,
        done,
        total,
        detail,
      });
    }
  }

  protected beginTask(taskId: string, total: number, detail: string): void {
    this.currentTaskId = taskId;
    this.progress = { done: 0, total, detail };
    this.setStatus(taskId, 'RUNNING');
    this.send(taskId, 'orchestrator', 'TASK_STARTED', 'info', {
      agent: this.name,
      total,
      detail,
    });
  }

  protected completeTask<T>(taskId: string, payload: T): void {
    this.setStatus(taskId, 'COMPLETED');
    this.send(taskId, 'orchestrator', 'TASK_COMPLETED', 'success', payload);
    this.currentTaskId = null;
  }

  protected failTask(taskId: string, reason: string): void {
    this.setStatus(taskId, 'FAILED');
    this.send(taskId, 'orchestrator', 'TASK_FAILED', 'failed', {
      agent: this.name,
      reason,
    });
    this.currentTaskId = null;
  }

  /** Agent 自主决策上报：对异常子任务执行重试 */
  protected reportRetry(taskId: string, reason: string, target: string): void {
    this.setStatus(taskId, 'RETRYING');
    this.send(taskId, 'orchestrator', 'RETRY_DECIDED', 'warning', {
      agent: this.name,
      reason,
      target,
    });
    this.setStatus(taskId, 'RUNNING');
  }

  /** Agent 自主决策上报：切换备用工具 */
  protected reportFallback(taskId: string, reason: string, fallback: string): void {
    this.send(taskId, 'orchestrator', 'FALLBACK_USED', 'warning', {
      agent: this.name,
      reason,
      fallback,
    });
  }

  /** 非致命异常报告 */
  protected reportAnomaly(taskId: string, anomalyType: string, detail: string): void {
    this.send(taskId, 'orchestrator', 'ANOMALY_REPORT', 'warning', {
      agent: this.name,
      anomalyType,
      detail,
    });
  }

  /** 向协调智能体请求补充信息，等待响应（带超时） */
  protected requestInfo<TReq, TRes>(
    taskId: string,
    request: TReq,
    timeoutMs = 5000,
  ): Promise<TRes | null> {
    return new Promise((resolve) => {
      const requestId = `inforeq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        unsub();
        resolve(null);
      }, timeoutMs);

      const unsub = this.bus.subscribe(this.name, (msg) => {
        if (
          msg.message_type === 'INFO_RESPONSE' &&
          msg.task_id === taskId &&
          (msg.payload as { requestId?: string })?.requestId === requestId
        ) {
          clearTimeout(timer);
          unsub();
          resolve(msg.payload as TRes);
        }
      });

      this.send(taskId, 'orchestrator', 'INFO_REQUEST', 'info', {
        ...(typeof request === 'object' && request !== null ? request : { request }),
        requestId,
        fromAgent: this.name,
      });
    });
  }

  getSnapshot() {
    return {
      name: this.name,
      displayName: this.displayName,
      description: this.description,
      status: this.status,
      progress: { ...this.progress },
    };
  }
}
