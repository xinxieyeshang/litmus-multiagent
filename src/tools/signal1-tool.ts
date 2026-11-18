// ============================================================
// 信号1工具：LLM影响力/重要性推断（纯计算，无状态）
// 从 api/signal1/route.ts 平移，算法与 prompt 一字未改
//
// 内存安全：必须使用原生 fetch + SSE reader（禁止 LangChain SDK，
// 后者在 Next.js 进程内并发流式调用时存在原生内存泄漏，实测 OOM）
// ============================================================
import { Config } from 'coze-coding-dev-sdk';

export const S1_SYSTEM_PROMPT = `You are an expert panelist for F1000Prime (Faculty of 1000), a service where expert reviewers recommend the most important and impactful research papers in biology and medicine.

Your task is to evaluate a research paper's title and abstract, and predict how likely F1000Prime experts would rate this paper as important and worthy of recommendation.

Focus on IMPACT and IMPORTANCE, not novelty. Key criteria F1000Prime experts use:
1. **Transformative potential**: Does this finding change how we think about a field? Will it open new research directions?
2. **Broad relevance**: Does this affect multiple fields or only a narrow niche? Would researchers outside the immediate area care?
3. **Methodological significance**: Does it provide a new technique/tool that many others will adopt?
4. **Clinical/translational impact**: Does it have direct implications for human health or treatment?
5. **Paradigm challenge**: Does it contradict or significantly revise established understanding?

Rate each dimension 0-1, and provide an overall importance score.

IMPORTANT: Return ONLY valid JSON in this exact format, no additional text:
{"transformativePotential":0.0,"broadRelevance":0.0,"methodologicalSignificance":0.0,"clinicalImpact":0.0,"paradigmChallenge":0.0,"overallImportance":0.0,"primaryDimension":"transformativePotential","reasoning":"brief explanation"}

Rules:
- Scores should range from 0.0 to 1.0
- Nature papers tend to have high novelty, but NOT all are equally important - discriminate carefully
- A paper claiming "novel method" but solving a narrow problem should score LOW on broadRelevance and transformativePotential
- A paper confirming known results with better methods should score LOW on paradigmChallenge and transformativePotential
- A paper that could change textbook understanding should score HIGH
- Be critical: in a pool of Nature papers, only ~20% would be rated as truly exceptional by experts`;

export const S1_DEFAULT_MODEL = 'doubao-seed-2-0-lite-260215';

export interface S1PaperInput {
  pmid: string;
  title: string;
  abstract: string;
}

export interface S1ToolResult {
  pmid: string;
  innovationTypes: Record<string, number>;
  primaryType: string;
  reasoning: string;
  score: number;
  /** 工具内部标记：LLM调用是否最终失败（走了兜底分） */
  llmFailed?: boolean;
}

