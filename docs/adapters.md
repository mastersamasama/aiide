# External Runtime Adapters（外部 runtime / 現成 AI 產品接入）

aiide 的 lab 不只能測 Claude Code——任何 agent（網站服務、自建 agent loop、其他 CLI）
都能透過 **command adapter** 接入同一套 suite / 評分 / 對比管線。產品完全黑箱、零改動。

本文四段：**§1 快速开始**（10 行接入 + 升级路径）→ **§2 逐信号指南**（trace / usage /
semantics / self-descriptor 各怎么回报）→ **§3 参考**（完整 schema、诚实降级、顺序语义、
provenance、反作弊条款）→ **§4 运行与生命周期**（runtime.service / BYOK / okx 实例 /
Playwright / 评测可靠性字段，原文平移）。文中所有 adapter 输出示例同时收录于
`test/fixtures/adapter-check/*.json`，随测试套件跑 `aiide adapter check` 全绿——文档即测试素材。

---

## §1 快速开始（quick start）

三級保真度：

| 被測產品形態 | 接法 | 可得評分 |
|---|---|---|
| CLI / 可執行程式 | command adapter 直接包 | 有 trace → C/P/R；有 usage → +H |
| HTTP/WS API 服務 | command adapter + **`runtime.service` 生命週期**（§4.1） | 同上；aiide 代管服務啟停 |
| 純網頁 UI | Playwright driver（§4.4） | 基本 completion-only（只有 C） |

### 1.1 最小骨架（约 10 行，completion-only）

一个 adapter（驱动器，driver）就是一个进程：收 prompt、调你的产品、往 stdout 打印
**一个 JSON 对象**。最小合法输出只有一个必填字段：

```js
#!/usr/bin/env node
// my-driver.mjs — 最小 command adapter（completion-only）
const prompt = process.argv[2];
const answer = await callMyProduct(prompt);        // ← 你的产品调用（HTTP/SDK/子进程均可）
console.log(JSON.stringify({ result: answer }));   // result 是唯一必填字段
```

对应输出（`test/fixtures/adapter-check/01-minimal.json`）：

```json
{ "result": "ETH 当前价格为 $1,999.42。" }
```

> **诚实标注**：上面是骨架，不是终点。一个对接真实 HTTP/SSE 服务的 driver（连接管理、
> 流式帧解析、trace 组装、错误归一化）通常在 **100-200 行**——见 §4.2 的 okx 实例
> （`adapters/okx-demo-sse-driver.mjs`）。

### 1.2 在 suite 里声明 runtime

```jsonc
{
  "name": "my-suite",
  "runtime": {
    "type": "command",
    "name": "okx-onchainos-demo",          // 顯示名
    "cmd": "node",
    "args": ["{{SUITE_DIR}}/../adapters/my-driver.mjs", "{{PROMPT}}"],
    "cwd": "optional/working/dir",          // 省略 = 每 repeat 的空 workspace
    "env": { "MY_DRIVER_FLAG": "1" }        // 傳給 driver 的 env
  },
  "tasks": [ { "id": "...", "prompt": "...", "verifiers": [ ... ] } ]
}
```

佔位符：`{{PROMPT}}`、`{{MODEL}}`、`{{SUITE_DIR}}`（suite 檔所在目錄，方便相對引用 driver）。
aiide 對每個 repeat spawn 該命令，讀取 stdout 的 JSON。

### 1.3 四步升级路径（upgrade path）

升级是**加法式**的：每一步只是往同一个 JSON 里多放几个选填字段，永不破坏已有接入。
这只是章节导航，不是等级制——每类信号独立点亮各自的统计。

```
completion ──→ +trace(+cost) ──→ +semantics ──→ +self-descriptor
   只有 C        P/R（+H/成本）    触发/引用覆盖      运行环境指纹
   (§1.1)          (§2.1/§2.2)       (§2.3)          (§2.4, Wave 2)
```

**信号→统计对照表**：你多回报一类信号，dashboard 就多亮一排——

| 你回报的字段（signal） | 点亮的统计（lights up） | 缺失时（honest n/a） |
|---|---|---|
| `result`（必填） | C（正确性）、pass@k | —— |
| `trace[]`（轮次+toolCalls） | P/R 维度、逐轮 timeline、工具调用统计 | P/R 显示 n/a（completion-only） |
| `usage` / `total_cost_usd` | H（context 健康度）、token/成本统计、context 曲线 | H 显示 n/a、复合分标 partial dims |
| `triggers` | activation、触发覆盖（trigger coverage）、primary 归因 | activation 显示 n/a，不惩罚 |
| `refReads` | 引用读取覆盖（refCoverage 分子）、blocked 豁免 | 读取覆盖显示 n/a |
| `skills_inventory` | 引用覆盖分母（inventoryStatus=adapter-declared） | 分母不可知（external-runtime） |
| `runtime_info` | 运行环境指纹；compare/upgrade 环境 diff（Wave 2） | 自述显示 n/a |

