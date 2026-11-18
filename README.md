# LITMUS · 多智能体科研创新度测度系统

> 一套面向科技论文创新性测度的多智能体协作系统。四路专业智能体并行推理、协调智能体统一调度、融合智能体加权研判，在 H1 Connect 专家标注基准上完成验证。从架构设计、服务端到前端可视化全链路实现。

**在线展示站**：<https://xinxieyeshang.github.io/litmus-showcase/>（若未上线，见下方本地运行）

---

## 一、这个项目解决什么问题

判断一篇科研论文「有没有创新性」本质上是主观、多维、难以规模化的。LITMUS 把这个问题拆成可计算、可解释、可复核的多维信号，交给一组分工明确的智能体协作完成：

- 把抽象的"创新性"拆成四路互补信号：**影响力、MeSH 领域广度、知识网络桥梁性、认知新颖性**
- 每路信号由一个独立智能体负责，可单独替换模型、独立重试，互不干扰
- 协调智能体负责分解任务、收集状态、触发融合，本身不做科学计算
- 融合智能体在**接触不到专家标签**的前提下完成加权融合，保证评估无偏
- 结果在 H1 Connect 专家标注集上验证（AUC、Precision@K、Cohen's d）

---

## 二、多智能体架构（核心）

### 星型拓扑：编排与计算解耦

```
                  ┌──────────────┐
                  │ Orchestrator │  协调中枢（不做科学计算）
                  │  协调智能体   │  任务分解 / 状态收集 / 融合触发
                  └──────┬───────┘
        ┌──────────┬─────┴─────┬──────────┐
        ▼          ▼           ▼          ▼
   S1 影响力   S2 MeSH领域  S3 知识网络  S4 认知新颖性
   LLM五维评分  NLM本体+回退  TF-IDF+中心性  Embedding+词频
        └──────────┬─────┬─────┴──────────┘
                   ▼     ▼
             ┌──────────────┐
             │ Fusion Agent │  融合与验证（不接触 H1 标签）
             └──────────────┘
```

专业智能体彼此不直接通信，只与协调智能体交互——职责单一、可独立替换、便于扩展。

### 自研通信协议与状态机

`src/communication/agent-protocol.ts` 定义了 **14 种消息类型**（`TASK_ASSIGNED` / `TASK_PROGRESS` / `TASK_COMPLETED` / `RETRY_DECIDED` / `FALLBACK_USED` / `INFO_REQUEST` / `FUSION_REQUEST` / `FUSION_COMPLETED` …）与统一消息格式（id / task_id / from / to / type / payload / timestamp）。每个智能体有 5 态状态机（IDLE / RUNNING / COMPLETED / FAILED / RETRYING），每次任务执行都有完整可追溯的执行日志。

### 实验诚信：用类型系统硬隔离数据泄漏

这是最重要的设计约束——把「科研诚信」写进代码：

- **H1 标签隔离**：协调智能体组包给融合智能体时只取 `{pmid, score}`，`FusionInput` 类型中不存在 `isH1 / h1Classification / h1Rating` 字段，编译期即无法传入标签——从结构上杜绝「看着答案打分」。
- **权重锁定**：权重在任务创建时 `Object.freeze`，流转全程只读，任何智能体不可修改。
- **公式固化**：指标公式、标准化方式、训练/验证数据划分由工具层固化，智能体无权变更。
- **权限边界**：智能体仅可自主决策五类行为——重试、调用备用工具、异常处理策略、请求补充信息、标记失败。

### 智能体的自主决策

以 S1 影响力评价智能体为例（`src/agents/signal1-agent.ts`）：

1. **前置质检**：摘要缺失或过短的论文直接标记失败并上报，不浪费 LLM 调用
2. **分批并发**：每批 50 篇、批内 8 路并发调用豆包模型，实时回报进度（进度消息每 5% 节流，避免洪泛）
3. **结构校验**：校验 score ∈ [0,1] 且五维字段齐全
4. **自主重试**：失败/校验未通过者追加一轮重试；仍失败则保留工具兜底分并如实上报，不伪造成功
5. **质检报告**：汇总 JSON 结构、摘要完整性、调用成功率三项检查

