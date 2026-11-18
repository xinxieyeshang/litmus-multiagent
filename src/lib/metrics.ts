// 评估指标计算工具

import type { Metrics } from './types';

/**
 * 计算 AUC-ROC (梯形法)
 * @param scores 每个样本的预测分数
 * @param labels 每个样本的真实标签 (1=正例, 0=负例)
 */
export function computeAUC(scores: number[], labels: number[]): number {
  const n = scores.length;
  if (n === 0) return 0.5;

  // 按 score 降序排列
  const pairs = scores.map((s, i) => ({ score: s, label: labels[i] }));
  pairs.sort((a, b) => b.score - a.score);

  let tp = 0;
  let fp = 0;
  let tprPrev = 0;
  let fprPrev = 0;
  let auc = 0;

  const totalPos = labels.filter(l => l === 1).length;
  const totalNeg = n - totalPos;

  if (totalPos === 0 || totalNeg === 0) return 0.5;

  let i = 0;
  while (i < n) {
    // 找到相同分数的区间
    let j = i;
    while (j < n && pairs[j].score === pairs[i].score) {
      j++;
    }
    // 累计该区间内的正例和负例
    let tpDelta = 0;
    let fpDelta = 0;
    for (let k = i; k < j; k++) {
      if (pairs[k].label === 1) tpDelta++;
      else fpDelta++;
    }
    tp += tpDelta;
    fp += fpDelta;

    const tpr = tp / totalPos;
    const fpr = fp / totalNeg;

    auc += (fpr - fprPrev) * (tpr + tprPrev) / 2;
    tprPrev = tpr;
    fprPrev = fpr;

    i = j;
  }

  return Math.max(0, Math.min(1, auc));
}

/**
 * 计算 Precision@K
 * @param scores 预测分数
 * @param labels 真实标签
 * @param k 取前K个
 */
export function computePrecisionAtK(scores: number[], labels: number[], k: number): number {
  const pairs = scores.map((s, i) => ({ score: s, label: labels[i] }));
  pairs.sort((a, b) => b.score - a.score);

  const topK = pairs.slice(0, Math.min(k, pairs.length));
  const hits = topK.filter(p => p.label === 1).length;
  return hits / topK.length;
}

/**
 * 计算 Cohen's d 效应量
 */
export function computeCohensD(h1Scores: number[], nonH1Scores: number[]): number {
  const n1 = h1Scores.length;
  const n2 = nonH1Scores.length;
  if (n1 === 0 || n2 === 0) return 0;

  const mean1 = h1Scores.reduce((a, b) => a + b, 0) / n1;
  const mean2 = nonH1Scores.reduce((a, b) => a + b, 0) / n2;

  const var1 = h1Scores.reduce((a, b) => a + (b - mean1) ** 2, 0) / (n1 - 1 || 1);
  const var2 = nonH1Scores.reduce((a, b) => a + (b - mean2) ** 2, 0) / (n2 - 1 || 1);

  const pooledStd = Math.sqrt(((n1 - 1) * var1 + (n2 - 1) * var2) / (n1 + n2 - 2 || 1));
  if (pooledStd === 0) return 0;

  return (mean1 - mean2) / pooledStd;
}

/**
 * 计算完整指标
 */
export function computeMetrics(
  results: Array<{ pmid: string; score: number }>,
  papers: Array<{ pmid: string; isH1: boolean }>
): Metrics {
  const scoreMap = new Map(results.map(r => [r.pmid, r.score]));
  const scores: number[] = [];
  const labels: number[] = [];
  const h1Scores: number[] = [];
  const nonH1Scores: number[] = [];

  for (const paper of papers) {
    const score = scoreMap.get(paper.pmid);
    if (score !== undefined) {
      scores.push(score);
      labels.push(paper.isH1 ? 1 : 0);
      if (paper.isH1) h1Scores.push(score);
      else nonH1Scores.push(score);
    }
  }

  const h1Count = papers.filter(p => p.isH1).length;

  return {
    auc: computeAUC(scores, labels),
    precisionAtK: computePrecisionAtK(scores, labels, h1Count),
    h1MeanScore: h1Scores.length > 0 ? h1Scores.reduce((a, b) => a + b, 0) / h1Scores.length : 0,
    nonH1MeanScore: nonH1Scores.length > 0 ? nonH1Scores.reduce((a, b) => a + b, 0) / nonH1Scores.length : 0,
    cohensD: computeCohensD(h1Scores, nonH1Scores),
  };
}

