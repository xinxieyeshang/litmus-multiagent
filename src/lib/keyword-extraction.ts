/**
 * 关键词提取库：TF-IDF + TextRank 双重算法
 * 含学术停用词过滤、词干提取合并
 */

// ==================== 学术停用词 ====================
const ACADEMIC_STOPWORDS = new Set([
  // 通用英语停用词
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
  'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought', 'used',
  'it', 'its', 'this', 'that', 'these', 'those', 'i', 'me', 'my', 'we',
  'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her', 'they', 'them',
  'their', 'what', 'which', 'who', 'whom', 'where', 'when', 'how', 'why',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some',
  'such', 'no', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
  'just', 'because', 'if', 'then', 'also', 'about', 'up', 'out', 'into',
  'over', 'after', 'before', 'between', 'under', 'again', 'further',
  'once', 'here', 'there', 'any', 'above', 'below', 'through', 'during',
  'while', 'until', 'against', 'among', 'along', 'much', 'many', 'well',
  // 学术论文常见无区分力词
  'study', 'studies', 'studied', 'result', 'results', 'resulted',
  'method', 'methods', 'methodology', 'approach', 'approaches',
  'show', 'shown', 'shows', 'showed', 'showing',
  'demonstrate', 'demonstrated', 'demonstrates', 'demonstrating',
  'reveal', 'revealed', 'reveals', 'revealing',
  'find', 'found', 'finds', 'finding', 'findings',
  'observe', 'observed', 'observes', 'observing', 'observation', 'observations',
  'report', 'reported', 'reports', 'reporting',
  'suggest', 'suggested', 'suggests', 'suggesting', 'suggestion',
  'indicate', 'indicated', 'indicates', 'indicating', 'indication',
  'provide', 'provided', 'provides', 'providing',
  'use', 'used', 'uses', 'using', 'useful',
  'based', 'according', 'respectively', 'however', 'therefore', 'moreover',
  'furthermore', 'nevertheless', 'nonetheless', 'thus', 'hence', 'whereas',
  'although', 'though', 'despite', 'wherein', 'heretofore',
  'present', 'presented', 'presents', 'presenting',
  'previous', 'previously', 'prior',
  'significant', 'significantly', 'important', 'importantly',
  'novel', 'new', 'known', 'unknown',
  'high', 'higher', 'highest', 'low', 'lower', 'lowest',
  'increase', 'increased', 'increasing', 'decrease', 'decreased', 'decreasing',
  'include', 'included', 'includes', 'including',
  'identify', 'identified', 'identifies', 'identifying', 'identification',
  'describe', 'described', 'describes', 'describing', 'description',
  'propose', 'proposed', 'proposes', 'proposing', 'proposal',
  'develop', 'developed', 'develops', 'developing', 'development',
  'investigate', 'investigated', 'investigates', 'investigating', 'investigation',
  'analyze', 'analyzed', 'analyzes', 'analyzing', 'analysis', 'analyses',
  'assess', 'assessed', 'assesses', 'assessing', 'assessment',
  'evaluate', 'evaluated', 'evaluates', 'evaluating', 'evaluation',
  'compare', 'compared', 'compares', 'comparing', 'comparison',
  'suggest', 'suggested', 'suggests', 'suggesting',
  'support', 'supported', 'supports', 'supporting',
  'evidence', 'data', 'information', 'knowledge',
  'role', 'process', 'processes', 'processing',
  'effect', 'effects', 'effective', 'effectively',
  'function', 'functional', 'functions',
  'mechanism', 'mechanisms', 'mechanistic',
  'activity', 'activities', 'active',
  'level', 'levels',
  'model', 'models', 'modeling', 'modelling',
  'system', 'systems', 'systematic',
  'response', 'responses', 'responsive',
  'change', 'changes', 'changed', 'changing',
  'different', 'difference', 'differences', 'differential',
  'specific', 'specifically', 'specify', 'specified',
  'related', 'relate', 'related', 'relates', 'relating', 'relation', 'relationship',
  'associated', 'associate', 'associates', 'associating', 'association',
  'required', 'require', 'requires', 'requiring', 'requirement',
  'potential', 'possibly', 'possible',
  'overall', 'general', 'generally',
  'key', 'main', 'major', 'critical', 'essential',
  'well', 'also', 'yet', 'since', 'even', 'still',
  'first', 'second', 'third', 'last', 'final', 'finally',
  'one', 'two', 'three', 'four', 'five',
  'nature', 'paper', 'article', 'work', 'research', 'review',
  'abstract', 'introduction', 'conclusion', 'discussion',
  'figure', 'table', 'supplementary',
  'example', 'examples', 'instance',
  'type', 'types', 'form', 'forms', 'formed',
  'number', 'numbers', 'amount', 'amounts',
  'part', 'parts', 'partially',
  'within', 'without', 'among', 'between',
  'via', 'per', 'etc', 'versus', 'vs',
  'author', 'authors', 'et', 'al',
  'pmid', 'doi', 'pubmed',
  'able', 'unable', 'given', 'seen',
  'like', 'unlike', 'rather', 'instead',
  'early', 'late', 'later', 'following', 'followed',
  'total', 'overall', 'entire', 'complete', 'completely',
  'large', 'small', 'larger', 'smaller',
  'particular', 'particularly', 'especially',
  'whether', 'either', 'neither', 'both', 'each',
  'several', 'various', 'multiple', 'numerous',
  'recent', 'recently', 'current', 'currently',
  'additional', 'additionally', 'further', 'furthermore',
  'common', 'commonly', 'generally', 'widely',
  'individual', 'individuals', 'individualized',
  'year', 'years', 'time', 'times', 'period',
  'world', 'national', 'international', 'global',
  'human', 'mouse', 'rat', 'animal', 'model',
]);

