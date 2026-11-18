// MeSH 主题领域分类工具
// 基于关键词启发式规则将 MeSH 词映射到科学领域

/** 科学领域定义 */
export interface DomainDef {
  name: string;
  keywords: string[];
}

/** 8大科学领域及关键词 */
export const MESH_DOMAINS: DomainDef[] = [
  {
    name: '分子与细胞生物学',
    keywords: [
      'molecular', 'cell', 'protein', 'gene', 'dna', 'rna', 'receptor', 'signaling',
      'kinase', 'enzyme', 'mutation', 'expression', 'transcription', 'translation',
      'apoptosis', 'proliferation', 'differentiation', 'stem cell', 'genome',
      'epigenetic', 'chromatin', 'mrna', 'mirna', 'crispr', 'sequencing',
      '分', '细', '蛋', '基', '受', '酶', '突', '表', '转', '凋', '增',
    ],
  },
  {
    name: '免疫与感染',
    keywords: [
      'immune', 'immun', 'antibod', 't cell', 'b cell', 'cytokine', 'inflam',
      'infection', 'viral', 'bacteri', 'hiv', 'vaccine', 'antigen', 'autoimmun',
      'tumor immun', 'innate immun', 'adaptive immun', 'interferon', 'interleukin',
      '免', '感', '抗', '炎', '病', '疫',
    ],
  },
  {
    name: '神经科学',
    keywords: [
      'brain', 'neural', 'neuro', 'cognit', 'synap', 'cortex', 'hippocamp',
      'dopamine', 'serotonin', 'alzheimer', 'parkinson', 'memory', 'learning',
      'neurodegen', 'neuroplast', 'cerebr', 'axon', 'dendrit',
      '脑', '神', '认', '突', '记',
    ],
  },
  {
    name: '临床医学',
    keywords: [
      'patient', 'clinical', 'therapy', 'treatment', 'diagnosis', 'prognosis',
      'surgery', 'trial', 'hospital', 'mortality', 'morbidity', 'therapeu',
      'chemotherapy', 'radiotherapy', 'biomarker', 'cohort', 'randomiz',
      '患', '临', '治', '诊', '预', '术', '试',
    ],
  },
  {
    name: '流行病学与公共卫生',
    keywords: [
      'epidem', 'population', 'risk factor', 'prevalence', 'incidence',
      'public health', 'outbreak', 'pandem', 'surveillance', 'screening',
      'mortality rate', 'cohort study', 'odds ratio', 'hazard ratio',
      '流', '人', '风', '患', '公', '监',
    ],
  },
  {
    name: '药理学与药物',
    keywords: [
      'drug', 'pharmac', 'toxic', 'dose', 'medicat', 'inhibit', 'agonist',
      'antagonist', 'bioavail', 'metabol', 'side effect', 'adverse',
      '药', '毒', '剂', '抑', '副',
    ],
  },
  {
    name: '方法与技术',
    keywords: [
      'method', 'technique', 'assay', 'imaging', 'microscop', 'spectromet',
      'crystallograph', 'computational', 'algorithm', 'model', 'simulation',
      'machine learning', 'deep learning', 'artificial intelligence',
      'statistical', 'bioinformatic', 'high-throughput', 'screening',
      '方', '技', '算', '模', '显',
    ],
  },
  {
    name: '生态与环境',
    keywords: [
      'ecolog', 'environment', 'climate', 'biodivers', 'evolution',
      'species', 'habitat', 'ecosystem', 'conservation', 'pollut',
      '生', '环', '气', '多', '进', '物', '保',
    ],
  },
];

/**
 * 将单个 MeSH 词分类到最匹配的领域
 */
export function classifyMeshTerm(term: string): string {
  const lowerTerm = term.toLowerCase();
  let bestDomain = '其他';
  let bestScore = 0;

  for (const domain of MESH_DOMAINS) {
    let score = 0;
    for (const keyword of domain.keywords) {
      if (lowerTerm.includes(keyword)) {
        score += keyword.length; // 更长的关键词权重更高
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestDomain = domain.name;
    }
  }

  return bestDomain;
}

/**
 * 计算一组 MeSH 词的领域分布
 */
export function computeDomainDistribution(meshTerms: string[]): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const term of meshTerms) {
    const domain = classifyMeshTerm(term);
    dist[domain] = (dist[domain] || 0) + 1;
  }
  return dist;
}

/**
 * 计算跨域指数 (Shannon 熵 / 最大熵)
 * 值越大表示领域分布越均匀(越跨域)
 */
export function computeCrossDomainIndex(domainDistribution: Record<string, number>): number {
  const values = Object.values(domainDistribution);
  const total = values.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;

  // Shannon 熵
  let entropy = 0;
  for (const count of values) {
    if (count > 0) {
      const p = count / total;
      entropy -= p * Math.log2(p);
    }
  }

  // 最大熵 (均匀分布时的熵)
  const maxEntropy = Math.log2(values.length || 1);

  // 归一化到 0-1
  return maxEntropy === 0 ? 0 : entropy / maxEntropy;
}
