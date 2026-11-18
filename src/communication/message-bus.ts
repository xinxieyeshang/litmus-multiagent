// ============================================================
// 消息总线：进程内发布/订阅，智能体间消息路由
// 星型拓扑：专业agent <-> orchestrator，所有消息落执行日志
// ============================================================
import type { AgentMessage, AgentName } from './agent-protocol';
import { executionLog } from '@/state/execution-log';

type MessageHandler = (msg: AgentMessage) => void;

export class MessageBus {
  private handlers = new Map<string, Set<MessageHandler>>();

  /** 订阅发给指定agent的消息；'*' 订阅全部消息 */
  subscribe(target: AgentName | '*', handler: MessageHandler): () => void {
    let set = this.handlers.get(target);
    if (!set) {
      set = new Set();
      this.handlers.set(target, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  /** 发布消息：路由给目标 + broadcast 订阅者 + '*' 订阅者，并落执行日志 */
  publish(msg: AgentMessage): void {
    executionLog.append(msg);

    const deliver = (key: string) => {
      const set = this.handlers.get(key);
      if (!set) return;
      for (const fn of set) {
        try {
          fn(msg);
        } catch (err) {
          console.error(`[MessageBus] handler error for ${key}:`, err);
        }
      }
    };

    if (msg.to === 'broadcast') {
      // 广播：发给所有具名订阅者
      for (const key of this.handlers.keys()) {
        if (key !== '*' && key !== msg.from) deliver(key);
      }
    } else {
      deliver(msg.to);
    }
    deliver('*');
  }
}

// 模块级单例
const globalKey = '__litmus_message_bus__';
export const messageBus: MessageBus =
  (globalThis as Record<string, unknown>)[globalKey] as MessageBus ??
  ((globalThis as Record<string, unknown>)[globalKey] = new MessageBus());