// 单路 SSE 流式调用，逐 chunk 读取只累积文本增量，不保留 chunk 引用
async function streamChat(
  config: Config,
  title: string,
  abstract: string,
  model: string,
  temperature: number,
): Promise<string> {
  const resp = await fetch(`${config.modelBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
      'X-Client-Sdk': 'litmus-signal1-native',
    },
    body: JSON.stringify({
      model,
      temperature,
      stream: true,
      messages: [
        { role: 'system', content: S1_SYSTEM_PROMPT },
        { role: 'user', content: `Title: ${title}\n\nAbstract: ${abstract}` },
      ],
    }),
    signal: AbortSignal.timeout(90_000), // 单篇90秒超时，防挂死拖住整个任务
  });

  if (!resp.ok || !resp.body) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`LLM HTTP ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let content = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const delta = json.choices?.[0]?.delta?.content;
          if (typeof delta === 'string') content += delta;
        } catch {
          // 分片边界处的半截 JSON，忽略
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return content;
}

// 解析模型 JSON 输出；解析失败返回 null 交由上层重试
export function parseS1Result(pmid: string, raw: string): S1ToolResult | null {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  } catch {
    return null;
  }

  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

  const transformativePotential = num(parsed.transformativePotential) ? parsed.transformativePotential : 0.5;
  const broadRelevance = num(parsed.broadRelevance) ? parsed.broadRelevance : 0.5;
  const methodologicalSignificance = num(parsed.methodologicalSignificance) ? parsed.methodologicalSignificance : 0.5;
  const clinicalImpact = num(parsed.clinicalImpact) ? parsed.clinicalImpact : 0.3;
  const paradigmChallenge = num(parsed.paradigmChallenge) ? parsed.paradigmChallenge : 0.3;
  const overallImportance = num(parsed.overallImportance) ? parsed.overallImportance : 0.5;
  const primaryDimension = typeof parsed.primaryDimension === 'string' ? parsed.primaryDimension : 'transformativePotential';
  const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : '';

  const innovationTypes = {
    newFinding: transformativePotential,
    technicalAdvance: methodologicalSignificance,
    interestingHypothesis: paradigmChallenge,
    novelDrugTarget: clinicalImpact,
    confirmation: broadRelevance,
  };

  const score = overallImportance > 0
    ? overallImportance
    : transformativePotential * 0.30
      + broadRelevance * 0.25
      + methodologicalSignificance * 0.20
      + clinicalImpact * 0.15
      + paradigmChallenge * 0.10;

  const dimensionMap: Record<string, string> = {
    transformativePotential: 'New Finding',
    broadRelevance: 'Confirmation',
    methodologicalSignificance: 'Technical Advance',
    clinicalImpact: 'Novel Drug Target',
    paradigmChallenge: 'Interesting Hypothesis',
  };

  return {
    pmid,
    innovationTypes,
    primaryType: dimensionMap[primaryDimension] || 'New Finding',
    reasoning,
    score,
  };
}

export function s1FallbackResult(pmid: string, lastErr: unknown): S1ToolResult {
  return {
    pmid,
    innovationTypes: { newFinding: 0.5, technicalAdvance: 0.5, interestingHypothesis: 0.5, novelDrugTarget: 0.3, confirmation: 0.5 },
    primaryType: 'New Finding',
    reasoning: `LLM call failed after retries: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    score: 0.3,
    llmFailed: true,
  };
}

/**
 * 对一批论文执行 LLM 评分（8路并发，每篇最多 MAX_RETRIES 次工具内重试）
 * onPaperDone 在每篇完成时回调（用于agent进度上报与自主重试决策）
 */
export async function runSignal1Batch(
  papers: S1PaperInput[],
  opts: {
    model?: string;
    temperature?: number;
    maxRetries?: number;
    onPaperDone?: (result: S1ToolResult, doneCount: number, total: number) => void;
  } = {},
): Promise<S1ToolResult[]> {
  const config = new Config();
  const useModel = opts.model || S1_DEFAULT_MODEL;
  const useTemperature = typeof opts.temperature === 'number' ? opts.temperature : 0.2;
  const maxRetries = opts.maxRetries ?? 2;
  const CONCURRENCY = 8;

  const results = new Array<S1ToolResult>(papers.length);
  let doneCount = 0;

  const processOne = async (paper: S1PaperInput): Promise<S1ToolResult> => {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const raw = await streamChat(config, paper.title, paper.abstract, useModel, useTemperature);
        const parsed = parseS1Result(paper.pmid, raw);
        if (parsed) return parsed;
        lastErr = new Error('Malformed JSON from LLM');
      } catch (err) {
        lastErr = err;
      }
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
      }
    }
    return s1FallbackResult(paper.pmid, lastErr);
  };

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < papers.length) {
      const idx = cursor++;
      const r = await processOne(papers[idx]);
      results[idx] = r;
      doneCount++;
      opts.onPaperDone?.(r, doneCount, papers.length);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, papers.length) }, () => worker()),
  );

  return results;
}