/**
 * 余弦相似度
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * 余弦距离 = 1 - 余弦相似度
 */
export function cosineDistance(a: number[], b: number[]): number {
  return 1 - cosineSimilarity(a, b);
}

/**
 * Min-Max 归一化
 */
export function minMaxNormalize(values: number[]): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  if (range === 0) {
    // 所有两极值相同 → 该信号无区分力，返回全0以便在融合中被权重稀释
    // 不再返回0.5（会污染融合结果）
    return values.map(() => 0);
  }
  return values.map(v => (v - min) / range);
}

/**
 * 百分位排名（Percentile Rank）
 * 将得分转换为0-1之间的百分位排名，排名越高值越大
 * 相同得分取平均排名（dense rank with ties averaged）
 */
export function percentileRank(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return [0.5];

  // 创建带索引的数组，按值排序
  const indexed = values.map((v, i) => ({ value: v, index: i }));
  indexed.sort((a, b) => a.value - b.value);

  const ranks = new Array<number>(n);
  let i = 0;
  while (i < n) {
    // 找到相同值的区间
    let j = i;
    while (j < n && indexed[j].value === indexed[i].value) {
      j++;
    }
    // 计算平均排名（0-based）
    const avgRank = (i + j - 1) / 2;
    // 转换为百分位（0-1）
    const percentile = avgRank / (n - 1);
    // 赋值给所有相同值的元素
    for (let k = i; k < j; k++) {
      ranks[indexed[k].index] = percentile;
    }
    i = j;
  }

  return ranks;
}

// ============ 无监督权重方法 ============

/**
 * 熵权法 (Entropy Weight Method)
 * 信息熵越小 → 变异越大 → 权重越高
 * @param matrix n×m 矩阵，n个样本，m个指标（已归一化到[0,1]）
 * @returns m维权重向量（归一化到和为1）
 */
export function entropyWeights(matrix: number[][]): number[] {
  const n = matrix.length;
  if (n === 0) return [];
  const m = matrix[0].length;
  if (m === 0) return [];

  // Step 1: 计算每个指标下各样本的比重 p_ij
  // 先对每列做平移，避免 log(0)
  const epsilon = 1e-8;
  const colSums: number[] = new Array(m).fill(0);
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < n; i++) {
      colSums[j] += matrix[i][j];
    }
  }

  const p: number[][] = matrix.map(row => row.map((v, j) => {
    const sum = colSums[j];
    return sum === 0 ? 1 / n : (v + epsilon) / (sum + epsilon * n);
  }));

  // Step 2: 计算每个指标的信息熵 e_j = -k * Σ(p_ij * ln(p_ij))
  const k = 1 / Math.log(n);
  const entropy: number[] = new Array(m).fill(0);
  for (let j = 0; j < m; j++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      if (p[i][j] > 0) {
        sum += p[i][j] * Math.log(p[i][j]);
      }
    }
    entropy[j] = -k * sum;
  }

  // Step 3: 计算差异系数 d_j = 1 - e_j
  const d = entropy.map(e => 1 - e);

  // Step 4: 归一化得到权重
  const dSum = d.reduce((a, b) => a + b, 0);
  if (dSum === 0) return new Array(m).fill(1 / m);
  return d.map(v => v / dSum);
}

/**
 * CRITIC 法 (Criteria Importance Through Intercriteria Correlation)
 * 权重 = 对比强度(σ_j) × 冲突度(Σ(1-r_jk)) 的归一化
 * @param matrix n×m 矩阵（原始值或归一化值均可）
 * @returns m维权重向量
 */
export function criticWeights(matrix: number[][]): number[] {
  const n = matrix.length;
  if (n === 0) return [];
  const m = matrix[0].length;
  if (m === 0) return [];

  // Step 1: 计算每列的标准差 σ_j（对比强度）
  const means: number[] = new Array(m).fill(0);
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < n; i++) means[j] += matrix[i][j];
    means[j] /= n;
  }

  const stds: number[] = new Array(m).fill(0);
  for (let j = 0; j < m; j++) {
    let ss = 0;
    for (let i = 0; i < n; i++) ss += (matrix[i][j] - means[j]) ** 2;
    stds[j] = Math.sqrt(ss / (n - 1 || 1));
  }

  // Step 2: 计算相关系数矩阵 r_jk
  const corr: number[][] = Array.from({ length: m }, () => new Array(m).fill(0));
  for (let j = 0; j < m; j++) {
    for (let k = j; k < m; k++) {
      let cov = 0;
      for (let i = 0; i < n; i++) {
        cov += (matrix[i][j] - means[j]) * (matrix[i][k] - means[k]);
      }
      cov /= (n - 1 || 1);
      const denom = stds[j] * stds[k];
      const r = denom === 0 ? 0 : cov / denom;
      corr[j][k] = r;
      corr[k][j] = r;
    }
  }

  // Step 3: 计算冲突度 C_j = Σ(1 - r_jk)
  const conflict = new Array(m).fill(0);
  for (let j = 0; j < m; j++) {
    for (let k = 0; k < m; k++) {
      conflict[j] += (1 - corr[j][k]);
    }
  }

  // Step 4: 信息量 C_j = σ_j × conflict_j
  const info = stds.map((s, j) => s * conflict[j]);

  // Step 5: 归一化
  const infoSum = info.reduce((a, b) => a + b, 0);
  if (infoSum === 0) return new Array(m).fill(1 / m);
  return info.map(v => v / infoSum);
}

