# AGENTS.md

## 项目概览

LITMUS 实验平台 - 科技论文创新性测度的四个信号实验验证工具。

- **框架**: Next.js 16 (App Router) + React 19
- **语言**: TypeScript 5
- **UI**: shadcn/ui + Tailwind CSS 4
- **LLM**: coze-coding-dev-sdk (LLMClient)
- **Embedding**: coze-coding-dev-sdk (EmbeddingClient)
- **图表**: Recharts
- **Excel解析**: xlsx (SheetJS)
- **数据库**: Supabase (PostgreSQL)

## 目录结构

```
src/
  app/
    page.tsx               # 主页面（客户端组件，含所有UI逻辑）
    layout.tsx             # 根布局
    api/
      signal1/route.ts     # 信号1：LLM影响力/重要性推断
      signal2/route.ts     # 信号2：MeSH主题广度与跨域性
      signal3/route.ts     # 信号3：知识网络桥梁性（TF-IDF+TextRank→二分网络→Betweenness）
      signal4/route.ts     # 信号4：认知偏离度（内部相对法+概念频率法）
      multi-agent/
        route.ts           # POST 启动多智能体任务
        status/route.ts    # GET 任务状态+各Agent快照
        stream/route.ts    # GET SSE消息流（先回放历史再实时推）
        result/route.ts    # GET 完整结果（仅此端点回传H1标签）
  agents/                  # 多智能体层（决策/协调，不含科学计算）
    base-agent.ts          # 状态机(IDLE/RUNNING/COMPLETED/FAILED/RETRYING)+消息收发+activate()
    orchestrator-agent.ts  # 协调智能体：任务分解/状态收集/H1剥离组包融合/getAgentRuntime单例
    signal1-agent.ts       # 影响力评价：MIN_ABSTRACT_LEN前置检查/JSON校验/重试队列/质检
    signal2-agent.ts       # MeSH领域：LOW_COVERAGE_THRESHOLD=0.3/回退上报/覆盖率监控
    signal3-agent.ts       # 知识网络：关键词质量/稀疏>0.95/退化网络检测/受控重试
    signal4-agent.ts       # 认知新颖性：EMBEDDING_FAIL_RATE_ALERT=0.1/dim=0直接失败/双分支
    fusion-agent.ts        # 融合与验证：PMID一致性/缺失/范围校验，锁定权重融合
  tools/                   # 工具层（纯函数，科学计算规则固化，Agent不可改）
    signal1-tool.ts        # 原生fetch SSE调豆包（8并发/90s超时/llmFailed标记）
    signal2-tool.ts        # MeSH广度（公式与/api/signal2路由完全一致）
    signal3-tool.ts        # TF-IDF+TextRank+二分网络+Brandes Betweenness
    signal4-tool.ts        # Embedding语义偏离+MeSH概念频率（embeddingFailed追踪）
  communication/           # 通信层
    agent-protocol.ts      # 消息类型/AgentMessage格式/QualityCheck
    message-bus.ts         # 进程内pub/sub星型拓扑（globalThis单例）
  state/                   # 状态层
    task-state.ts          # LitmusTask/LockedWeights(readonly+Object.freeze)/h1Map隔离存储
    execution-log.ts       # 执行日志环形缓冲3000条（SSE回放源）
  lib/
    types.ts               # 类型定义
    metrics.ts             # AUC/指标计算工具
    mesh-domains.ts        # MeSH领域分类工具（关键词匹配，fallback）
    mesh-tree.ts           # MeSH官方树状编号映射 + 8大领域分类（优先方案B）
    keyword-extraction.ts  # TF-IDF + TextRank关键词提取（含学术停用词、词干合并）
    bipartite-network.ts   # 二分网络构建 + Brandes算法Betweenness Centrality
    utils.ts               # shadcn工具函数
  storage/database/
    shared/schema.ts       # Drizzle表结构定义（background_tasks/task_results/paper_cache/task_metrics）
    supabase-client.ts     # Supabase客户端初始化
  components/
    ui/                    # shadcn/ui组件
    multi-agent-panel.tsx  # 多智能体面板（状态卡片/SSE消息流/结果回灌）
```