### 1.4 第一次机械体检（`aiide adapter check`）

写完 driver，先别跑整个 suite——单发跑一次、把输出喂给 check：

```
node my-driver.mjs "price of ETH" > out.json
aiide adapter check out.json          # 人读：fatal/warning + 通道存在性报告
aiide adapter check out.json --json   # 机读：CI 里用
```

fatal（schema 违约）→ exit 1；warning（疑似笔误、未知值）→ exit 0 但逐条列出。
**范围声明（check 每次都会自己打印）**：单发检查只验 schema 与通道形状；触发覆盖、
清单/自述漂移是跨 repeat 性质，只有实验封存对帐（seal reconciliation）能验——check
绝不为它们发假绿灯。命名注意：`aiide up` 是 dashboard、`aiide upgrade` 是升级管线，
本命令是 `aiide adapter check`。

---

## §2 逐信号指南（per-signal guide）

### 2.1 trace——工具事实与逐轮时间线

`trace` 是一个轮次（round）数组：每轮是模型的一次回复，可携带工具调用事实
（tool facts）。有 trace 才有 P/R 与 dashboard 的逐轮 timeline。

示例（`test/fixtures/adapter-check/02-trace-cost.json`，同时含 §2.2 的 usage/cost）：

```json
{
  "result": "ETH 当前价格为 $1,999.42。",
  "total_cost_usd": 0.012,
  "runtime_version": "2.1.0",
  "trace": [
    {
      "text": "查询 DEX 行情……",
      "durationMs": 1200,
      "usage": { "in": 1000, "out": 50, "cacheW": 0, "cacheR": 2000 },
      "toolCalls": [
        { "name": "market_price", "isError": false,
          "input": { "symbol": "ETH" }, "result": "{\"price\":\"1999.42\"}", "denialKind": null }
      ]
    },
    { "text": "ETH 当前价格为 $1,999.42。", "durationMs": 300,
      "usage": { "in": 1200, "out": 80, "cacheW": 0, "cacheR": 2000 } }
  ]
}
```

要点：

- 每轮报**实际发生**的工具调用；轮次顺序就是事实顺序（顺序语义见 §3.3）。
- `denialKind`：工具调用被权限/用户拦下时置为非 null 字符串（值域见 §3.5）。
  **非 null 即 denial 事实**——normalization 原值保留、绝不降 null；建议 denial 事件
  同时带 `isError: true` 作纵深。
- 轮级 `skill` 字段（round 归因，attributionSkill）是旧式归因通道，仍被消费端折入
  触发口径——但新 adapter 应直接用 §2.3 的显式 `triggers`。

**check 工作流**：`aiide adapter check out.json` 应显示
`✓ trace — 将点亮：P/R 维度、逐轮 timeline、工具调用统计（tool facts）`。

### 2.2 usage——token 与 context 健康（cost）

每轮选填 `usage: { in, out, cacheW, cacheR }`（token 数）与顶层 `total_cost_usd`。

- **缺席保真（null-not-zero）**：某轮拿不到 usage 就**不要写这个键**——「没报」≠「报了 0」。
  缺席轮的 context 记 null，绝不折成 0。
- H 的点亮条件（gate）：任一轮 usage 非 null **且** 峰值 context > 0。全 0 的 usage
  不会产出健康满分（那是比缺席更糟的假信号），也不会点亮 H。
- usage 缺席不会让该 repeat 变 error rep；工具错误率照常计算。

**check 工作流**：有任一轮携 `usage` → check 报
`✓ usage — 将点亮：H（context 健康度）、token/成本统计、context 曲线（sparkline）`；
全部缺席 → `✗ 缺 usage → H 显示 n/a（复合分按可用维度重归一化，标 partial dims）`。

### 2.3 semantics——triggers / refReads / skills_inventory

> **适用性判定（applicability gate）**：你的 runtime 有「按需启用的 prompt 模块
> （skill）+ 随附参考文档（references）」吗？**没有 → 跳过本节**，你的诚实上限是
> trace + cost + self-descriptor——这不是缺陷，是如实刻画。硬造语义信号只会污染对帐。

**反模式清单（anti-patterns）**：

- **工具选择 ≠ trigger**。模型每轮选了哪个工具是工具事实（§2.1 已覆盖），不是
  「按需启用了一个 prompt 模块」。把每次工具调用报成 trigger 会灌爆触发覆盖。
