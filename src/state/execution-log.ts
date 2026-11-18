// ============================================================
// 执行日志：记录所有智能体消息与状态转换
// 内存环形缓冲，上限 3000 条，防止长任务内存膨胀
// ============================================================
import type { AgentMessage } from '@/communication/agent-protocol';

const MAX_LOG_ENTRIES = 3000;

class ExecutionLog {
  private entries: AgentMessage[] = [];
  private listeners = new Set<(msg: AgentMessage) => void>();

  append(msg: AgentMessage): void {
    this.entries.push(msg);
    if (this.entries.length > MAX_LOG_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_LOG_ENTRIES);
    }
    for (const fn of this.listeners) {
      try {
        fn(msg);
      } catch {
        // 监听器异常不影响日志
      }
    }
  }

  /** 查询某任务的历史消息 */
  query(taskId?: string, sinceTimestamp?: number): AgentMessage[] {
    return this.entries.filter(
      (e) =>
        (taskId === undefined || e.task_id === taskId) &&
        (sinceTimestamp === undefined || e.timestamp > sinceTimestamp),
    );
  }

  /** 订阅新消息（SSE 转发用） */
  subscribe(fn: (msg: AgentMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

// 模块级单例（用 globalThis 防止 dev 模式 HMR 重建丢失）
const globalKey = '__litmus_execution_log__';
export const executionLog: ExecutionLog =
  (globalThis as Record<string, unknown>)[globalKey] as ExecutionLog ??
  ((globalThis as Record<string, unknown>)[globalKey] = new ExecutionLog());