/**
 * PCA 第一主成分权重法
 * 通过幂迭代法求协方差矩阵的第一特征向量，取绝对值归一化作为权重
 * @param matrix n×m 矩阵（建议先标准化）
 * @returns m维权重向量（第一主成分的绝对值归一化）
 */
export function pcaWeights(matrix: number[][]): number[] {
  const n = matrix.length;
  if (n === 0) return [];
  const m = matrix[0].length;
  if (m === 0) return [];

  // Step 1: 标准化（z-score）
  const means: number[] = new Array(m).fill(0);
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < n; i++) means[j] += matrix[i][j];
    means[j] /= n;
  }

  const stds: number[] = new Array(m).fill(0);
  for (let j = 0; j < m; j++) {
    let ss = 0;
    for (let i = 0; i < n; i++) ss += (matrix[i][j] - means[j]) ** 2;
    stds[j] = Math.sqrt(ss / (n - 1 || 1));
    if (stds[j] === 0) stds[j] = 1; // 避免除零
  }

  const zMatrix = matrix.map(row =>
    row.map((v, j) => (v - means[j]) / stds[j])
  );

  // Step 2: 计算协方差矩阵 (m×m)
  const cov: number[][] = Array.from({ length: m }, () => new Array(m).fill(0));
  for (let j = 0; j < m; j++) {
    for (let k = j; k < m; k++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += zMatrix[i][j] * zMatrix[i][k];
      cov[j][k] = s / (n - 1 || 1);
      cov[k][j] = cov[j][k];
    }
  }

  // Step 3: 幂迭代法求第一特征向量
  let v = new Array(m).fill(1 / Math.sqrt(m));
  for (let iter = 0; iter < 200; iter++) {
    const vNew = new Array(m).fill(0);
    for (let j = 0; j < m; j++) {
      for (let k = 0; k < m; k++) {
        vNew[j] += cov[j][k] * v[k];
      }
    }
    // 归一化
    const norm = Math.sqrt(vNew.reduce((a, b) => a + b * b, 0));
    if (norm === 0) break;
    for (let j = 0; j < m; j++) vNew[j] /= norm;

    // 检查收敛
    let diff = 0;
    for (let j = 0; j < m; j++) diff += (vNew[j] - v[j]) ** 2;
    v = vNew;
    if (Math.sqrt(diff) < 1e-10) break;
  }

  // Step 4: 取绝对值并归一化为权重
  const absV = v.map(x => Math.abs(x));
  const absSum = absV.reduce((a, b) => a + b, 0);
  if (absSum === 0) return new Array(m).fill(1 / m);
  return absV.map(x => x / absSum);
}

/**
 * Bootstrap 稳定性分析
 * 对给定的权重方法，进行 B 次有放回重采样，计算权重的均值、标准差和95%CI
 * @param matrix n×m 归一化后的指标矩阵
 * @param weightFn 权重计算函数
 * @param B bootstrap次数（默认1000）
 * @returns 每个指标的 { mean, std, ci_low, ci_high }
 */
