// ============================================================
// Fusion Agent：融合与验证智能体
//
// 职责：
// - 接收四个信号智能体的独立结果
// - 校验：PMID一致性、指标缺失、分值范围
// - 按任务创建时锁定的权重融合（复刻前端既定规则，一字不改）
// - 记录融合异常并反馈协调智能体
//
// 安全红线（类型层面硬隔离）：
// - FusionInput 类型中不存在 isH1/h1Classification/h1Rating 字段，
//   协调智能体组包时已剥离，本Agent从结构上接触不到H1标签
// - 权重只读，本Agent不得调整（退化信号的权重置零是既定融合
//   公式的一部分，属于规则而非自主决策）
//
// 融合规则（与前端 fusionResults 完全一致）：
//   1. 各信号 score 做 min-max 归一化
//   2. 退化信号（max-min < 1e-10）权重置零，剩余权重重新归一化
//   3. fusedScore = Σ(s_i·w_i) / Σw_i；全退化 → 0.5
// ============================================================
import { BaseAgent } from './base-agent';
import type { AgentMessage } from '@/communication/agent-protocol';
import { minMaxNormalize } from '@/lib/metrics';
import type { FusedPaperResult, LockedWeights } from '@/state/task-state';

/** 融合输入：注意此接口【不含任何H1标签字段】，从类型上隔离 */
interface FusionInput {
  s1: Array<{ pmid: string; score: number }>;
  s2: Array<{ pmid: string; score: number }>;
  s3: Array<{ pmid: string; score: number }>;
  s4: Array<{ pmid: string; score: number }>;
  weights: LockedWeights;
  taskPmids: string[];
}

function isDegenerate(scores: number[]): boolean {
  if (scores.length === 0) return true;
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  return max - min < 1e-10;
}

export class FusionAgent extends BaseAgent {
  readonly name = 'fusion_agent' as const;
  readonly displayName = '融合与验证智能体';
  readonly description = '四信号校验与锁定权重融合（不接触H1标签）';

  protected async onMessage(msg: AgentMessage): Promise<void> {
    if (msg.message_type !== 'FUSION_REQUEST') return;
    const { task_id: taskId } = msg;
    const input = msg.payload as FusionInput;

    this.beginTask(taskId, input.taskPmids.length, '校验四信号结果');
    const anomalies: string[] = [];

    // ---- 校验1：PMID 一致性 ----
    const taskSet = new Set(input.taskPmids);
    const signals = { s1: input.s1, s2: input.s2, s3: input.s3, s4: input.s4 } as const;
    for (const [key, arr] of Object.entries(signals)) {
      const pmidSet = new Set(arr.map((r) => r.pmid));
      const missing = input.taskPmids.filter((p) => !pmidSet.has(p));
      const extra = arr.filter((r) => !taskSet.has(r.pmid));
      if (missing.length > 0) {
        anomalies.push(
          `[${key}] 缺失 ${missing.length} 篇论文结果：${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' 等' : ''}`,
        );
      }
      if (extra.length > 0) {
        anomalies.push(`[${key}] 含 ${extra.length} 个任务外PMID，已忽略`);
      }
    }
    this.updateProgress(taskId, 1, 4, 'PMID一致性校验完成');

    // ---- 校验2：指标缺失与分值范围 ----
    for (const [key, arr] of Object.entries(signals)) {
      const invalid = arr.filter(
        (r) => typeof r.score !== 'number' || !Number.isFinite(r.score) || r.score < 0 || r.score > 1,
      );
      if (invalid.length > 0) {
        anomalies.push(
          `[${key}] ${invalid.length} 条结果分值缺失或越界（非[0,1]数值）：${invalid.slice(0, 3).map((r) => r.pmid).join(', ')}${invalid.length > 3 ? ' 等' : ''}`,
        );
      }
    }
    this.updateProgress(taskId, 2, 4, '分值范围校验完成');

    if (anomalies.length > 0) {
      this.send(taskId, 'orchestrator', 'FUSION_ANOMALY', 'warning', {
        agent: this.name,
        anomalies,
      });
    }

    // ---- 融合计算（既定规则，权重锁定只读）----
    const w = input.weights;
    const s1Scores = input.s1.map((r) => r.score);
    const s2Scores = input.s2.map((r) => r.score);
    const s3Scores = input.s3.map((r) => r.score);
    const s4Scores = input.s4.map((r) => r.score);

    const degenerate = {
      s1: isDegenerate(s1Scores),
      s2: isDegenerate(s2Scores),
      s3: isDegenerate(s3Scores),
      s4: isDegenerate(s4Scores),
    };
    const degenerateList = (Object.entries(degenerate) as Array<[string, boolean]>)
      .filter(([, v]) => v)
      .map(([k]) => k.toUpperCase());
    if (degenerateList.length > 0) {
      anomalies.push(`退化信号（无区分度，权重按规则置零）：${degenerateList.join(', ')}`);
    }

    const normMaps = new Map<string, { s1: number; s2: number; s3: number; s4: number }>();
    const ensure = (pmid: string) => {
      let e = normMaps.get(pmid);
      if (!e) {
        e = { s1: 0, s2: 0, s3: 0, s4: 0 };
        normMaps.set(pmid, e);
      }
      return e;
    };

    const fill = (arr: Array<{ pmid: string; score: number }>, key: 's1' | 's2' | 's3' | 's4', deg: boolean) => {
      if (deg) return;
      const normalized = minMaxNormalize(arr.map((r) => r.score));
      arr.forEach((r, i) => {
        ensure(r.pmid)[key] = normalized[i];
      });
    };
    fill(input.s1, 's1', degenerate.s1);
    fill(input.s2, 's2', degenerate.s2);
    fill(input.s3, 's3', degenerate.s3);
    fill(input.s4, 's4', degenerate.s4);
    this.updateProgress(taskId, 3, 4, '归一化完成，加权融合中');

    // 退化信号权重置零，剩余重新归一化（既定公式）
    let w1 = degenerate.s1 ? 0 : w.signal1;
    let w2 = degenerate.s2 ? 0 : w.signal2;
    let w3 = degenerate.s3 ? 0 : w.signal3;
    let w4 = degenerate.s4 ? 0 : w.signal4;
    const wSum = w1 + w2 + w3 + w4;

    const fusedResults: FusedPaperResult[] = Array.from(normMaps.entries()).map(([pmid, sc]) => ({
      pmid,
      fusedScore: wSum === 0 ? 0.5 : (sc.s1 * w1 + sc.s2 * w2 + sc.s3 * w3 + sc.s4 * w4) / wSum,
      s1Norm: sc.s1,
      s2Norm: sc.s2,
      s3Norm: sc.s3,
      s4Norm: sc.s4,
    }));
    fusedResults.sort((a, b) => b.fusedScore - a.fusedScore);
    this.updateProgress(taskId, 4, 4, '融合完成');

    this.send(taskId, 'orchestrator', 'FUSION_COMPLETED', 'success', {
      fusedResults,
      weightsUsed: { w1, w2, w3, w4 },
      degenerateSignals: degenerateList,
      anomalies,
    });
    this.setStatus(taskId, 'COMPLETED');
    this.currentTaskId = null;
  }
}