- **RAG 检索 ≠ refRead**。除非你的检索结果有**稳定的 ref 命名空间**
  （`<skill>/references/<relpath>`，同一文档每次同名），否则报 refRead 只会制造
  不可对帐的噪音。

三个字段（示例 `test/fixtures/adapter-check/03-semantics.json`）：

```json
{
  "result": "ETH 当前价格为 $1,999.42。",
  "observability": ["trace", "triggers", "refReads", "skills_inventory"],
  "skills_inventory": {
    "okx-dex-market": {
      "versionSha": "9f2c1ab04d77e6b2",
      "refs": [
        "okx-dex-market/references/api.md",
        "okx-dex-market/references/endpoints.md"
      ]
    }
  },
  "trace": [
    {
      "text": "启用行情模块并读取 API 文档",
      "triggers": ["okx-dex-market"],
      "refReads": [
        { "skill": "okx-dex-market", "ref": "okx-dex-market/references/api.md", "status": "ok" }
      ]
    },
    { "text": "ETH 当前价格为 $1,999.42。", "triggers": [], "refReads": [] }
  ]
}
```

- `triggers`（轮级）：本轮**实际启用**的 skill 名数组。显式空数组 `[]` 是有效的通道
  证据（「本轮确认没有触发」）；**不写这个键**才是「没有该通道」——absent ≠ []。
- `refReads`（轮级）：本轮实际读取的参考文档。`ref` 必须是
  `<skill>/references/<relpath>` 形且与 `skill` 字段一致（**check fatal**）；
  `status` 只有 `'ok'`（默认）| `'blocked'`（被权限拦下——blocked 不入读取分子、
  入豁免清单）。
- `skills_inventory`（顶层）：本次运行装载的 skill 清单
  `{ [skill]: { versionSha, refs: [...] } }`。它是引用覆盖的**分母**
  （inventoryStatus=adapter-declared）；每条 ref 必须以 `<该键 skill>/references/`
  开头（**check fatal**；seal 侧同规则降 warning）。清单外的读取照收（分子可超集），
  以「另有 k 笔清单外读取（自报）」独立揭露。
- `observability`（顶层，选填）：自声明本 adapter 支持哪些通道（值 = 字段原拼写）。
  只用于 seal 对帐的 declared-but-silent 检查（「声明了却整个实验没出现」），不影响统计。

**check 工作流**：`aiide adapter check out.json` 验 ref 命名空间/清单前缀（fatal）、
键名笔误（near-miss warning，如 `trigers`）与未知 `status` 值（warning）。触发覆盖率、
「宣告 trigger ∉ 清单」等合理性 lint 是跨 repeat 对帐性质——留给 `aiide lab run` 封存
时的 seal reconciliation，check 不假装能验。

### 2.4 self-descriptor——runtime_info（运行时自述）

> **Wave 2 注记（诚实揭露）**：self-descriptor 的**消费端属 Wave 2**——schema 已定
> （本节即契约、封存链路已通），但 dashboard 环境卡与 compare/upgrade 的 runtime_info
> diff 表**尚未上线**。现在回报，封存即生效；UI 跟进后历史实验自动点亮。

示例（`test/fixtures/adapter-check/04-self-descriptor.json`）：

```json
{
  "result": "ETH 当前价格为 $1,999.42。",
  "observability": ["runtime_info"],
  "runtime_info": {
    "name": "my-agent-loop",
    "version": "0.9.3",
    "systemPrompt": {
      "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "bytes": 5211,
      "tokensEst": 1600
    },
    "tools": ["market_price", "wallet_status"],
    "defaults": { "temperature": 0 }
  }
}
```

- **指纹优先**：给 `systemPromptText`（全文）→ aiide **重算** sha256/bytes/tokensEst
  覆盖任何自报数字（可验胜自报），全文按内容寻址落盘；只给 `systemPrompt` 指纹 →
  照存但标 `selfReported: true`（不可验，如实揭露）。tokensEst 恒为估算
  （tokensEstCJK，非中文文本偏差较大）。
- **隐私说明**：`systemPromptText` 明文留存本机
  `<data-dir>/logs/runtime-info/system-prompt-<sha256 前 12>.txt`——跨实验共享的
  内容寻址池（同内容一份、漂移各版本并存），删单一实验**不**删档；prune 工具未来纳管。
  不想留明文就只报指纹。
- 跨 repeat 的自述漂移（drift）在封存时机械检出并警告（分母 = non-excluded reps）。

**check 工作流**：`aiide adapter check out.json` 报
`✓ runtime_info — 将点亮：运行时自述指纹（self-descriptor）——消费端属 Wave 2……`。

---

## §3 参考（reference）

### 3.1 完整 schema 表

