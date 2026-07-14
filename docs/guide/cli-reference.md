# CLI 参考

aiide 所有命令的完整语法、旗标和示例。这是一份速查表——概念解释见 [核心概念](concepts.md)，跟着做的教程见 [快速上手](getting-started.md)。

命令示例统一写作 `aiide <命令>`；没做全局链接就换成 `node bin/aiide.js <命令>`。不带任何参数运行 `aiide` 会打印用法总览。没有 `--help` 旗标——打错或缺参数时会自动打印用法。

**全局旗标**：`--data-dir <dir>` 指定数据位置（默认 `./.aiide`），所有命令通用。

---

## 观测

### aiide ingest

```bash
aiide ingest <目录|文件.jsonl>
```

把 Claude Code session 记录解析成 run，写到 `.aiide/runs/`。给目录则递归处理其中所有 `.jsonl`。run id 取自文件名。

### aiide up

```bash
aiide up [--port 4517]
```

启动本地只读 dashboard，绑 `127.0.0.1`，默认端口 4517。零上传，任何非 GET 请求都会被拒（唯一例外是给实验加注记的 PUT）。

```bash
aiide up --port 9000
```

### aiide watch

```bash
aiide watch <目录|文件.jsonl>
```

实时尾随 session 目录（约 500ms 轮询），新回合一到就重新导入。搭配另一个终端的 `aiide up` 边跑边看。Ctrl-C 停止。

---

## 评测

### aiide lab init

```bash
aiide lab init --suite <文件.json> [--force]
```

生成一份带注释、可直接跑的 suite 骨架。文件已存在时需加 `--force` 覆盖。

### aiide lab run

```bash
aiide lab run --suite <文件.json> [旗标...]
```

在隔离沙盒里跑评测（重复 + 评分）。旗标：

| 旗标 | 说明 |
|---|---|
| `--model <m>` | 覆盖 suite 的模型（默认 sonnet）。 |
| `--models a,b` | 同一 suite 每个模型各跑一遍，跑完打印配对对比。 |
| `--repeats <n>` | 覆盖重复次数。 |
| `--concurrency <N>` | 最多 N 个任务并行（默认 1 串行）。并行安全但 N 倍打 API。 |
| `--meta k=v` | 记录一条元数据到实验（可重复多次）。 |
| `--fresh` | 忽略续跑日志，强制从头重跑。 |
| `--grading-authority deterministic\|judged` | 判定权威：确定性还是 LLM 裁判。 |
| `--judge-model <m>` / `--judge-runtime <r>` | 裁判用的模型 / runtime。 |
| `--responder policy\|scripted\|judge` | 自动回答交互门（确认/询问/权限）。 |

中断的实验会自动从进度日志续跑；`--fresh` 强制重来。

### aiide report

```bash
aiide report [experimentId]
```

打印实验的 scorecard。不给 id 就是最近一次。

### aiide stats

```bash
aiide stats [experimentId] [--force] [--write]
```

打印实验覆盖率统计（skill / ref / probe / proximity）。

- 封存实验内嵌的 stats 是唯一权威，默认直接打印。
- `--force` 从 runs 重算，输出标记为非权威。
- `--write` 存到 `.aiide/stats/<id>.json` sidecar，绝不改动实验本身。

### aiide skill

```bash
aiide skill [name]
```

不给 name 列出所有 skill（版本数、触发率、平均分）；给 name 看单个 skill 的版本时间线和分数趋势。只读——采用永远是人的决定。

---

## 升级对比

### aiide upgrade

```bash
aiide upgrade lint      --suite <f>
aiide upgrade preflight --fixture <m>
aiide upgrade run|compare --fixture <m> [--intent <i>]
aiide upgrade report    --fixture <m> [--format json|md] [--intent <i>]
                        [--arm-exp-old <expId> --arm-exp-new <expId>]
aiide upgrade smoke     --mix a=new,b=old [--baseline new|old] --fixture <m>
```

把两整包 skill 的新旧版做配对对比，产出采用建议 + 证据。

| 子命令 | 作用 |
|---|---|
| `lint` | 跑前的数据集静态检查（schema/覆盖/规模）。 |
| `preflight` | 零 token 静态门（描述长度/碰撞/漂移），fatal 即非零退出。 |
| `run` / `compare` | 打印 U0 预算表，再聚合两 arm → verdict + 报告。 |
| `report` | 产出 `report.json` + `report.md` + 单文件离线 `report.html` 到 `.aiide/upgrades/<id>/`。 |
| `smoke` | 混搭确认冒烟（唯一被认可的手挑混搭采用路径）。 |