// ==================== 简单词干提取器 ====================
/**
 * 基于规则的英文学术语干提取
 * 处理常见的学术词汇变形：-ing, -ed, -tion, -ment, -ness, -ity 等
 */
export function stem(word: string): string {
  let w = word.toLowerCase().trim();

  // 处理以 's' 结尾（复数和第三人称）
  if (w.length > 3 && w.endsWith('ies')) {
    w = w.slice(0, -3) + 'y'; // studies -> study (then further processed)
  } else if (w.length > 3 && w.endsWith('ves')) {
    w = w.slice(0, -3) + 'f'; // halves -> half
  } else if (w.length > 3 && w.endsWith('ses') || w.endsWith('zes') || w.endsWith('xes')) {
    w = w.slice(0, -2); // processes -> process
  } else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) {
    w = w.slice(0, -1); // papers -> paper
  }

  // -ing
  if (w.length > 5 && w.endsWith('ing')) {
    const base = w.slice(0, -3);
    if (base.length >= 3) {
      // 双写辅音结尾：running -> run
      if (base.length > 2 && base[base.length - 1] === base[base.length - 2] &&
          !isVowel(base[base.length - 1])) {
        w = base.slice(0, -1);
      } else if (base.endsWith('at')) {
        w = base + 'e'; // regulating -> regulate
      } else {
        w = base; // signaling -> signal
      }
    }
  }

  // -ation, -tion, -sion
  if (w.length > 6 && (w.endsWith('ation') || w.endsWith('ition'))) {
    w = w.slice(0, -4) + 'e'; // regulation -> regulate, inhibition -> inhibit
  } else if (w.length > 5 && w.endsWith('tion')) {
    w = w.slice(0, -3); // mutation -> muta, expression -> expres (imperfect but sufficient)
    if (w.length > 2) w = w; // keep
  } else if (w.length > 5 && w.endsWith('sion')) {
    w = w.slice(0, -3); // conversion -> conver
  }

  // -ment
  if (w.length > 6 && w.endsWith('ment')) {
    w = w.slice(0, -4); // treatment -> treat
  }

  // -ness
  if (w.length > 5 && w.endsWith('ness')) {
    w = w.slice(0, -4); // effectiveness -> effective
  }

  // -ity
  if (w.length > 5 && w.endsWith('ity')) {
    w = w.slice(0, -3) + 'e'; // activity -> active, specificity -> specifice
  }

  // -ize, -ise
  if (w.length > 4 && (w.endsWith('ize') || w.endsWith('ise'))) {
    w = w.slice(0, -3); // characterize -> character
  }

  // -ous
  if (w.length > 4 && w.endsWith('ous')) {
    w = w.slice(0, -3); // previous -> previ
  }

  // -ive
  if (w.length > 4 && w.endsWith('ive')) {
    w = w.slice(0, -3); // positive -> posit
  }

  // -al
  if (w.length > 4 && w.endsWith('al')) {
    w = w.slice(0, -2); // clinical -> clinic
  }

  // -ed
  if (w.length > 4 && w.endsWith('ed') && !w.endsWith('eed')) {
    const base = w.slice(0, -2);
    if (base.length >= 3) {
      // 双写辅音结尾：mapped -> map
      if (base.length > 2 && base[base.length - 1] === base[base.length - 2] &&
          !isVowel(base[base.length - 1])) {
        w = base.slice(0, -1);
      } else {
        w = base; // analyzed -> analyz
      }
    }
  }

  // -ly
  if (w.length > 4 && w.endsWith('ly')) {
    w = w.slice(0, -2); // significantly -> significant
  }

  // -er
  if (w.length > 4 && w.endsWith('er') && !w.endsWith('ver')) {
    w = w.slice(0, -2); // smaller -> small
  }

  // -est
  if (w.length > 4 && w.endsWith('est')) {
    w = w.slice(0, -3); // highest -> high
  }

  return w;
}

