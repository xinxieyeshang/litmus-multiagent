// 信号1：LLM影响力和重要性推断 API
// 从"创新类型推断"改为"影响力和重要性判断"
// 关键洞察：F1000Prime专家选H1的标准是"重要性和影响力"，而非"新颖性"
//
// 实现说明：早期版本通过 coze-coding-dev-sdk（LangChain ChatOpenAI）调用模型。
// 实测在 Next.js 服务进程内 8 路并发流式调用时，LangChain 流式聚合层会产生
// 进程级原生内存（ArrayBuffer / external buffers）线性膨胀：20 篇并发约 55 秒
// 可从 ~0.7GB 涨到 7GB+ 直至被 OOM Killer 杀掉（V8 堆本身稳定在 ~150MB，
// 独立 node 进程中同一 SDK 连续多批仅 ~120MB，问题只在 Next 运行时 + LangChain
// 的组合下出现）。对照实验表明，使用原生 fetch + SSE reader 直接调用同一模型端点，
// 同样 20 篇 8 路并发内存稳定在 ~1.4GB。因此本路由改用原生 fetch 流式实现，
// 业务语义（prompt / 解析 / 回退 / 并发 / 重试）保持不变。
import { NextRequest, NextResponse } from 'next/server';
import { Config, HeaderUtils } from 'coze-coding-dev-sdk';

// 单批最多 50 篇，8 路并发下允许较慢的 LLM 响应与重试
export const maxDuration = 600;

const SYSTEM_PROMPT = `You are an expert panelist for F1000Prime (Faculty of 1000), a service where expert reviewers recommend the most important and impactful research papers in biology and medicine.

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

const MODEL = 'doubao-seed-2-0-lite-260215';

interface PaperInput {
  pmid: string;
  title: string;
  abstract: string;
}

interface Signal1Result {
  pmid: string;
  innovationTypes: Record<string, number>;
  primaryType: string;
  reasoning: string;
  score: number;
}

// 单路 SSE 流式调用（原生 fetch），逐 chunk 读取并只累积文本增量，
// 不保留任何 chunk / response 级别的缓冲引用
async function streamChat(
  config: Config,
  forwardHeaders: Record<string, string>,
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
      ...forwardHeaders,
    },
    body: JSON.stringify({
      model,
      temperature,
      stream: true,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Title: ${title}\n\nAbstract: ${abstract}` },
      ],
    }),
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
          // 分片边界处的半截 JSON，忽略即可
        }
      }
    }
  } finally {
    // 异常路径（超时/中断）下主动取消流，释放底层 socket 缓冲
    reader.cancel().catch(() => {});
  }
  return content;
}

// 将模型返回的 JSON 文本映射为信号1结果；解析失败时返回 null 交由重试/回退处理
function parseResult(pmid: string, raw: string): Signal1Result | null {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  let parsed: Record<string, unknown> = {};
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

const FALLBACK_RESULT = (pmid: string, lastErr: unknown): Signal1Result => ({
  pmid,
  innovationTypes: { newFinding: 0.5, technicalAdvance: 0.5, interestingHypothesis: 0.5, novelDrugTarget: 0.3, confirmation: 0.5 },
  primaryType: 'New Finding',
  reasoning: `LLM call failed after retries: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  score: 0.3,
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { papers, model, temperature } = body as {
      papers: PaperInput[];
      model: string;
      temperature: number;
    };

    if (!papers || !Array.isArray(papers) || papers.length === 0) {
      return NextResponse.json({ error: 'No papers provided' }, { status: 400 });
    }

    const config = new Config();
    const forwardHeaders = HeaderUtils.extractForwardHeaders(request.headers);
    const useModel = model || MODEL;
    const useTemperature = typeof temperature === 'number' ? temperature : 0.2;

    const results = new Array<Signal1Result>(papers.length);

    const CONCURRENCY = 8;
    const MAX_RETRIES = 2;

    const processOne = async (paper: PaperInput): Promise<Signal1Result> => {
      let lastErr: unknown = null;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const raw = await streamChat(
            config,
            forwardHeaders,
            paper.title,
            paper.abstract,
            useModel,
            useTemperature,
          );
          const parsed = parseResult(paper.pmid, raw);
          if (parsed) return parsed;
          lastErr = new Error('Malformed JSON from LLM');
        } catch (err) {
          lastErr = err;
        }
        if (attempt < MAX_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
        }
      }
      return FALLBACK_RESULT(paper.pmid, lastErr);
    };

    // 并发池：维护最多 CONCURRENCY 个同时运行的任务
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < papers.length) {
        const idx = cursor++;
        results[idx] = await processOne(papers[idx]);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, papers.length) }, () => worker()),
    );

    return NextResponse.json({ results });
  } catch (error) {
    return NextResponse.json(
      { error: `Signal 1 processing failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 },
    );
  }
}
