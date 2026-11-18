// ============================================================
// Agent 1：影响力评价智能体
// 工具：signal1-tool（豆包模型 + F1000Prime 五维评价 prompt）
//
// 自主决策范围（仅限于此）：
// - 前置识别摘要缺失/文本异常 → 标记失败并上报，不浪费 LLM 调用
// - 评分结果 JSON 结构校验（score范围、五维字段齐全）
// - LLM 调用失败的论文 → 自主决定追加一轮重试
// - 仍失败 → 保留工具兜底分，标记失败，如实上报协调智能体
// 禁止：修改 prompt、模型、温度、评分公式
// ============================================================
import { BaseAgent } from './base-agent';
import type { AgentMessage, QualityCheck } from '@/communication/agent-protocol';
import { runSignal1Batch, s1FallbackResult, type S1ToolResult } from '@/tools/signal1-tool';
import type { TaskPaper } from '@/state/task-state';

const MIN_ABSTRACT_LEN = 50;

export class Signal1Agent extends BaseAgent {
  readonly name = 'signal1_agent' as const;
  readonly displayName = '影响力评价智能体';
  readonly description = 'LLM五维影响力评分（豆包模型 + F1000Prime标准）';

  protected async onMessage(msg: AgentMessage): Promise<void> {
    if (msg.message_type !== 'TASK_ASSIGNED') return;
    const { task_id: taskId } = msg;
    const payload = msg.payload as {
      papers: TaskPaper[];
      model?: string;
      temperature?: number;
      batchSize?: number;
    };

    const papers = payload.papers;
    this.beginTask(taskId, papers.length, '初始化影响力评价');

    // ---- 前置质检：识别摘要缺失/文本异常 ----
    const validPapers: TaskPaper[] = [];
    const invalidResults: S1ToolResult[] = [];
    for (const p of papers) {
      const abstract = (p.abstract || '').trim();
      if (!abstract || abstract.length < MIN_ABSTRACT_LEN) {
        invalidResults.push(
          s1FallbackResult(p.pmid, new Error('摘要缺失或过短，无法进行影响力评价')),
        );
      } else {
        validPapers.push(p);
      }
    }
    if (invalidResults.length > 0) {
      this.reportAnomaly(
        taskId,
        'MISSING_ABSTRACT',
        `${invalidResults.length} 篇论文摘要缺失或过短（<${MIN_ABSTRACT_LEN}字符），已标记为失败：${invalidResults
          .slice(0, 5)
          .map((r) => r.pmid)
          .join(', ')}${invalidResults.length > 5 ? ' 等' : ''}`,
      );
    }

    // ---- 执行 LLM 评分（分批，批内8路并发）----
    const batchSize = payload.batchSize ?? 50;
    const allResults: S1ToolResult[] = [...invalidResults];
    const retryQueue: TaskPaper[] = [];
    const retryReasons = new Map<string, string>();
    let processed = 0;

    try {
      for (let i = 0; i < validPapers.length; i += batchSize) {
        const batch = validPapers.slice(i, i + batchSize);
        const batchResults = await runSignal1Batch(batch, {
          model: payload.model,
          temperature: payload.temperature,
          onPaperDone: (_r, _done, _total) => {
            processed++;
            this.updateProgress(
              taskId,
              processed,
              validPapers.length,
              `LLM评分中 ${processed}/${validPapers.length}`,
            );
          },
        });

        // ---- 结果质检：JSON结构校验 ----
        for (const r of batchResults) {
          const structureOk =
            typeof r.score === 'number' &&
            r.score >= 0 &&
            r.score <= 1 &&
            r.innovationTypes &&
            ['newFinding', 'technicalAdvance', 'interestingHypothesis', 'novelDrugTarget', 'confirmation'].every(
              (k) => typeof (r.innovationTypes as Record<string, unknown>)[k] === 'number',
            );
          if (r.llmFailed) {
            retryQueue.push(batch.find((p) => p.pmid === r.pmid)!);
            retryReasons.set(r.pmid, r.reasoning);
          } else if (!structureOk) {
            retryQueue.push(batch.find((p) => p.pmid === r.pmid)!);
            retryReasons.set(r.pmid, 'JSON结构校验未通过（score越界或维度字段缺失）');
          } else {
            allResults.push(r);
          }
        }
      }
    } catch (err) {
      this.failTask(taskId, `LLM评分批次执行失败: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // ---- 自主决策：对失败/校验未通过的论文追加一轮重试 ----
    let retriedOk = 0;
    if (retryQueue.length > 0) {
      this.reportRetry(
        taskId,
        `${retryQueue.length} 篇论文LLM调用失败或结构校验未通过，执行追加重试`,
        retryQueue.slice(0, 5).map((p) => p.pmid).join(', ') + (retryQueue.length > 5 ? ' 等' : ''),
      );
      const retried = await runSignal1Batch(retryQueue, {
        model: payload.model,
        temperature: payload.temperature,
      }).catch(() => null);

      const stillFailed: string[] = [];
      for (let i = 0; i < retryQueue.length; i++) {
        const r = retried?.[i];
        if (r && !r.llmFailed) {
          allResults.push(r);
          retriedOk++;
        } else {
          stillFailed.push(retryQueue[i].pmid);
          allResults.push(
            s1FallbackResult(retryQueue[i].pmid, new Error(retryReasons.get(retryQueue[i].pmid) || '重试仍失败')),
          );
        }
      }
      if (stillFailed.length > 0) {
        this.reportAnomaly(
          taskId,
          'LLM_FINAL_FAILED',
          `${stillFailed.length} 篇论文重试后仍失败，已按工具兜底规则标记失败（score=0.3）：${stillFailed.slice(0, 5).join(', ')}${stillFailed.length > 5 ? ' 等' : ''}`,
        );
      }
    }

    // ---- 汇总质检报告 ----
    const llmFailedCount = allResults.filter((r) => r.llmFailed).length;
    const checks: QualityCheck[] = [
      {
        name: 'JSON结构校验',
        passed: allResults.every(
          (r) => typeof r.score === 'number' && r.score >= 0 && r.score <= 1,
        ),
        detail: `全部 ${allResults.length} 篇结果 score ∈ [0,1]`,
      },
      {
        name: '摘要完整性检查',
        passed: invalidResults.length === 0,
        detail: invalidResults.length === 0 ? '全部论文摘要有效' : `${invalidResults.length} 篇摘要缺失/过短`,
      },
      {
        name: 'LLM调用成功率',
        passed: llmFailedCount / allResults.length < 0.1,
        detail: `${allResults.length - llmFailedCount}/${allResults.length} 成功（${llmFailedCount} 篇失败标记），重试挽回 ${retriedOk} 篇`,
      },
    ];

    this.completeTask(taskId, {
      results: allResults,
      stats: {
        total: allResults.length,
        llmFailedCount,
        invalidAbstractCount: invalidResults.length,
        retriedOk,
      },
      checks,
    });
  }
}