- `--intent` 是 `cost-opt` / `quality-fix` / `neutral-refactor` 之一，参数化裁决门槛。
- `--arm-exp-old` / `--arm-exp-new` 从 dataDir 解析两个已封存实验的覆盖统计和 runtime 自述，并入报告；必须成对提供。
- 离线管线通过 `--fixture <module>`（合成 bundle）驱动；采集真实 session 需 live claude runtime。

---

## 维护与导出

### aiide meta

```bash
aiide meta list                     # 显示持久化 meta 默认值 + capture 命令
aiide meta set <k> <v>              # 设一个默认 meta 键（每次实验都记录）
aiide meta rm <k>                   # 删一个默认 meta 键
aiide meta capture <name> <cmd...>  # 每次实验自动跑 cmd，记录第一行输出
aiide meta capture --rm <name>      # 删一个 capture 命令
aiide meta test                     # 干跑所有 capture 命令（不写任何东西）
```

meta 和 capture 存在 `<data-dir>/settings.json`。典型用途是记录每次实验的 git sha：

```bash
aiide meta capture gitsha "git rev-parse --short HEAD"
```

### aiide prune

```bash
aiide prune --older-than 30d [--max N] [--yes]
```

删除过旧的 runs / experiments（连同它们的 annotations、stats sidecar）。默认只预览，加 `--yes` 才真删。`--max N` 保留最新的 N 个。settings / pricing / 进行中的日志永不删。dashboard 没有删除接口——清理只走这里。

### aiide export

```bash
aiide export --otel [id] [--out <文件>]
```

把一个 run / experiment 导出成 OTLP/JSON（OTel GenAI 语义约定）。不给 `--out` 就打到标准输出。

### aiide adapter check

```bash
aiide adapter check <output.json> [--json]
aiide adapter check --suite <f> [--task <id>] [--model <m>] [--json]
```

校验 adapter 的 stdout JSON（schema + channel 形状）。

- 文件模式：校验一份已捕获的 stdout JSON。fatal 报错则退出码 1；仅有 warning 则退出码 0。
- `--suite` LIVE 模式：真跑一次 adapter 调用（含服务生命周期 + prompt/model 替换）再校验实际输出。

外部 runtime 接入完整说明见 [外部 runtime 接入](../adapters.md)。

---

## Suite 字段

suite JSON 的顶层字段（允许 `//` 和 `/* */` 注释）。完整写法与示例见 [评测指南](skill-lab.md#第一步--写一份-suite)。

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 必填。实验 id 和续跑日志的键由它派生。 |
| `model` | string | 默认 `sonnet`；`--model` / `--models` 覆盖。 |
| `repeats` | int | 默认 3；建议 ≥3，Wilson 信赖区间才可信。 |
| `maxTurns` | int | 默认 30（claude-code）。 |
| `timeoutMs` | int | 每次重复的超时，默认 300000。 |
| `retry` | object | env-noise 重试，默认 `{maxRetries:2, baseDelayMs:1000}`。 |
| `skills.dirs` | string[] | **只有**列在这里的 skill 目录会装进隔离沙盒。 |
| `targetSkills` | string[] | 期望被触发的 skill，其触发情况喂给 P / R 维度。 |
| `passK` | int[] | 诊断用 pass@k 集合，永不进综合分。 |
| `probes` | string[] | 白名单：只有 tool 名在列表里的 probe 生效（见评测指南）。 |
| `runtime` | object | 接外部 runtime（见 [adapters](../adapters.md)），省略即 claude-code。 |
| `tasks` | Task[] | 必填。每个 task 含 `id` + `prompt`（或多步 `steps`）+ `verifiers`。 |

verifier 四型：`regex` / `numeric_range` / `json_field` / `file_exists`。详见 [评测指南](skill-lab.md#怎么判定答对verifier)。

---

## 配置文件

都放在 `--data-dir`（默认 `./.aiide/`）下：

- **`settings.json`** —— meta 默认值 + capture 命令（由 `aiide meta` 管理）。
- **`pricing.json`** —— 成本覆写，支持非 Claude 模型：
  ```json
  { "models": [ { "match": "gpt", "in": 2.5, "out": 10 } ] }
  ```
- **`service.env`** —— 被测服务需要的 BYOK 密钥（放这里，不要提交到版本库）。