**顶层（top-level）**——全部字段中只有 `result` 必填，其余选填、加法式、无版本字段：

| 字段 | 类型 | 必选 | 默认 | 说明 / 值域 |
|---|---|---|---|---|
| `result` | string | **必填** | — | verifiers 跑在它上面；缺失/非字符串 = check fatal |
| `total_cost_usd` | number | 选填 | null | 真实成本 |
| `runtime_version` | string | 选填 | null | 被测产品版本 |
| `session_id` | string | 选填 | null | 产品侧会话标识 |
| `trace` | Round[] | 选填 | 无 | 无 trace = completion-only |
| `observability` | string[] | 选填 | 无 | 自声明通道；值 = 字段原拼写（`trace`/`usage`/`triggers`/`refReads`/`skills_inventory`/`runtime_info`） |
| `skills_inventory` | `{ [skill]: { versionSha, refs[] } }` | 选填 | 无 | refs 前缀违规 = check fatal / seal warning |
| `runtime_info` | object | 选填 | 无 | 见 §2.4 |
| `x_*` | 任意 | 选填 | — | 自定义字段的正规出口（§3.5） |

**轮（Round，trace 数组元素）**：

| 字段 | 类型 | 必选 | 默认 | 说明 |
|---|---|---|---|---|
| `text` | string | 建议 | `''` | 该轮助手文本 |
| `skill` | string | 选填 | null | 轮级归因（attributionSkill）；消费端折入触发口径 |
| `durationMs` | number | 选填 | 0 | |
| `ts` | string/number | 选填 | null | |
| `model` | string | 选填 | 继承 suite | |
| `usage` | `{in,out,cacheW,cacheR}` | 选填 | **null（缺席保真）** | 缺席 ≠ 0；对象内缺桶补 0 |
| `toolCalls` | ToolCall[] | 选填 | `[]` | 工具事实 |
| `triggers` | string[] | 选填 | 无 | **absent ≠ []**：键在场（含空数组）才算通道存在 |
| `refReads` | RefRead[] | 选填 | 无 | 同上 |
| `stopReason` | string | 选填 | null | 值域参考 `end_turn`/`max_tokens`/`tool_use`/`stop_sequence`，未知值保留原值进 truncation `byReason`；normalization 落独立字段 `declaredStopReason`——**不参与 L3 confirm-turn 判定**（结构性豁免，见 adapter-observability-design.md a1 amendment） |

**ToolCall**：

| 字段 | 类型 | 必选 | 默认 | 说明 / 值域 |
|---|---|---|---|---|
| `name` | string | 建议 | `'tool'` | |
| `id` | string | 选填 | null | |
| `input` | any | 选填 | null | |
| `result` | string | 选填 | null | |
| `isError` | boolean | 选填 | false | |
| `denialKind` | string \| null | 选填 | null | 非 null 非字符串 = check fatal；值域见 §3.5 |
| `kind` | string | 选填 | null | 工具分类自报，闭集 `skill`/`agent`/`mcp`/`builtin`/`other`（`src/adaptercheck.js` `TOOL_KINDS`）；值域外 = check warning，统计层归 `'other'` + warning；缺席 → 按名字推断（inferred）。normalization 落独立字段 `declaredKind` |

**RefRead**：

| 字段 | 类型 | 必选 | 默认 | 说明 / 值域 |
|---|---|---|---|---|
| `ref` | string | **必填** | — | `<skill>/references/<relpath>`；违形 = check fatal |
| `skill` | string | 建议 | null | 给了就必须与 ref 前缀一致（check fatal） |
| `status` | `'ok'` \| `'blocked'` | 选填 | `'ok'` | 未知值 = check warning，normalization 按 `'ok'` |

**runtime_info**：

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `name` / `version` | string | 选填 | 运行时名与版本 |
| `systemPromptText` | string | 选填 | 全文 → aiide 重算指纹并落盘（§2.4 隐私说明） |
| `systemPrompt` | `{sha256,bytes,tokensEst}` | 选填 | 仅指纹 → 标 `selfReported: true` |
| `tools` | string[] | 选填 | 工具清单（不从用量反推） |
| `defaults` | object | 选填 | 温度等默认参数 |

### 3.2 诚实降级规则表（绝不灌零、也绝不假满分）