function isVowel(c: string): boolean {
  return ['a', 'e', 'i', 'o', 'u'].includes(c);
}

// ==================== 分词与预处理 ====================
export interface TokenizedDoc {
  pmid: string;
  tokens: string[];          // 原始词
  stems: string[];           // 词干
  stemToOriginal: Map<string, string[]>; // 词干 → 原始词映射
  stemFrequency: Map<string, number>;     // 词干频次
}

const WORD_REGEX = /^[a-z]+$/;

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && WORD_REGEX.test(w) && !ACADEMIC_STOPWORDS.has(w));
}

export function processDocument(pmid: string, title: string, abstract: string): TokenizedDoc {
  const fullText = `${title} ${title} ${abstract}`; // 标题加权（重复一次）
  const tokens = tokenize(fullText);

  const stemToOriginal = new Map<string, string[]>();
  const stemFrequency = new Map<string, number>();
  const stems: string[] = [];

  for (const token of tokens) {
    const s = stem(token);
    stems.push(s);

    if (!stemToOriginal.has(s)) {
      stemToOriginal.set(s, []);
    }
    const originals = stemToOriginal.get(s)!;
    if (!originals.includes(token)) {
      originals.push(token);
    }

    stemFrequency.set(s, (stemFrequency.get(s) || 0) + 1);
  }

  return { pmid, tokens, stems, stemToOriginal, stemFrequency };
}

// ==================== TF-IDF ====================
export interface TFIDFScore {
  stem: string;
  original: string;  // 最常见的原始词
  score: number;
}

/**
 * 计算整个语料库的 TF-IDF
 * @param docs 已处理的文档列表
 * @returns 每篇文档的 TF-IDF 得分列表（降序）
 */
export function computeTFIDF(docs: TokenizedDoc[]): Map<string, TFIDFScore[]> {
  const N = docs.length;

  // 计算文档频率 DF
  const df = new Map<string, number>();
  for (const doc of docs) {
    const uniqueStems = new Set(doc.stems);
    for (const s of uniqueStems) {
      df.set(s, (df.get(s) || 0) + 1);
    }
  }

  const results = new Map<string, TFIDFScore[]>();

  for (const doc of docs) {
    const totalTerms = doc.stems.length;
    const tfMap = new Map<string, number>();
    for (const s of doc.stems) {
      tfMap.set(s, (tfMap.get(s) || 0) + 1);
    }

    const scores: TFIDFScore[] = [];
    for (const [s, tf] of tfMap) {
      const tfScore = tf / totalTerms;
      const idfScore = Math.log((N + 1) / ((df.get(s) || 0) + 1)) + 1; // 平滑 IDF
      const tfidf = tfScore * idfScore;

      // 选择最常见的原始词作为代表
      const originals = doc.stemToOriginal.get(s) || [s];
      const original = originals[0]; // 简化：取第一个

      scores.push({ stem: s, original, score: tfidf });
    }

    scores.sort((a, b) => b.score - a.score);
    results.set(doc.pmid, scores);
  }

  return results;
}

// ==================== TextRank ====================
export interface TextRankScore {
  stem: string;
  original: string;
  score: number;
}

/**
 * 对单篇文档运行 TextRank 关键词提取
 * 基于词共现图 + PageRank 迭代
 */
