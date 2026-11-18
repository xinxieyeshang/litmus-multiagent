// ============================================================
// 多智能体通信协议：统一消息格式定义
//
// 设计约束（实验诚信红线，代码层硬隔离）：
// - 任何 Agent 的消息 payload 中禁止携带 H1 标签（isH1 / h1Classification / h1Rating）
// - 融合权重在任务创建时锁定，流转中只读，任何 Agent 不可修改
// - 指标公式、标准化方式、训练/验证数据划分由工具层固化，Agent 无权变更
// - Agent 的自主权限仅五类：重试、调用备用工具、异常处理策略、
//   请求其他模块补充信息、将任务标记为失败
// ============================================================

/** 消息类型 */
export type MessageType =
  | 'TASK_ASSIGNED'      // orchestrator -> 专业agent：分配测度任务
  | 'TASK_STARTED'       // agent -> orchestrator：确认开始执行
  | 'TASK_PROGRESS'      // agent -> orchestrator：执行进度
  | 'TASK_COMPLETED'     // agent -> orchestrator：任务完成（附结果）
  | 'TASK_FAILED'        // agent -> orchestrator：任务失败（附原因）
  | 'RETRY_DECIDED'      // agent 自主决策：对异常子任务执行重试
  | 'FALLBACK_USED'      // agent 自主决策：切换备用工具
  | 'INFO_REQUEST'       // agent -> orchestrator：请求补充信息
  | 'INFO_RESPONSE'      // orchestrator -> agent：补充信息响应
  | 'ANOMALY_REPORT'     // agent -> orchestrator：非致命异常报告
  | 'FUSION_REQUEST'     // orchestrator -> fusion_agent：请求融合
  | 'FUSION_COMPLETED'   // fusion_agent -> orchestrator：融合完成
  | 'FUSION_ANOMALY'     // fusion_agent -> orchestrator：融合校验异常
  | 'TASK_CANCELLED';    // 任务取消

/** 智能体名称（星型拓扑：专业agent只与orchestrator通信） */
export type AgentName =
  | 'orchestrator'
  | 'signal1_agent'
  | 'signal2_agent'
  | 'signal3_agent'
  | 'signal4_agent'
  | 'fusion_agent';

/** 智能体状态机 */
export type AgentStatus = 'IDLE' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'RETRYING';

export type MessageStatus = 'success' | 'failed' | 'info' | 'warning';

/** 统一消息格式 */
export interface AgentMessage<T = unknown> {
  message_id: string;
  task_id: string;
  from: AgentName;
  to: AgentName | 'broadcast';
  message_type: MessageType;
  status: MessageStatus;
  payload: T;
  timestamp: number;
}

/** 生成消息ID */
let msgSeq = 0;
export function nextMessageId(): string {
  return `msg_${Date.now().toString(36)}_${(msgSeq++).toString(36)}`;
}

/** 构造消息 */
export function createMessage<T>(
  taskId: string,
  from: AgentName,
  to: AgentName | 'broadcast',
  messageType: MessageType,
  status: MessageStatus,
  payload: T,
): AgentMessage<T> {
  return {
    message_id: nextMessageId(),
    task_id: taskId,
    from,
    to,
    message_type: messageType,
    status,
    payload,
    timestamp: Date.now(),
  };
}

/** 质量检查项（每个agent完成时上报的质检结果） */
export interface QualityCheck {
  name: string;
  passed: boolean;
  detail: string;
}