| 情形 | 显示 | 绝不发生 |
|---|---|---|
| 无 `trace` | completion-only：只算 C；P/H/activation 全 n/a | 不把缺信号算 0 分 |
| trace 无 `usage` | H 显示 n/a，复合分按可用维度重归一化并标 `partial dims` | context 0 不当「健康满分」 |
| usage **全 0**（非缺席） | H 仍 null（gate = 任一轮 usage 非 null 且峰值 context > 0） | 不产 margin=1 的假满分 |
| usage 缺席的轮 | 该轮 context 记 null；rep 不变 error rep；toolErr 照计 | 不把 null 折 0（no `Math.max(0,…)`） |
| task 无 `targetSkills` | activation 显示 n/a | 不惩罚 P/R |
| 无 `skills_inventory` | 引用覆盖分母不可知（inventoryStatus=external-runtime） | 合理性 lint 整组跳过——不可知不当 0 用 |
| 清单仅 excluded rep 携带 | 不 hoist + warning，observedSignals.inventory=false | 不从被剔除样本灌值 |
| adapter-declared 清单 | 每 ref 行 bytes=null + reason:'adapter-declared' | 不落 `{}` 假可知 |

### 3.3 顺序语义（ordering semantics）

- `triggers`/`refReads` **顺序有效**，且必须报在**实际发生的那一轮**——把整场的触发
  批次塞进首轮 = 违约（归 §3.5 诚实条款）。
- 合并排序（喂 triggerSet/readSet/primary 归因）：**轮序 → 同轮内工具事实先于宣告 →
  宣告内部 `triggers` 数组序先、轮级 `skill`（attributionSkill）折入殿后**。
  primary skill = 合并排序后的首个 trigger 事件，不论来源。
- 宣告事件**没有 ordinal**（事件序号轴只属于工具事实）：proximity 等 ordinal 消费者
  对宣告事件输出 `axesOmitted`（机械 n/a 槽位），绝不合成假精度。

### 3.4 provenance 与不可比规则

- provenance 按 **run 来源**判定，实验级单值：`harness-observed`（Claude Code 会话
  JSONL，由与被测 skill 无关的参考 runtime 序列化、harness 独立解析）vs
  `adapter-reported`（一切经 adapter stdout 进来的信号——**整条 trace 都是自报**，
  trace 里内嵌的 Skill/Read toolCall 与宣告字段同一信任级）。
- compare/upgrade 的覆盖率家族 delta 标「口径不同不可比」**当且仅当恰一侧为
  adapter-reported**；legacy 实验（无此字段）按 runtime 推导，不受误伤。
- adapter-reported 下，覆盖率面板与治理级建议卡渲染
  「基于 runtime 自报信号（adapter-reported）」徽章。
- 已知弱化（如实记录）：upgrade 场景测新版 CLI 时，日志生产者恰是受测物本身——
  harness-observed 的独立性论证在该场景弱化。

### 3.5 反作弊诚实条款、denialKind 值域、x_ 命名空间

- **自报信号不可防伪**（外部 runtime 想编数据没人拦得住）。契约不做防伪机制，
  以**揭露（calibre disclosure）**应对：dashboard/报告处处标「自报」徽章、封存时跑
  合理性 lint（宣告 trigger ∉ 清单、单轮宣告数 > 清单规模、ref/skill 前缀不一致——
  三条均以 inventory 为分母，清单缺席整组跳过）、观测量词只计通道存在性、
  声明与实际出现对帐（declared-but-silent）。评分解读始终连同 provenance 一起呈现。
- **denialKind 值域**：已知闭集当前为 `'user-rejected'`（单一常数
  `src/adaptercheck.js` 的 `DENIAL_KINDS`——check 与 seal 侧共用同一模块的键名/值域
  常数，两个验证器永不漂移）。**未知非 null 值保留原值、照算
  denial 事实**（绝不降 null——那会把拒绝反转成成功读取）；check 对未知值只发
  warning，fatal 只留结构性错误（非 null 非字符串）。
- **`x_` 命名空间**：adapter 自定义字段的正规出口。`x_` 前缀的键（任意层）永不参与
  near-miss 键名比对、永不触发警告；纯未知键也不警告（向前相容），但拼写与已知选填
  键 edit distance ≤ 2 的键（如 `trigers`）会收到 near-miss warning——静默写错键名
  等于整条通道悄悄丢失。

### 3.6 已知口径差（known caliber gaps，如实登记）

| 口径差 | 说明 |
|---|---|
| SKILL.md / `_shared` | 宣告制只有 `references/` 命名空间；claude-code 快照侧的 SKILL.md 正文与 `_shared` 哈希命名空间无宣告等价物 |
| usage 全 0 vs 缺席 | claude-code parser 保零骨架，两者封存位相同（不可分）；adapter 路径可分且必须如实区分 |
| activation ⊃ 覆盖率 trigger | claude-code 的 activation 口径含 attributionSkill/sidechain，宽于覆盖率家族的工具事实口径（既有行为，不随本波改动） |
| gradeRouting（L1） | routing verdict 只认工具事实 Skill 调用，不随本波扩宣告口径（adapter arm 进 upgrade verdict 前需另行裁决） |
| upgrade 日志生产者 | 见 §3.4 已知弱化 |

