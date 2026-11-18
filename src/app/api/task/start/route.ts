import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';

// ============================================================================
// 后台任务启动 API
// 启动批量处理任务，立即返回任务ID，任务在后台继续执行
// ============================================================================

interface StartTaskRequest {
  signalType: 'signal1' | 'signal2' | 'signal3' | 'signal4' | 'all';
  papers: Array<{
    pmid: string;
    title: string;
    abstract: string;
    meshTerms?: string[];
    year?: string;
    paperType?: string;
    isH1?: boolean;
    h1Classification?: string[];
    h1Rating?: string;
  }>;
  batchSize?: number;
  llmModel?: string;
  llmTemperature?: string;
  paperFileName?: string;
  h1FileName?: string;
}

// 后台任务处理器 - 在后台执行，不阻塞响应
async function executeBackgroundTask(taskId: string, request: StartTaskRequest) {
  const client = getSupabaseClient();
  
  try {
    // 更新任务状态为 running
    await client
      .from('background_tasks')
      .update({ 
        status: 'running', 
        started_at: new Date().toISOString(),
        progress: 0 
      })
      .eq('id', taskId);

    // 根据信号类型调用对应的处理函数
    const signalType = request.signalType;
    const papers = request.papers;
    const batchSize = request.batchSize || 5;
    const totalPapers = papers.length;

    // 处理信号
    if (signalType === 'all') {
      // 处理所有信号
      for (const sig of ['signal1', 'signal2', 'signal3', 'signal4'] as const) {
        await processSignal(taskId, sig, papers, batchSize, request.llmModel, request.llmTemperature);
      }
    } else {
      await processSignal(taskId, signalType, papers, batchSize, request.llmModel, request.llmTemperature);
    }

    // 更新任务状态为 completed
    await client
      .from('background_tasks')
      .update({ 
        status: 'completed', 
        completed_at: new Date().toISOString(),
        progress: 100 
      })
      .eq('id', taskId);

    console.log(`[task] Task ${taskId} completed successfully`);
  } catch (error) {
    console.error(`[task] Task ${taskId} failed:`, error);
    
    // 更新任务状态为 failed
    await client
      .from('background_tasks')
      .update({ 
        status: 'failed', 
        error_message: String(error),
        completed_at: new Date().toISOString()
      })
      .eq('id', taskId);
  }
}

