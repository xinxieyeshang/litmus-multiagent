// ============================================================
// Agent 4：认知新颖性智能体
// 工具：signal4-tool（Embedding语义偏离 + 低频MeSH概念频率 双分支）
//
// 自主决策范围：
// - 检查 Embedding 维度一致性与缺失向量清单
// - 检查语义偏离度计算是否成功（全失败则标记任务失败）
// - 检查低频MeSH词统计有效性
// - 缺失率超阈值发出异常报告
// 禁止：修改双分支公式、0.5/0.5组合权重、低频阈值规则
// ============================================================
import { BaseAgent } from './base-agent';
import type { AgentMessage, QualityCheck } from '@/communication/agent-protocol';
import { runSignal4, type S4ToolOutput } from '@/tools/signal4-tool';
import type { TaskPaper } from '@/state/task-state';

const EMBEDDING_FAIL_RATE_ALERT = 0.1;

export class Signal4Agent extends BaseAgent {
  readonly name = 'signal4_agent' as const;
  readonly displayName = '认知新颖性智能体';
  readonly description = '认知偏离度（Embedding内部相对法 + MeSH概念频率法）';

  protected async onMessage(msg: AgentMessage): Promise<void> {
    if (msg.message_type !== 'TASK_ASSIGNED') return;
    const { task_id: taskId } = msg;
    const payload = msg.payload as { papers: TaskPaper[]; batchSize?: number };

    const papers = payload.papers;
    this.beginTask(taskId, papers.length, '生成Embedding向量');

    let output: S4ToolOutput;
    try {
      output = await runSignal4(papers, {
        batchSize: payload.batchSize ?? 50,
        onBatchDone: (done, total) => {
          this.updateProgress(taskId, done, total, `Embedding生成中 ${done}/${total}`);
        },
      });
    } catch (err) {
      this.reportRetry(taskId, `首次执行失败: ${err instanceof Error ? err.message : String(err)}`, 'signal4 全量');
      try {
        output = await runSignal4(papers, { batchSize: payload.batchSize ?? 50 });
      } catch (err2) {
        this.failTask(taskId, `认知新颖性计算重试后仍失败: ${err2 instanceof Error ? err2.message : String(err2)}`);
        return;
      }
    }

    const { results, summary } = output;

    // ---- 质检1：Embedding 完整性 ----
    if (summary.embeddingDim === 0) {
      this.failTask(taskId, '全部论文Embedding生成失败，语义偏离度分支不可用');
      return;
    }
    const failedPmids = results.filter((r) => r.embeddingFailed).map((r) => r.pmid);
    const failRate = summary.embeddingFailedCount / summary.totalPapers;
    if (summary.embeddingFailedCount > 0) {
      this.reportAnomaly(
        taskId,
        'EMBEDDING_MISSING',
        `${summary.embeddingFailedCount}/${summary.totalPapers} 篇Embedding生成失败（${(failRate * 100).toFixed(1)}%），这些论文语义偏离度按工具规则记为1：${failedPmids.slice(0, 5).join(', ')}${failedPmids.length > 5 ? ' 等' : ''}`,
      );
    }
    if (failRate > EMBEDDING_FAIL_RATE_ALERT) {
      this.reportAnomaly(
        taskId,
        'EMBEDDING_HIGH_FAIL_RATE',
        `Embedding失败率 ${(failRate * 100).toFixed(1)}% 超过阈值 ${EMBEDDING_FAIL_RATE_ALERT * 100}%，语义偏离度分支置信度降低`,
      );
    }

    // ---- 质检2：双分支有效性 ----
    const semanticValues = results.map((r) => r.semanticDeviation);
    const semanticValid = semanticValues.every((v) => typeof v === 'number' && Number.isFinite(v));
    const conceptValid = results.every(
      (r) => typeof r.conceptRarity === 'number' && r.conceptRarity >= 0 && r.conceptRarity <= 1,
    );

    const checks: QualityCheck[] = [
      {
        name: 'Embedding维度一致性',
        passed: summary.embeddingDim > 0,
        detail: `向量维度 ${summary.embeddingDim}，失败 ${summary.embeddingFailedCount} 篇`,
      },
      {
        name: '语义偏离度分支',
        passed: semanticValid,
        detail: `内部相对法 avgSim 均值向量恒等式计算完成`,
      },
      {
        name: '概念频率分支',
        passed: conceptValid && summary.uniqueMeshTerms > 0,
        detail: `唯一MeSH词 ${summary.uniqueMeshTerms} 个，中位频次 ${summary.medianFreq}`,
      },
      {
        name: '分值范围校验',
        passed: results.every((r) => r.noveltyScore >= 0 && r.noveltyScore <= 1),
        detail: `noveltyScore = 0.5×语义偏离 + 0.5×概念罕见度`,
      },
    ];

    this.completeTask(taskId, {
      results,
      summary,
      checks,
      branches: {
        semanticDeviation: results.map((r) => ({ pmid: r.pmid, value: r.semanticDeviation })),
        conceptRarity: results.map((r) => ({ pmid: r.pmid, value: r.conceptRarity })),
      },
    });
  }
}