### 融合算法（`src/agents/fusion-agent.ts`）

1. 校验四路结果的 PMID 一致性、分值范围，记录异常
2. 各路 score 做 min-max 归一化
3. 退化信号（无区分度，`max-min < 1e-10`）权重置零，剩余权重重新归一化
4. `fusedScore = Σ(sᵢ·wᵢ) / Σwᵢ`；全退化兜底 0.5，不产生 NaN

### 万篇级性能工程

- `scripts/dev.sh`：S3 图计算在 5500 篇时触发 Node 默认 2.2GB 堆 OOM，将 `--max-old-space-size` 提升到 6GB
- `src/tools/signal1-tool.ts`：弃用 LangChain SDK（并发流式调用存在原生内存泄漏、实测 OOM），改用原生 `fetch` + SSE reader 逐块处理
- `src/agents/base-agent.ts`：进度消息节流、信息请求带 5 秒超时、HMR 订阅幂等（防重复注册与消息丢失）

---

## 三、技术栈

| 层 | 技术 |
|---|---|
| 框架 | Next.js 16（App Router）+ React 19 + TypeScript |
| 多智能体 | 星型编排、自研消息协议、状态机（Coze 编程环境） |
| LLM | 豆包 doubao-seed 系列（LLM 评分）、Embedding（新颖性） |
| 数据 | Supabase / PostgreSQL / Drizzle ORM / AWS S3 |
| 算法 | TF-IDF + TextRank、Brandes 中介中心性、MeSH NLM 本体、min-max 归一化、AUC / Precision@K / Cohen's d |
| 工程 | pnpm + ESLint + tsc，shadcn/ui + Tailwind 4 |
| 可视化展示站 | 原生 HTML/CSS/JS（零图表库），SVG / Canvas |

---

## 四、实证结果（来自论文 11.6 版）

- 数据规模：Nature 主数据集 3,075 篇 + MEDLINE 9,990 篇（约 1 万篇级处理）
- 最佳 ROC-AUC：0.85+（H1 Connect 专家标注基准）
- Top-K 专家认可富集：4.39×，Precision@10 = 0.70
- 多信号融合相较单信号：+30.4% AUROC（消融实验）
- 对比基线：TF-IDF、BioBERT、SBERT、LDA 等，LITMUS 优于全部基线

---

## 五、目录结构

```
src/
├── agents/          # 7 个智能体类：base / orchestrator / signal1-4 / fusion
├── communication/   # 消息协议（14 种类型）+ 消息总线
├── tools/           # 四路计算工具：LLM 评分 / MeSH / 图算法 / Embedding
├── lib/             # 算法：二分网络 / 关键词抽取 / MeSH 树 / metrics
├── state/           # 任务状态 + 执行日志
├── storage/         # Supabase / PostgreSQL schema
├── app/api/         # REST API：multi-agent / signal1-4 / task
└── components/      # React 组件
public/              # 可视化展示站（静态页面，打开即出图）
├── framework.html / dataflow.html
├── figures-v2.html / figures.html / sankey.html
└── roc-comparison.html / incremental.html
architecture.html    # 技术实现深度页
index.html           # 展示站首页
```

---

## 六、本地运行

```bash
pnpm install
pnpm dev        # http://localhost:5000
pnpm validate   # tsc + eslint 校验
pnpm build      # 生产构建
```

> 展示站为纯静态页面，直接用浏览器打开 `index.html` 即可浏览；图表数据来自 `demo-data.js`。

---

## 七、可视化展示站

| 页面 | 内容 |
|---|---|
| `index.html` | 首页：架构、工程能力、技术深度入口 |
| `architecture.html` | **技术深度页**：星型拓扑、消息协议、诚信设计、融合算法、性能调优 |
| `public/figures-v2.html` | 招牌页：打开即自动生成 11 张发表级图表 |
| `public/framework.html` / `dataflow.html` | 系统框架与数据流 |
| `public/sankey.html` / `figures.html` / `roc-comparison.html` / `incremental.html` | 交互可视化 |

---

作者：xinxieyeshang · GitHub：<https://github.com/xinxieyeshang>