export function bootstrapWeightStability(
  matrix: number[][],
  weightFn: (m: number[][]) => number[],
  B: number = 1000
): Array<{ mean: number; std: number; ciLow: number; ciHigh: number }> {
  const n = matrix.length;
  if (n === 0) return [];
  const m = matrix[0].length;

  const allWeights: number[][] = [];

  for (let b = 0; b < B; b++) {
    // 有放回重采样
    const sample: number[][] = [];
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(Math.random() * n);
      sample.push(matrix[idx]);
    }
    allWeights.push(weightFn(sample));
  }

  // 计算每个指标的统计量
  return Array.from({ length: m }, (_, j) => {
    const vals = allWeights.map(w => w[j]).sort((a, b) => a - b);
    const mean = vals.reduce((a, b) => a + b, 0) / B;
    const variance = vals.reduce((a, v) => a + (v - mean) ** 2, 0) / (B - 1 || 1);
    const std = Math.sqrt(variance);
    const ciLow = vals[Math.floor(B * 0.025)];
    const ciHigh = vals[Math.floor(B * 0.975)];
    return { mean, std, ciLow, ciHigh };
  });
}

// ==================== Logistic Regression (L2) ====================

/** Sigmoid function */
function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, z))));
}

/** Standardize features: return standardized matrix, means, stds */
function standardize(matrix: number[][]): { matrix: number[][]; means: number[]; stds: number[] } {
  const n = matrix.length;
  const m = matrix[0].length;
  const means: number[] = [];
  const stds: number[] = [];
  const result: number[][] = [];

  for (let j = 0; j < m; j++) {
    const col = matrix.map(row => row[j]);
    const mean = col.reduce((a, v) => a + v, 0) / n;
    const std = Math.sqrt(col.reduce((a, v) => a + (v - mean) ** 2, 0) / n) || 1;
    means.push(mean);
    stds.push(std);
  }

  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    for (let j = 0; j < m; j++) {
      row.push((matrix[i][j] - means[j]) / stds[j]);
    }
    result.push(row);
  }

  return { matrix: result, means, stds };
}

/** Train Logistic Regression with L2 regularization using gradient descent */
export function trainLogisticRegression(
  X: number[][],
  y: number[],
  options?: { lr?: number; epochs?: number; lambda?: number }
): { weights: number[]; bias: number; means: number[]; stds: number[] } {
  const { lr = 0.1, epochs = 1000, lambda = 0.01 } = options || {};
  const n = X.length;
  const m = X[0].length;

  // Standardize features
  const { matrix: Xs, means, stds } = standardize(X);

  // Initialize weights
  const weights = new Array(m).fill(0);
  let bias = 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const dw = new Array(m).fill(0);
    let db = 0;

    for (let i = 0; i < n; i++) {
      const z = weights.reduce((sum, w, j) => sum + w * Xs[i][j], 0) + bias;
      const pred = sigmoid(z);
      const error = pred - y[i];

      for (let j = 0; j < m; j++) {
        dw[j] += error * Xs[i][j];
      }
      db += error;
    }

    // Update with L2 regularization
    for (let j = 0; j < m; j++) {
      weights[j] -= lr * (dw[j] / n + lambda * weights[j]);
    }
    bias -= lr * db / n;
  }

  return { weights, bias, means, stds };
}

/** Predict probabilities using trained LR model */
export function predictLogisticRegression(
  X: number[][],
  model: { weights: number[]; bias: number; means: number[]; stds: number[] }
): number[] {
  const { weights, bias, means, stds } = model;
  return X.map(row => {
    const z = row.reduce((sum, x, j) => {
      const standardized = (x - means[j]) / stds[j];
      return sum + weights[j] * standardized;
    }, 0) + bias;
    return sigmoid(z);
  });
}

/** Add interaction features to feature matrix
 * Adds S1×S4 and S3×S4 interaction terms
 */
export function addInteractionFeatures(X: number[][]): number[][] {
  return X.map(row => {
    // row: [s1, s2, s3, s4]
    const s1 = row[0] || 0;
    const s3 = row[2] || 0;
    const s4 = row[3] || 0;
    return [
      ...row,
      s1 * s4,  // S1 × S4 (expert × novelty)
      s3 * s4,  // S3 × S4 (bridge × novelty)
    ];
  });
}

/**
 * NDCG (Normalized Discounted Cumulative Gain)
 * @param labels 按预测得分降序排列的标签数组 (1=H1, 0=非H1)
 * @param k 评估位置
 */
export function ndcgAtK(labels: number[], k: number): number {
  const n = Math.min(k, labels.length);
  if (n === 0) return 0;

  // DCG = Σ(rel_i / log2(i+1))
  let dcg = 0;
  for (let i = 0; i < n; i++) {
    dcg += labels[i] / Math.log2(i + 2);  // i+2 因为i从0开始，位置从1开始
  }

  // IDCG = 理想情况下的DCG（所有H1排在最前面）
  const totalH1 = labels.filter(l => l === 1).length;
  const idealLabels = Array(labels.length).fill(0);
  for (let i = 0; i < Math.min(totalH1, n); i++) {
    idealLabels[i] = 1;
  }

  let idcg = 0;
  for (let i = 0; i < n; i++) {
    idcg += idealLabels[i] / Math.log2(i + 2);
  }

  return idcg > 0 ? dcg / idcg : 0;
}

