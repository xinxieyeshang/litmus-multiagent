// LITMUS 实验平台类型定义

/** 论文基础数据 */
export interface Paper {
  pmid: string;
  title: string;
  abstract: string;
  meshTerms: string[];
  year: string;
  paperType: string;
  isH1: boolean;
  h1Classification: string[];
  h1Rating: string;
}

/** 信号1结果：LLM影响力与重要性判断 */
export interface Signal1Result {
  pmid: string;
  innovationTypes: {
    newFinding: number;      // 颠覆性发现 (transformativePotential)
    technicalAdvance: number; // 技术进步 (methodologicalSignificance)
    interestingHypothesis: number; // 范式挑战 (paradigmChallenge)
    novelDrugTarget: number; // 临床影响 (clinicalImpact)
    confirmation: number;    // 广泛重要性 (broadRelevance)
  };
  primaryType: string;        // New Finding / Technical Advance / Interesting Hypothesis / Novel Drug Target / Confirmation
  reasoning: string;
  /** 信号1得分 = overallImportance 或多维加权 */
  score: number;
}

/** 信号2结果：MeSH主题广度与跨域性 */
export interface Signal2Result {
  pmid: string;
  /** MeSH词总数 */
  meshCount: number;
  /** 独立MeSH领域数 */
  uniqueDomains: number;
  /** 跨域指数 (0-1) */
  crossDomainIndex: number;
  /** 领域分布 */
  domainDistribution: Record<string, number>;
  /** 是否有MeSH词 */
  hasMeSH: boolean;
  /** 信号2得分 */
  score: number;
}

/** 信号3结果：知识网络桥梁性（Betweenness Centrality） */
export interface Signal3Result {
  pmid: string;
  /** 关键词数量 */
  keywordCount: number;
  /** Betweenness Centrality 原始值 */
  betweenness: number;
  /** 归一化 Betweenness (0-1) */
  normalizedBetweenness: number;
  /** 桥接关键词（对 betweenness 贡献最大的关键词） */
  bridgingKeywords: string[];
  /** 关键词提取详情 */
  topKeywords: Array<{ keyword: string; score: number }>;
  /** 信号3得分 = normalizedBetweenness */
  score: number;
}

/** 信号4结果：认知偏离度 (Cognitive Deviation) */
export interface Signal4Result {
  pmid: string;
  title: string;
  isH1: boolean;
  h1Classification: string[];
  h1Rating: string;
  /** 语义偏离度 = 1 - mean(cos(v_i, v_j)) */
  semanticDeviation: number;
  /** 概念罕见度 = 低频MeSH词占比 */
  conceptRarity: number;
  /** 综合新颖性分数 = 0.5 * semanticDeviation + 0.5 * conceptRarity */
  noveltyScore: number;
  /** 用于融合的标准化分数 (0-1) */
  score: number;
  /** 语义偏离度分数（别名） */
  deviationScore: number;
  /** 概念罕见度分数（别名） */
  frequencyScore: number;
  /** 平均余弦相似度 */
  avgSimilarity: number;
  /** 低频MeSH词数量 */
  lowFreqMeshCount: number;
  /** 总MeSH词数量 */
  totalMeshCount: number;
}

/** 通用指标 */
export interface Metrics {
  /** AUC-ROC */
  auc: number;
  /** Precision@K (K=H1论文数) */
  precisionAtK: number;
  /** H1论文均分 */
  h1MeanScore: number;
  /** 非H1论文均分 */
  nonH1MeanScore: number;
  /** 效应量 (Cohen's d) */
  cohensD: number;
}

/** 融合结果 */
export interface FusionResult {
  pmid: string;
  signal1Score: number;
  signal2Score: number;
  signal3Score: number;
  signal4Score: number;
  /** 加权融合得分 */
  fusedScore: number;
  isH1: boolean;
}

/** 信号运行状态 */
export type SignalStatus = 'idle' | 'running' | 'done' | 'error';

/** 信号配置 */
export interface SignalConfig {
  model: string;
  temperature: number;
  batchSize: number;
}