### 3.7 `aiide adapter check` 参考

```
aiide adapter check <output.json>          # 人读报告
aiide adapter check <output.json> --json   # 机读（shape 见下）
```

- **fatal（exit 1）**：JSON 不可解析；`result` 缺失/非字符串；`refReads[].ref` 违形或
  与 `skill` 前缀不一致；`skills_inventory` ref 前缀违规；`denialKind` 非 null 非字符串。
- **warning（exit 0，逐条列出）**：near-miss 键名（`x_` 豁免）；未知 `denialKind` 值；
  未知 `refReads[].status`。纯未知键不警告。
- **通道存在性报告**：逐通道 `✓ <通道> — 将点亮：<统计清单>` / `✗ 缺 <通道> → <统计> 显示 n/a`。
- `--json` 输出形状：`{ ok, fatals[], warnings[], channels{trace,usage,triggers,refReads,skills_inventory,runtime_info,observability}|null, lit[{channel,stats}], missing[{channel,effect}], scope }`
  （JSON 不可解析时 `channels: null`——存在性不可知，绝不报成「全缺席」）。
- **范围声明恒印**：单发检查只验 schema 与通道形状；触发覆盖、清单/自述漂移是跨
  repeat 性质，只有实验封存对帐（seal reconciliation）能验。

全信号绿样例见 `test/fixtures/adapter-check/05-full.json`（含 blocked refRead、
`user-rejected` denial 与 `x_` 自定义字段，check 全绿零警告）。

---

## §4 运行与生命周期（原文平移，零内容净损）

### 4.1 `runtime.service`：讓 aiide 代管被測服務（★ 推薦用於 HTTP 服務型產品）

很多產品把 model/provider **固定在進程啟動時**（env）。`runtime.service` 讓 aiide 接管
服務生命週期，於是 `--models a,b` 可以逐 model 重啟服務、每輪保證命中正確配置：

```jsonc
"runtime": {
  "type": "command",
  "cmd": "node", "args": ["{{SUITE_DIR}}/../adapters/okx-demo-sse-driver.mjs", "{{PROMPT}}"],
  "service": {
    "cmd": "bun", "args": ["server/server.ts"],
    "cwd": "/path/to/your-demo-server",              // 你被測服務的目錄
    "env": { "AI_MODEL": "{{MODEL}}", "ENABLE_SSE": "1", "PORT": "3901" },
    "readyUrl": "http://127.0.0.1:3901/api/chats",   // poll 到 200 才開跑
    "readyTimeoutMs": 45000,
    "requiredEnv": ["ANTHROPIC_API_KEY"],             // BYOK key —— 見下
    "requiredCli": ["bun", "onchainos"]               // 缺失 → 警告
  }
}
```

執行順序：requiredEnv 檢查 → **port 佔用 preflight**（readyUrl 已有回應 = 拒跑，防止誤測
手動啟動的舊實例）→ spawn（env 三層合併，見下）→ poll readyUrl → 跑完所有 task×repeat →
**finally 必殺** 服務進程樹。driver 子進程會拿到 `AIIDE_SERVICE_URL` env。

#### BYOK key 怎麼給（永不落盤、永不入庫）

env 三層合併（後者覆蓋前者）：**shell env → `<data-dir>/service.env` → suite 的 service.env**。

```powershell
# 方式一：本次 shell
$env:ANTHROPIC_API_KEY = "sk-..."

# 方式二：一次設定（本機檔，勿提交）—— .aiide/service.env
ANTHROPIC_API_KEY=sk-...
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic   # 用 DeepSeek BYOK 時
```

aiide 只在 experiment 記錄 **env 變數名清單與 endpoint host**（如 `api.deepseek.com`），
值永不記錄。缺 key 時 CLI 會印出上述精確步驟。

#### 換 LLM provider（DeepSeek / GPT / …）

被測產品若用 `@anthropic-ai/sdk` 且未寫死 baseURL，SDK 原生支援 `ANTHROPIC_BASE_URL`：

```
aiide lab run --suite suites/onchainos-basic.json --models DeepSeek-V4-Pro
```

搭配 service.env 裡的 `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` 即測
DeepSeek 版產品。實測：DeepSeek-V4-Pro 經 anthropic-compat 端點 tool-use 完全可用。

### 4.2 okx-onchainos-demo 實例（已落地）

參考 driver：`adapters/okx-demo-sse-driver.mjs`。搭配一份指向該 driver 的 suite
即可（tasks 可直接沿用 `suites/onchainos-basic.json` 的題目，跨 runtime 可比）。要點：