/**
 * Enrichment Factor
 * Top-K中H1比例 / 整体H1比例
 */
export function enrichmentAtK(labels: number[], k: number): number {
  const n = Math.min(k, labels.length);
  if (n === 0) return 0;

  const topKH1 = labels.slice(0, n).filter(l => l === 1).length;
  const totalH1 = labels.filter(l => l === 1).length;

  const topKRatio = topKH1 / n;
  const overallRatio = totalH1 / labels.length;

  return overallRatio > 0 ? topKRatio / overallRatio : 0;
}

/**
 * Mann-Whitney U Test (单侧检验: A > B?)
 * 比较两个独立样本的分布差异
 * @param sampleA 样本A（如Top-K论文的citation）
 * @param sampleB 样本B（如随机论文的citation）
 * @returns { u, p, significant } u统计量、p值、是否显著(p<0.05)
 */
export function mannWhitneyUTest(sampleA: number[], sampleB: number[]): {
  u: number;
  p: number;
  significant: boolean;
  stars: string;
} {
  const n1 = sampleA.length;
  const n2 = sampleB.length;

  if (n1 === 0 || n2 === 0) {
    return { u: 0, p: 1, significant: false, stars: '' };
  }

  // 合并排序，计算rank
  const combined = [
    ...sampleA.map(v => ({ v, group: 'A' })),
    ...sampleB.map(v => ({ v, group: 'B' })),
  ];
  combined.sort((a, b) => a.v - b.v);

  // 处理ties：相同值取平均rank
  const ranks = new Array(combined.length);
  let i = 0;
  while (i < combined.length) {
    let j = i;
    while (j < combined.length && combined[j].v === combined[i].v) {
      j++;
    }
    const avgRank = (i + j + 1) / 2; // 1-based average rank
    for (let k = i; k < j; k++) {
      ranks[k] = avgRank;
    }
    i = j;
  }

  // 计算U统计量
  let rankSumA = 0;
  for (let k = 0; k < combined.length; k++) {
    if (combined[k].group === 'A') {
      rankSumA += ranks[k];
    }
  }

  const u1 = rankSumA - n1 * (n1 + 1) / 2;
  const u2 = n1 * n2 - u1;
  const u = Math.min(u1, u2);

  // 大样本近似（正态近似）
  const mean = (n1 * n2) / 2;
  const variance = (n1 * n2 * (n1 + n2 + 1)) / 12;
  const std = Math.sqrt(variance);

  // 连续性校正
  const z = (u - mean + 0.5) / std;

  // 单侧p值（检验A > B，即U应该较小）
  const p = normalCDF(z);

  const significant = p < 0.05;
  let stars = '';
  if (p < 0.001) stars = '***';
  else if (p < 0.01) stars = '**';
  else if (p < 0.05) stars = '*';

  return { u, p, significant, stars };
}

/**
 * 标准正态分布累积分布函数 (CDF)
 * 使用Abramowitz and Stegun近似
 */
function normalCDF(x: number): number {
  if (x < -8) return 0;
  if (x > 8) return 1;

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);

  return 0.5 * (1 + sign * y);
}

/**
 * 计算citation/year percentile
 * 每篇论文在同年份论文中的被引次数百分位
 */
export function computeCitationPercentile(
  papers: { pmid: string; citationCount: number; year: number }[]
): Map<string, number> {
  // 按年份分组
  const byYear = new Map<number, { pmid: string; citationCount: number }[]>();
  for (const p of papers) {
    if (!byYear.has(p.year)) byYear.set(p.year, []);
    byYear.get(p.year)!.push({ pmid: p.pmid, citationCount: p.citationCount });
  }

  const percentileMap = new Map<string, number>();

  for (const [, yearPapers] of byYear) {
    // 按citation降序排序
    yearPapers.sort((a, b) => b.citationCount - a.citationCount);
    const n = yearPapers.length;

    for (let i = 0; i < n; i++) {
      // percentile = 100 * (1 - rank/n)
      // rank 0 = 最高被引 = percentile 100
      const percentile = 100 * (1 - i / n);
      percentileMap.set(yearPapers[i].pmid, percentile);
    }
  }

  return percentileMap;
}