## 多智能体系统（MAS）

**架构**：协调智能体 → TASK_ASSIGNED → 四专业智能体并行 → TASK_COMPLETED → （H1剥离）FUSION_REQUEST → 融合智能体 → FUSION_COMPLETED → 任务完成。星型拓扑，专业智能体只与协调智能体通信，全部消息落执行日志。

**Agent 权限边界（硬约束）**：
- 可自主：重试、调用备用工具、异常处理策略、请求补充信息（INFO_REQUEST）、标记失败
- 不可改变：指标公式、标准化方式、融合权重、训练/验证数据划分、H1标签
- 权重在任务创建时锁定（`readonly` + `Object.freeze`）；退化信号权重置零是既定融合公式的一部分（与前端 fusionResults 完全一致，已数值对照验证误差<1e-9）
- **H1 类型级隔离**：FusionInput 类型不存在 H1 字段；orchestrator 组包时剥离；h1Map 仅经 `/api/multi-agent/result` 回传前端

**关键实现约束**：
- BaseAgent 构造函数不能访问抽象属性 `this.name`（TS2715）→ 订阅在 `activate()` 中完成，`getAgentRuntime()` 必须先 activate 再返回，否则 `startTask` 同步发布的 TASK_ASSIGNED 因订阅未生效而丢失（曾致全部 Agent 卡 IDLE）
- 所有单例（bus/log/store/runtime）挂 `globalThis` 防 HMR 丢失
- 多智能体路径与旧路径（4个独立API路由）并存，结果可互相回灌

## 构建和测试命令

- `pnpm dev` - 开发环境（端口5000）
- `pnpm build` - 构建
- `pnpm start` - 生产环境
- `pnpm ts-check` - TypeScript类型检查
- `pnpm lint` - ESLint检查
- `coze-coding-ai db generate-models` - 同步数据库模型
- `coze-coding-ai db upgrade` - 同步表结构到数据库

## 核心数据流

1. 用户上传论文Excel（PMID/Title/Abstract/MeSH）+ H1标签Excel（PMID/Classification/Rating）
2. 前端用xlsx库解析Excel，匹配PMID后存入React state
3. 各信号API接收JSON数据，处理后返回结果
4. 前端计算指标（AUC、Precision@K、Cohen's d）并展示

## API接口

| 路由 | 方法 | 说明 | 依赖 |
|------|------|------|------|
| /api/signal1 | POST | LLM影响力/重要性推断（5维：范式突破/方法创新/概念拓展/临床转化/增量贡献） | LLM API |
| /api/signal2 | POST | MeSH广度计算（含hasMesh去偏 + MeSH官方API树状编号分类） | MeSH Browser API |
| /api/signal3 | POST | 知识网络桥梁性（TF-IDF+TextRank关键词→二分网络→Brandes Betweenness） | 纯计算 |
| /api/signal4 | POST | 认知偏离度（内部相对法：语义偏离度 + 概念频率法：低频MeSH词占比） | Embedding API |

## 注意事项