- 走 demo 的 **server-side agent loop**（SSE `GET /api/chat/stream` + `POST /api/chat/message`，
  `ENABLE_SSE=1`），`mode=alpha` 自動核准工具；`tool_use`/`tool_result` 幀即完整 trace，
  `turn_usage` 幀（demo `server/agent-loop.ts` 逐輪廣播 Messages API usage + usdCost）點亮
  H / token 統計 / 真實成本。注意：這與瀏覽器內的 loop 不是同一條 transport——結果按
  「runtime+model 組合」歸因。
- **固定 sessionToken + onchainos auth seed**：demo 按 sha256(token) 分配獨立
  `ONCHAINOS_HOME`（空 home → 工具全報 53017 auth 過期）。driver 支援
  `AIIDE_SESSION_TOKEN`（固定）+ `OKX_DEMO_SEED_HOME`（已登入的全域 home，如
  `C:/Users/<you>/.onchainos`）+ `OKX_DEMO_HOMES_DIR`——**每次執行都重新複製**登入態進
  per-session home（access token 壽命約 1h，一次性快照會在 suite 中途過期造成間歇 53017；
  同機 TEE keyring 可用；副本隔離，絕不改動全域 session）。
- 外部服務的 auth/quota 是評測的未受控變因（KB pitfall）——跑分前先確認
  `onchainos wallet status` ok。

### 4.3 對比 Claude Code vs 你的服務

同一份 tasks 兩份 suite（一份無 runtime = claude-code，一份指向你的 driver），分別
`aiide lab run`，dashboard Experiments 頁對兩個實驗按「compare」→ 並排對比。跨
runtime/provider 時 compare 頁會顯示不可比維度聲明（H/效率 n/a、activation 語義不同），
差異應歸因到 runtime+model 組合而非模型本身。（覆盖率家族的 provenance 不可比规则
见 §3.4。）

### 4.4 Playwright UI 驅動（保真度最高、數據最少）

見 `adapters/okx-demo-driver.mjs` 骨架：開站 → 輸入 prompt → 等流式回覆結束 → 抽最終
文字（completion-only）。適合必須認證「用戶真實體驗」的場景；若要 P/R/H，建議產品側
export trace（`window.__aiideTrace` 或 API 端點）。

### 4.5 評測可靠性 suite 欄位（Wave 1 新增）

以下欄位皆為選填，向後相容（不寫 = 舊行為）。

#### `file_exists` verifier（S3）
純文字 verifier（regex/numeric_range/json_field）之外新增 filesystem verifier，對齊每 repeat
的 workspace（cwd 省略時 = 空 workspace，見 §1.2 `cwd` 語義）：

```jsonc
{ "type": "file_exists", "path": "out/result.json",
  "schema": { "required": ["price", "symbol"] } }   // schema 選填：檔案須為 JSON 且含這些 dot-path
```

#### env-noise retry / excluded（S2）
外部服務的暫時性故障（HTTP 429/529、`ECONNREFUSED`、auth 過期含 onchainos `53017`、rate-limit）
會指數退避重試；重試耗盡仍命中 → 該 repeat 標 `excluded (env-noise)`、**從分母剔除**（絕不算 C=0）。
`timeout` 與 generic `exit!=0` 不剔除、照算 C=0。可調：

```jsonc
"retry": { "maxRetries": 2, "baseDelayMs": 1000 }   // 預設值；backoff = baseDelayMs · 2^attempt
```

scorecard 頂端印 `⚠ degraded: N repeats excluded`，model-comparison 每格標 `degraded (N excluded)`。

#### resume / `--fresh`（S1）
`aiide lab run` 中斷後重跑會自動從 `experiments/.inprogress/<resumeKey>.jsonl` 進度 journal 接續
（已完成 repeat 印 `✓ (cached)`）；`suite sha256 / model / repeats` 變動 → 拒絕 resume 並提示 `--fresh`。
`--fresh` 強制重跑。experiment.json 仍 write-once immutable，dashboard 對 journal 天生隱形。

#### 多步驟 task（S12）
task 可用 `steps` 取代單一 `prompt`/`verifiers`；各 step 依序在**同一 workspace**執行（檔案跨 step 保留），
前一步 reward < `minReward`（step 級或 task 級，預設 1）→ 中止後續步、記 `abortedAtStep`：

```jsonc
{ "id": "trade-flow", "minReward": 1, "steps": [
  { "prompt": "查 ETH 價", "verifiers": [{ "type": "regex", "pattern": "ETH" }] },
  { "prompt": "下單並寫 out/order.json", "verifiers": [{ "type": "file_exists", "path": "out/order.json" }] },
  { "prompt": "確認", "verifiers": [{ "type": "regex", "pattern": "confirmed" }] }
] }
```

