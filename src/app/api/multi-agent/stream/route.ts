// GET /api/multi-agent/stream?taskId=xxx：SSE 实时消息流
// 先回放该任务的历史消息（断线重连不丢上下文），再实时推送新消息
import { executionLog } from '@/state/execution-log';
import { taskStore } from '@/state/task-state';
import { getAgentRuntime } from '@/agents/orchestrator-agent';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const taskId = searchParams.get('taskId') ?? undefined;
  const since = Number(searchParams.get('since') ?? '0') || undefined;

  // 确保 agent runtime 已注册（SSE 先于任务启动连接时也能收到后续消息）
  getAgentRuntime();

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          // 连接已关闭
        }
      };

      // 1. 回放历史消息
      const history = executionLog.query(taskId, since);
      for (const msg of history) {
        send({ type: 'message', data: msg });
      }
      send({ type: 'history_end', count: history.length });

      // 2. 实时订阅
      const unsubscribe = executionLog.subscribe((msg) => {
        if (taskId && msg.task_id !== taskId) return;
        send({ type: 'message', data: msg });
      });

      // 3. 任务终结时发送终态并保活一段时间后关闭由客户端决定
      const heartbeat = setInterval(() => {
        send({ type: 'ping', ts: Date.now() });
        // 任务已完成/失败且最新消息已推送后，发送 done 事件
        if (taskId) {
          const task = taskStore.get(taskId);
          if (task && (task.phase === 'completed' || task.phase === 'failed' || task.phase === 'cancelled')) {
            send({ type: 'task_end', phase: task.phase });
          }
        }
      }, 3000);

      request.signal.addEventListener('abort', () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // 已关闭
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