- LLM调用使用 `coze-coding-dev-sdk` 的 `LLMClient`，必须在后端使用
- ⚠️ **Signal 1 已改用原生 fetch + SSE 调用 LLM，不再使用 LLMClient/LangChain**：实测 coze-coding-dev-sdk 0.7.16（LangChain ChatOpenAI 流式）在 Next.js 服务进程内 8 路并发时产生进程级原生内存（ArrayBuffer/external，V8堆稳定仅~150MB）线性膨胀，20篇约55秒从0.7GB涨到7GB+被OOM Killer杀掉，表现为前端"连接断开"、S1整体失败；独立node进程同SDK仅~120MB（问题仅在Next运行时+LangChain组合下出现）。原生fetch SSE对照实验：20/50篇8路并发RSS稳定~1.47GB。配置仍从SDK的`Config`/`HeaderUtils`取（apiKey/modelBaseUrl/转发头），模型doubao-seed-2-0-lite-260215，POST `${modelBaseUrl}/chat/completions` stream:true，逐chunk读delta.content后主动reader.cancel()。**禁止把signal1改回LLMClient**，除非SDK修复该内存问题并重新压测
- Embedding调用使用 `EmbeddingClient`，必须逐篇调用 `embedText()` 而非 `embedTexts()`（后者有SDK bug返回扁平数组）
- 消息类型必须显式标注 role 类型：`Array<{ role: 'system' | 'user' | 'assistant'; content: string }>`
- 信号1的prompt已从"创新类型"改为"影响力/重要性"判断，与F1000Prime评价标准对齐
- 信号2对MeSH=0论文给予0.25固定低分而非0，避免二值化偏倚
- 信号2已从硬编码关键词匹配改为MeSH官方树状编号分类（`mesh-tree.ts`），调用 `https://id.nlm.nih.gov/mesh/` API获取准确树状编号
- 信号2响应中包含 `treeNumberStats` 字段（totalUniqueTerms/termsFoundInMesh/coverage/source），便于监控API覆盖率
- 信号2使用进程级缓存避免重复查询，单次请求支持8路并发+每词3次重试，整体超时30秒
- 信号3已从LLM声明强度分析改为纯计算的关键词网络桥梁性：processDocument→extractKeywords(TF-IDF+TextRank)→buildNetworkAndCompute(二分网络+Brandes Betweenness)
- 信号3是纯计算，可即时返回，无需LLM API
- 信号4是认知偏离度指标，结合内部相对法（语义偏离度）和概念频率法（低频MeSH词占比）
- 信号4使用Embedding API计算论文间的语义相似度，需要传入allPapers参数用于内部比较
- 信号4返回semanticDeviation（语义偏离度）、conceptRarity（概念罕见度）、noveltyScore（综合新颖性分数）
- 信号4相似度已改为均值向量恒等式：avgSim_i = (u_i·Σu_j − 1)/(N−1)，O(N·D)，与逐对余弦结果严格相等（浮点误差~1e-15），maxDuration=600
- 信号3投影防OOM：出现在>500篇论文中的通用词不展开clique（MAX_CLIQUE_DF，完全图内部无桥梁信息），maxDuration=300
- scripts/dev.sh 和 start.sh 已设 NODE_OPTIONS=--max-old-space-size=6144（沙箱8GB内存，Node默认堆2.2GB曾在5500篇S3下OOM）
- 信号1前端批次默认20（可调至50），路由8路并发+maxDuration=600；结果数组按1秒节流+startTransition刷新（中间批次不触发下游重算），fusionInputs按status门控稳定化
- **断点续跑（IndexedDB）**：`src/lib/idb-cache.ts` 持久化 papers（含H1标注）+ S1增量结果 + S2/S3/S4整体结果 + 会话meta（papersHash指纹）。S1每批增量落盘，刷新/崩溃后页面顶部出现恢复提示条，「恢复会话」还原全部数据与信号状态；S1未跑完时按钮显示"继续运行（剩余N篇）"自动跳过已完成PMID。上传新数据集（指纹不匹配）自动清空旧缓存；已有完整结果时点"重新运行"会清断点从头算。IndexedDB不可用（隐私模式）时静默降级为无缓存
- 列名兼容：数据集A用 Time（如"2021-Apr"）/MeSH词/论文类型，对比集用 Classifications/Evaluation Rating，extractValue按"先精确后子串"匹配

- 融合权重默认：Signal1=0.50, Signal2=0.30, Signal3=0.05, Signal4=0.15
- 融合时自动检测退化信号（全相同值），将其权重置零并重新归一化
- minMaxNormalize对退化情况（max=min）返回0.5而非NaN