// 处理单个信号
async function processSignal(
  taskId: string,
  signalType: 'signal1' | 'signal2' | 'signal3' | 'signal4',
  papers: StartTaskRequest['papers'],
  batchSize: number,
  llmModel?: string,
  llmTemperature?: string
) {
  const client = getSupabaseClient();
  const baseUrl = process.env.DEPLOY_RUN_PORT ? 
    `http://localhost:${process.env.DEPLOY_RUN_PORT}` : 
    'http://localhost:5000';

  const totalPapers = papers.length;
  let processedPapers = 0;

  // 分批处理
  for (let i = 0; i < totalPapers; i += batchSize) {
    // 检查任务是否被取消
    const { data: task } = await client
      .from('background_tasks')
      .select('status')
      .eq('id', taskId)
      .maybeSingle();
    
    if (task?.status === 'cancelled') {
      console.log(`[task] Task ${taskId} was cancelled`);
      return;
    }

    const batch = papers.slice(i, i + batchSize);
    
    // 调用对应的信号 API
    const requestBody = buildRequestBody(signalType, batch, llmModel, llmTemperature);
    
    try {
      const response = await fetch(`${baseUrl}/api/${signalType}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const data = await response.json();
      
      // 存储结果到数据库
      const results = data.results || [];
      for (const result of results) {
        await client
          .from('task_results')
          .insert({
            task_id: taskId,
            pmid: result.pmid,
            signal_type: signalType,
            result_data: result,
            score: result.score ? Math.round(result.score * 100) : null,
          });
      }

      processedPapers += batch.length;
      
      // 更新进度
      const progress = Math.round((processedPapers / totalPapers) * 100);
      await client
        .from('background_tasks')
        .update({ 
          progress,
          processed_papers: processedPapers
        })
        .eq('id', taskId);

      console.log(`[task] ${signalType}: processed ${processedPapers}/${totalPapers} papers (${progress}%)`);
    } catch (error) {
      console.error(`[task] Batch ${i}-${i + batchSize} failed:`, error);
      // 继续处理下一批，不中断整个任务
    }
  }

  // 计算指标
  await calculateMetrics(taskId, signalType, papers);
}

// 构建请求体
function buildRequestBody(
  signalType: string,
  batch: StartTaskRequest['papers'],
  llmModel?: string,
  llmTemperature?: string
) {
  switch (signalType) {
    case 'signal1':
      return {
        papers: batch.map(p => ({ pmid: p.pmid, title: p.title, abstract: p.abstract })),
        model: llmModel || 'doubao-seed-2-0-lite-260215',
        temperature: parseFloat(llmTemperature || '0.3'),
      };
    case 'signal2':
      return {
        papers: batch.map(p => ({ pmid: p.pmid, meshTerms: p.meshTerms || [] })),
      };
    case 'signal3':
      return {
        papers: batch.map(p => ({ pmid: p.pmid, title: p.title, abstract: p.abstract })),
        topKeywords: 15,
      };
    case 'signal4':
      return {
        papers: batch.map(p => ({ pmid: p.pmid, title: p.title, abstract: p.abstract })),
        batchSize: 5,
      };
    default:
      return { papers: batch };
  }
}

// 计算指标
async function calculateMetrics(
  taskId: string,
  signalType: string,
  papers: StartTaskRequest['papers']
) {
  const client = getSupabaseClient();
  
  // 获取结果
  const { data: results } = await client
    .from('task_results')
    .select('pmid, score')
    .eq('task_id', taskId)
    .eq('signal_type', signalType);
  
  if (!results || results.length === 0) return;

  // 计算基本指标
  const h1Papers = papers.filter(p => p.isH1);
  const h1PmidSet = new Set(h1Papers.map(p => p.pmid));
  
  // 按 score 排序
  const sortedResults = (results as Array<{ pmid: string; score: number | null }>)
    .filter(r => r.score !== null)
    .map(r => ({ pmid: r.pmid, score: r.score as number }))
    .sort((a, b) => b.score - a.score);

  // 计算 Precision@K
  const precisionAtK: Record<number, number> = {};
  const ks = [5, 10, 20, 50];
  for (const k of ks) {
    const topK = sortedResults.slice(0, k);
    const h1InTopK = topK.filter(r => h1PmidSet.has(r.pmid)).length;
    precisionAtK[k] = h1InTopK / k;
  }

  // 计算 AUC (简化计算)
  const auc = calculateAUC(sortedResults, h1PmidSet);

  // 计算 Cohen's d
  const h1Scores = sortedResults.filter(r => h1PmidSet.has(r.pmid)).map(r => r.score || 0);
  const nonH1Scores = sortedResults.filter(r => !h1PmidSet.has(r.pmid)).map(r => r.score || 0);
  const cohensD = calculateCohensD(h1Scores, nonH1Scores);

  // 存储指标
  await client
    .from('task_metrics')
    .insert({
      task_id: taskId,
      signal_type: signalType,
      auc: Math.round(auc * 100),
      precision_at_k: precisionAtK,
      cohens_d: Math.round(cohensD * 100),
      h1_count: h1Papers.length,
      total_count: papers.length,
    });
}

// 计算 AUC
function calculateAUC(
  sortedResults: Array<{ pmid: string; score: number }>,
  h1PmidSet: Set<string>
): number {
  const h1Count = sortedResults.filter(r => h1PmidSet.has(r.pmid)).length;
  const nonH1Count = sortedResults.length - h1Count;
  
  if (h1Count === 0 || nonH1Count === 0) return 0.5;
  
  let aucSum = 0;
  let h1RankSum = 0;
  
  for (let i = 0; i < sortedResults.length; i++) {
    if (h1PmidSet.has(sortedResults[i].pmid)) {
      h1RankSum += i + 1;
    }
  }
  
  aucSum = h1RankSum - (h1Count * (h1Count + 1)) / 2;
  return aucSum / (h1Count * nonH1Count);
}

// 计算 Cohen's d
function calculateCohensD(h1Scores: number[], nonH1Scores: number[]): number {
  if (h1Scores.length === 0 || nonH1Scores.length === 0) return 0;
  
  const h1Mean = h1Scores.reduce((a, b) => a + b, 0) / h1Scores.length;
  const nonH1Mean = nonH1Scores.reduce((a, b) => a + b, 0) / nonH1Scores.length;
  
  const h1Var = h1Scores.reduce((a, b) => a + Math.pow(b - h1Mean, 2), 0) / h1Scores.length;
  const nonH1Var = nonH1Scores.reduce((a, b) => a + Math.pow(b - nonH1Mean, 2), 0) / nonH1Scores.length;
  
  const pooledStd = Math.sqrt((h1Var + nonH1Var) / 2);
  
  if (pooledStd === 0) return 0;
  return (h1Mean - nonH1Mean) / pooledStd;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as StartTaskRequest;
    
    if (!body.signalType || !body.papers || body.papers.length === 0) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const client = getSupabaseClient();

    // 创建任务记录
    const { data: task, error: taskError } = await client
      .from('background_tasks')
      .insert({
        signal_type: body.signalType,
        status: 'pending',
        total_papers: body.papers.length,
        batch_size: body.batchSize || 5,
        llm_model: body.llmModel,
        llm_temperature: body.llmTemperature,
        paper_file_name: body.paperFileName,
        h1_file_name: body.h1FileName,
      })
      .select()
      .maybeSingle();

    if (taskError || !task) {
      throw new Error(`Failed to create task: ${taskError?.message}`);
    }

    const taskId = (task as { id: string }).id;

    // 存储论文数据到缓存表
    const paperInserts = body.papers.map(p => ({
      task_id: taskId,
      pmid: p.pmid,
      title: p.title,
      abstract: p.abstract,
      mesh_terms: p.meshTerms || [],
      year: p.year,
      paper_type: p.paperType,
      is_h1: p.isH1 || false,
      h1_classification: p.h1Classification || [],
      h1_rating: p.h1Rating,
    }));

    // 分批插入（避免一次性插入过多数据）
    const batchSize = 100;
    for (let i = 0; i < paperInserts.length; i += batchSize) {
      const batch = paperInserts.slice(i, i + batchSize);
      const { error: insertError } = await client
        .from('paper_cache')
        .insert(batch);
      
      if (insertError) {
        console.error(`[task] Failed to insert papers batch ${i}:`, insertError);
      }
    }

    // 启动后台任务（不阻塞响应）
    // 使用 void 表示我们不等待这个 Promise 完成
    void executeBackgroundTask(taskId, body);

    console.log(`[task] Started task ${taskId} for ${body.papers.length} papers`);

    return NextResponse.json({
      taskId,
      status: 'pending',
      totalPapers: body.papers.length,
      message: 'Task started successfully. Use /api/task/status to check progress.',
    });
  } catch (error) {
    console.error('[task/start] Error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: String(error) },
      { status: 500 }
    );
  }
}