// ============================================================
// Agent 2：MeSH领域智能体
// 工具：signal2-tool（NLM官方树状编号API + 本地关键词回退）
//
// 自主决策范围：
// - 判断官方本体查询覆盖率，低覆盖时确认回退策略已生效并上报
// - 低置信度结果（覆盖率<30%）发出异常报告
// - 分值范围校验，异常时受控重试一次
// 禁止：修改领域分类规则、评分公式、0.25兜底分
// ============================================================
import { BaseAgent } from './base-agent';
import type { AgentMessage, QualityCheck } from '@/communication/agent-protocol';
import { runSignal2, type S2ToolOutput } from '@/tools/signal2-tool';
import type { TaskPaper } from '@/state/task-state';

const LOW_COVERAGE_THRESHOLD = 0.3;

export class Signal2Agent extends BaseAgent {
  readonly name = 'signal2_agent' as const;
  readonly displayName = 'MeSH领域智能体';
  readonly description = 'MeSH主题广度与跨域性（NLM官方本体 + 本地回退）';

  protected async onMessage(msg: AgentMessage): Promise<void> {
    if (msg.message_type !== 'TASK_ASSIGNED') return;
    const { task_id: taskId } = msg;
    const payload = msg.payload as { papers: TaskPaper[] };

    const papers = payload.papers;
    this.beginTask(taskId, papers.length, '查询MeSH官方本体并计算领域广度');

    let output: S2ToolOutput;
    try {
      output = await runSignal2(papers);
      this.updateProgress(taskId, papers.length, papers.length, '领域广度计算完成');
    } catch (err) {
      // 受控重试一次
      this.reportRetry(taskId, `首次执行失败: ${err instanceof Error ? err.message : String(err)}`, 'signal2 全量');
      try {
        output = await runSignal2(papers);
      } catch (err2) {
        this.failTask(taskId, `MeSH领域计算重试后仍失败: ${err2 instanceof Error ? err2.message : String(err2)}`);
        return;
      }
    }

    const { results, treeNumberStats } = output;

    // ---- 质检1：官方本体覆盖率 ----
    if (treeNumberStats.coverage < LOW_COVERAGE_THRESHOLD) {
      this.reportFallback(
        taskId,
        `NLM官方本体覆盖率仅 ${(treeNumberStats.coverage * 100).toFixed(1)}%（${treeNumberStats.termsFoundInMesh}/${treeNumberStats.totalUniqueTerms}），置信度低`,
        '本地关键词匹配分类',
      );
      this.reportAnomaly(
        taskId,
        'LOW_CONFIDENCE',
        `MeSH官方分类覆盖率 ${(treeNumberStats.coverage * 100).toFixed(1)}% 低于阈值 ${LOW_COVERAGE_THRESHOLD * 100}%，大部分词走本地回退分类，结果置信度降低`,
      );
    }

    // ---- 质检2：无MeSH论文占比 ----
    const noMeshCount = results.filter((r) => !r.hasMesh).length;
    if (noMeshCount / results.length > 0.5) {
      this.reportAnomaly(
        taskId,
        'HIGH_NO_MESH_RATIO',
        `${noMeshCount}/${results.length} 篇论文无MeSH词（${((noMeshCount / results.length) * 100).toFixed(1)}%），均按固定0.25分处理`,
      );
    }

    // ---- 质检3：分值范围 ----
    const outOfRange = results.filter((r) => typeof r.score !== 'number' || r.score < 0 || r.score > 1);

    const checks: QualityCheck[] = [
      {
        name: '官方本体覆盖率',
        passed: treeNumberStats.coverage >= LOW_COVERAGE_THRESHOLD,
        detail: `${(treeNumberStats.coverage * 100).toFixed(1)}%（${treeNumberStats.termsFoundInMesh}/${treeNumberStats.totalUniqueTerms} 词命中），来源：${treeNumberStats.source === 'mesh-api' ? 'NLM官方API' : '本地回退'}`,
      },
      {
        name: '分值范围校验',
        passed: outOfRange.length === 0,
        detail: outOfRange.length === 0 ? '全部 score ∈ [0,1]' : `${outOfRange.length} 篇分值越界`,
      },
      {
        name: 'MeSH数据完整性',
        passed: noMeshCount / results.length <= 0.5,
        detail: `${results.length - noMeshCount}/${results.length} 篇含MeSH词`,
      },
    ];

    this.completeTask(taskId, {
      results,
      treeNumberStats,
      checks,
    });
  }
}