#### 診斷輸出（不進複合分）
`pass@k`（S3，可用 `"passK": [1,3]` 覆寫）與 `activation×outcome`（S17：觸發/未觸發該 skill 的 meanC 對照）
只進 scorecard 診斷區，**永不進 composite**（守 deterministic-first）。

### 4.6 可插拔評測：trace verifier · judge · responder · placeholder（Wave 3 新增）

皆選填、向後相容。四個能力用一組 registry 統一：

#### prompt 變數注入（placeholder）
`suite.vars: { NAME: "value" }` → prompt/step.prompt 內 `{{NAME}}` 被替換（`{{PROMPT}}`/`{{MODEL}}`/
`{{SUITE_DIR}}`/`{{REPLY}}` 為保留 runtime-arg token，不受影響）。env 覆寫 `AIIDE_VAR_<NAME>`（秘密/地址
不落 suite 檔）。**未解析的 `{{VAR}}` = 載入期 fatal**（fail-fast）。

#### trace verifier（讀工具軌跡，不只最終文字）
需 `suite.probes: ["<tool>"]`（見 `<data-dir>/probes/*.json`）。`suite.writeOps: [...]` 是寫命令的
單一真相源，同時餵 `no_write_op` 與 confirm-gate。

```jsonc
{ "type": "command_ran", "tool": "onchainos", "cmd": "wallet balance", "exitOk": true }  // 某命令跑了(且退出 0)
{ "type": "no_write_op" }                                    // 無任何 writeOps 命令跑過（安全負斷言）
```

#### judge（model-graded assertion）
`{ "type": "judge", "criterion": "<自然語言斷言>", "evidence": ["answer","trace"] }` 由一個 judge 模型判定。
judge 是**另一個 runtime**：`suite.judge: { runtime, model, temperature:0, votes, cache, evidence }`；CLI
`--judge-model` / `--judge-runtime`。非確定性以 temp0 + 內容雜湊快取 + N 票多數緩解，verdict/reason 全存封存。
**權威**：`suite.grading.authority`（`deterministic` 預設 = C 只由確定性 verifier gate、judged 作診斷；
`judged` = judged 判定即 C）；CLI `--grading-authority`。

#### responder（自動應答互動閘）
`task.mustConfirm: { cmds:["swap execute"] }`（命令級，分得出 `swap execute` vs `market price`；或
`tools:[...]`+`pathPattern`）宣告危險操作。當 agent halt 詢問確認時，`suite.responder` 自動應答：
`{ "strategy": "policy"|"scripted"|"judge", "policy": { "approveWriteIf": null, "default": "deny" }, "scriptedReply": "…" }`；
CLI `--responder`。claude-code 走 sentinel `CONFIRM_REQUIRED:` + `--resume`；adapter 走下面的契約 v2。

#### 互動契約 v2（adapter transport）
adapter 若讓 agent 提問，**不要 hard-fail**——印一個 halted 物件，aiide 的 responder 決定回覆後以
`AIIDE_RESUME=<ref>` + `{{REPLY}}`（argv 傳回覆）二次呼叫你續跑同一會話：

```jsonc
// 首次呼叫（agent 想確認）→ stdout：
{ "result": "", "trace": [...], "halted": true,
  "ask": { "question": "Confirm the swap?", "options": [] }, "resumeRef": "<你的會話鍵>" }
// aiide 以 AIIDE_RESUME=<resumeRef> 二次呼叫，argv[2]=responder 的回覆 → 你續跑並印正常 result。
```

policy 拒絕 → 不 resume，該 repeat 標 `flow-incomplete`（excluded，絕不假 C=0）。

---

## 附：舊版章節遷移對照（migration map，F-2-28 零內容淨損自查）

| 舊版章節 | 新歸屬 |
|---|---|
| 開頭簡介 + 三級保真度表 | §1 開頭 |
| 契約（stdout JSON）——suite runtime 宣告 + 佔位符 | §1.2 |
| 契約——stdout JSON 範例（result/trace/usage/toolCalls） | §2.1 示例 + §3.1 schema 表 |
| 誠實評分規則（四條） | §3.2 誠實降級規則表（前四行，逐條對應） |
| `runtime.service` 生命週期 | §4.1（原文） |
| BYOK key 怎麼給 | §4.1（原文） |
| 換 LLM provider | §4.1（原文） |
| okx-onchainos-demo 實例 | §4.2（原文） |
| 對比 Claude Code vs 你的服務（compare 不可比聲明） | §4.3（原文 + §3.4 交叉引用） |
| Playwright UI 驅動 | §4.4（原文） |
| Wave 1 新增 suite 欄位（S3/S2/S1/S12/診斷輸出） | §4.5（原文） |
