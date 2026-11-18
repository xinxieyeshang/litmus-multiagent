// ============================================================
// Agent 3：知识网络智能体
// 工具：signal3-tool（TF-IDF + TextRank → 二分网络 → 采样Brandes）
//
// 自主决策范围：
// - 判断关键词抽取质量（平均关键词数过低 → 异常报告）
// - 检查网络结构健康度（孤立节点比例、异常稀疏）
// - 计算异常时受控重试一次
// - 汇报网络规模与计算状态
// 禁止：修改抽取算法、topK参数、投影规则、Brandes采样参数
// ============================================================
import { BaseAgent } from './base-agent';
import type { AgentMessage, QualityCheck } from '@/communication/agent-protocol';
import { runSignal3, type S3ToolOutput } from '@/tools/signal3-tool';
import type { TaskPaper } from '@/state/task-state';

export class Signal3Agent extends BaseAgent {
  readonly name = 'signal3_agent' as const;
  readonly displayName = '知识网络智能体';
  readonly description = '关键词二分网络桥梁性（TF-IDF+TextRank+Brandes中介中心性）';

  protected async onMessage(msg: AgentMessage): Promise<void> {
    if (msg.message_type !== 'TASK_ASSIGNED') return;
    const { task_id: taskId } = msg;
    const payload = msg.payload as { papers: TaskPaper[]; topK?: number };

    const papers = payload.papers;
    const topK = payload.topK ?? 15;
    this.beginTask(taskId, papers.length, `构建知识网络（topK=${topK}）`);

    let output: S3ToolOutput;
    try {
      output = await runSignal3(papers, topK);
      this.updateProgress(taskId, papers.length, papers.length, '网络计算完成');
    } catch (err) {
      // 受控重试一次
      this.reportRetry(taskId, `网络计算首次失败: ${err instanceof Error ? err.message : String(err)}`, 'signal3 全量');
      try {
        output = await runSignal3(papers, topK);
      } catch (err2) {
        this.failTask(taskId, `知识网络计算重试后仍失败: ${err2 instanceof Error ? err2.message : String(err2)}`);
        return;
      }
    }

    const { results, stats } = output;

    // ---- 质检1：关键词抽取质量 ----
    if (stats.avgKeywordCount < 3) {
      this.reportAnomaly(
        taskId,
        'LOW_KEYWORD_QUALITY',
        `平均每篇仅提取 ${stats.avgKeywordCount.toFixed(1)} 个关键词（预设质量条件 ≥3），文本可能过短或停用词占比过高`,
      );
    }

    // ---- 质检2：网络结构健康度（孤立节点/异常稀疏）----
    const zeroRatio = stats.zeroBetweennessCount / stats.totalPapers;
    if (zeroRatio > 0.95) {
      this.reportAnomaly(
        taskId,
        'NETWORK_TOO_SPARSE',
        `网络异常稀疏：${stats.zeroBetweennessCount}/${stats.totalPapers} 篇论文中介中心性为0（孤立节点占 ${(zeroRatio * 100).toFixed(1)}%），桥梁性区分度不足`,
      );
    }
    if (stats.maxBetweenness === 0) {
      this.reportAnomaly(
        taskId,
        'DEGENERATE_NETWORK',
        '全部论文中介中心性为0，网络退化为无桥结构，本信号将无法提供区分度',
      );
    }

    // ---- 质检3：分值范围 ----
    const outOfRange = results.filter(
      (r) => typeof r.score !== 'number' || r.score < 0 || r.score > 1,
    );

    const checks: QualityCheck[] = [
      {
        name: '关键词抽取质量',
        passed: stats.avgKeywordCount >= 3,
        detail: `平均每篇 ${stats.avgKeywordCount.toFixed(1)} 个关键词，共 ${stats.totalKeywords} 个唯一词干`,
      },
      {
        name: '网络结构健康度',
        passed: zeroRatio <= 0.95 && stats.maxBetweenness > 0,
        detail: `孤立节点 ${(zeroRatio * 100).toFixed(1)}%，最大中介中心性 ${stats.maxBetweenness.toFixed(0)}`,
      },
      {
        name: '分值范围校验',
        passed: outOfRange.length === 0,
        detail: outOfRange.length === 0 ? '全部 score ∈ [0,1]' : `${outOfRange.length} 篇分值越界`,
      },
    ];

    this.completeTask(taskId, {
      results,
      stats,
      checks,
    });
  }
}