export function computeTextRank(
  doc: TokenizedDoc,
  windowSize: number = 4,
  iterations: number = 20,
  damping: number = 0.85
): TextRankScore[] {
  // 构建词共现图
  const vocab = [...new Set(doc.stems)];
  const vocabIndex = new Map(vocab.map((w, i) => [w, i]));
  const n = vocab.length;

  if (n === 0) return [];

  // 邻接矩阵（权重）
  const graph: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));

  for (let i = 0; i < doc.stems.length; i++) {
    for (let j = i + 1; j < Math.min(i + windowSize, doc.stems.length); j++) {
      if (doc.stems[i] !== doc.stems[j]) {
        const a = vocabIndex.get(doc.stems[i])!;
        const b = vocabIndex.get(doc.stems[j])!;
        graph[a][b] += 1;
        graph[b][a] += 1;
      }
    }
  }

  // 出度权重
  const outWeight = graph.map(row => row.reduce((s, v) => s + v, 0));

  // PageRank 迭代
  let scores = new Array(n).fill(1 / n);

  for (let iter = 0; iter < iterations; iter++) {
    const newScores = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let j = 0; j < n; j++) {
        if (graph[j][i] > 0 && outWeight[j] > 0) {
          sum += scores[j] * graph[j][i] / outWeight[j];
        }
      }
      newScores[i] = (1 - damping) / n + damping * sum;
    }
    scores = newScores;
  }

  // 排序输出
  const results: TextRankScore[] = vocab.map((stem, i) => {
    const originals = doc.stemToOriginal.get(stem) || [stem];
    return { stem, original: originals[0], score: scores[i] };
  });

  results.sort((a, b) => b.score - a.score);
  return results;
}

// ==================== 综合关键词提取 ====================
export interface ExtractedKeyword {
  stem: string;
  original: string;
  frequency: number;
  tfidfScore: number;
  textrankScore: number;
  combinedScore: number;
}

/**
 * 综合提取关键词：TF-IDF + TextRank 双重算法
 * @param docs 文档列表
 * @param topK 每篇文档取 top-K 关键词
 * @param alpha TF-IDF权重 (1-alpha 为 TextRank 权重)
 */
export function extractKeywords(
  docs: TokenizedDoc[],
  topK: number = 15,
  alpha: number = 0.5
): Map<string, ExtractedKeyword[]> {
  // 1. TF-IDF
  const tfidfResults = computeTFIDF(docs);

  // 2. TextRank (per document)
  const textrankResults = new Map<string, TextRankScore[]>();
  for (const doc of docs) {
    textrankResults.set(doc.pmid, computeTextRank(doc));
  }

  // 3. 合并得分
  const results = new Map<string, ExtractedKeyword[]>();

  for (const doc of docs) {
    const tfidfList = tfidfResults.get(doc.pmid) || [];
    const textrankList = textrankResults.get(doc.pmid) || [];

    // 归一化函数
    const normalizeScores = (items: Array<{ score: number }>): Map<string, number> => {
      const map = new Map<string, number>();
      const maxScore = items.length > 0 ? Math.max(...items.map(x => x.score)) : 1;
      for (const item of items) {
        // 用stem作为key
        const key = (item as { stem?: string }).stem || '';
        map.set(key, maxScore > 0 ? item.score / maxScore : 0);
      }
      return map;
    };

    // 对于tfidf和textrank，用stem建立索引
    const tfidfMap = new Map<string, { score: number; original: string }>();
    for (const item of tfidfList) {
      tfidfMap.set(item.stem, { score: item.score, original: item.original });
    }
    const textrankMap = new Map<string, { score: number; original: string }>();
    for (const item of textrankList) {
      textrankMap.set(item.stem, { score: item.score, original: item.original });
    }

    // 归一化
    const tfidfNorm = new Map<string, number>();
    const tfMax = tfidfList.length > 0 ? Math.max(...tfidfList.map(x => x.score)) : 1;
    for (const item of tfidfList) {
      tfidfNorm.set(item.stem, tfMax > 0 ? item.score / tfMax : 0);
    }

    const trNorm = new Map<string, number>();
    const trMax = textrankList.length > 0 ? Math.max(...textrankList.map(x => x.score)) : 1;
    for (const item of textrankList) {
      trNorm.set(item.stem, trMax > 0 ? item.score / trMax : 0);
    }

    // 合并所有stem
    const allStems = new Set([...tfidfMap.keys(), ...textrankMap.keys()]);
    const keywords: ExtractedKeyword[] = [];

    for (const stem of allStems) {
      const tfidf = tfidfNorm.get(stem) || 0;
      const textrank = trNorm.get(stem) || 0;
      const combined = alpha * tfidf + (1 - alpha) * textrank;

      const original = tfidfMap.get(stem)?.original || textrankMap.get(stem)?.original || stem;
      const frequency = doc.stemFrequency.get(stem) || 0;

      keywords.push({
        stem,
        original,
        frequency,
        tfidfScore: tfidf,
        textrankScore: textrank,
        combinedScore: combined,
      });
    }

    keywords.sort((a, b) => b.combinedScore - a.combinedScore);
    results.set(doc.pmid, keywords.slice(0, topK));
  }

  return results;
}
