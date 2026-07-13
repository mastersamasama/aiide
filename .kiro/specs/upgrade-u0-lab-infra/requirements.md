# U0 · upgrade-u0-lab-infra — Requirements (EARS)

> Design authority: `docs/onchainos-upgrade-pipeline-design.md` §1 (階段 2 採集)、§2.1 (scripted-reply
> metrics 合併)、§2.5 (運行預算/bounded concurrency)、§5 spec 表 U0、§6 F3。
> Evidence base: `docs/wave0-probe-report.md` P2 (resume append/零重放/增量成本)、P3 (併發安全前提)。
> Depends on: [U1] (suite/case sha 是 resumeKey 組成)、[U3] (scripted-reply 續跑接 L3 asked-and-halted)。
> **Provides: CANONICAL CONFIG `src/upgradeConfig.js`（純 Object.freeze 常數、零邏輯，Wave 1 最前置 T0.0；
> U1/U3/U4/U5/U6/U7 全數引用，不得重複定義）。** [裁決 TL-B1：config 為 foundation，從 U4 前移至 U0。]

## Constraints (鐵律 — 每 spec 必列)
- **零依賴零建置**：只用 node builtins；本 spec 不引入任何第三方套件或建置步驟。
- **experiment 不可變**：sealed `experiments/<id>.json` 寫後不可變；resume 只碰 append-only journal 類別
  （`experiments/.inprogress/<resumeKey>.jsonl`），沿用既有 S1 紀律。
- **server read-only except annotations sidecar（既有 PUT /annotations）**：本 spec 不新增任何 server 寫入端點。
- **治理中立**：一切寫入僅落 runs/experiments/journal/logs/workspaces；源 skill 目錄與 suite 檔只讀
  （arm profile 為 `cpSync` 出的隔離副本，`lab.js:54`）。

## CANONICAL CONFIG（`src/upgradeConfig.js`，frozen 單一定義源）[TL-B1]
本 spec **唯一**定義下列可調參數（純常數、零邏輯）；其他 spec 一律 `import` 引用，禁止重複定義。

```
UPGRADE_CONFIG = Object.freeze({
  tokenWeights:  { input:1, output:5, cacheRead:0.1, cacheWrite:1.25 },  // §2.2 等效全價
  verdict: {
    MIN_PAIRS: 8,                 // 全域配對 case 下限
    MIN_PAIRS_SKILL: 5,           // per-skill cluster 下限（5-7 標「CI 僅供參考」）
    nonInferiorityDeltaPp: 5,     // δ，非劣性邊界（percentage points）
    ciLevel: 0.95,
    bootstrapIters: 10000,
    bootstrapSeed: 0x9E3779B9,    // 固定種子 → 可重現（PRNG: splitmix32，[TL-m3]）
    fdr: 'benjamini-hochberg',    // per-skill 徽章多重比較校正
  },
  exclusion:  { tripwirePct: 12 },// 整案排除 >12% → inconclusive
  flowIncomplete: { ciMethod: 'wilson' },
  concurrency: { min:4, max:8, default:6 },
  dataset: {                       // [U1] 引用
    smokeTierMin:20, smokeTierMax:30,   // smoke 層規模區間 [PM-B7]
    minMultiIntentPct:0.15,             // 多意圖 case 佔比下限 [PM-B5]
  },
  depgraph: {                      // [U5] 引用
    inlineReadRate:0.60, externalReadRate:0.20, coReadMerge:0.80,
    coTriggerGraph:0.50, jaccardSplit:0.30,   // coTriggerGraph 0.50 已由設計 §2.3 拍定
    minCategories:2, minSessionsPerCategory:5, breakEvenDivisor:4,
    hardExcludeSkills: [],        // 安全/冷觸發硬排除（對齊 onchainos ROUTE-04）
  },
  staticGates: { descMaxUnicode:1024 },   // [U6] 引用
})
```

R0.0 — CANONICAL CONFIG 定義（[TL-B1] foundation）
- R0.0.1 THE `src/upgradeConfig.js` SHALL 匯出 `Object.freeze` 的 `UPGRADE_CONFIG`（上表全欄位、純常數零
  邏輯）；改寫 SHALL 拋錯（frozen）。
- R0.0.2 THE 其他所有 spec SHALL `import` 引用此檔，SHALL NOT 重複定義任一參數；[U4] 只**消費 + 驗證 frozen
  + 把生效參數印入報告 footer**。

## Glossary
- **arm（臂）**：一次升級對比中的一方，`{label, cliVersion, cliPath, profileName}`（如 `old`/`new`）。
- **resumeKey**：續跑鍵。本 spec 在既有 `${suite.name}-${model}-${suiteSha8}` 上**追加臂身份**。
- **invocation**：一次 `claude -p`（或 `--resume`）子進程呼叫；resume 續跑是同 sessionId append（P2）。
- **scripted-reply**：safety 用例確認回合後，harness 自動注入的確認語，用 `--resume` 續完整流。

## Requirements

R0.1 — Bounded concurrency（前置基建，§2.5）
- R0.1.1 WHEN `aiide upgrade run` 執行採集，系統 SHALL 以 bounded worker pool 併發跑 (case × repeat × arm)
  單元，併發上限取自本 spec CANONICAL CONFIG `upgradeConfig.js` 的 `concurrency`（min 4 / max 8 / default 6）。
- R0.1.2 每個併發 session SHALL 使用**互異的 workspace cwd**（P3 裁決：claude 依 cwd-slug 分 `projects/<slug>/`
  子目錄，天然隔離）；系統 SHALL 為每個 (case, repeat, arm) 生成唯一 workspace 子目錄。
- R0.1.3 IF 任一 worker 拋例外，pool SHALL 繼續調度其餘單元（不整批中止），失敗單元走 [U3]/[U4] 的
  excluded/retry 路徑。

R0.2 — Per-arm CLI/env/PATH 釘死（§1 階段 2、§2.2 版本釘死）
- R0.2.1 每個 arm SHALL 攜帶自己的 `cliPath`（或 PATH 前綴）與 env，使該 arm 的所有 invocation 只呼叫該
  arm 宣告版本的 onchainos CLI；兩臂 CLI 二進位 SHALL NOT 互相洩漏（env/PATH 逐 arm 構造，不共用進程環境）。
- R0.2.2 WHEN arm 啟動採集前，系統 SHALL 執行 `onchainos --version`（運行期自報）並斷言 == 該 arm 宣告版本；
  IF 不等，該 arm SHALL fail-fast 且不跑任何 session（preflight 斷言，[U6] 靜態閘的動態對應）。
- R0.2.3 arm 的 `{cliVersion, profileName, isolation flag, model, harness 版本}` SHALL 全數寫入 experiment
  metadata（[U4] 版本自報消費之）。

R0.2b — 混合 bundle profile 組裝（**PM-B1** 混採閉環，實作非降級）
- R0.2b.1 THE `ensureProfile` SHALL 支援組裝**混合臂 profile**：從兩臂各自 skill 目錄依 mix 映射（如
  `skillA=new, skillB=old`）各取對應版本的 skill 目錄，組成單一混合 profile（`ensureProfile` 本就吃
  skillDirs 清單）。
- R0.2b.2 THE 混合臂 CLI 版本 SHALL 由操作者顯式指定，**預設用新臂 CLI**；混合臂 metadata SHALL 記錄完整
  mix 映射（每 skill → 取自哪一臂）+ 所用 CLI 版本。
- R0.2b.3 THE 混合臂 SHALL 走與正常臂**同一** verdict 引擎（[U4]），產 bundle 級 mini-verdict；此為 [U7]
  `aiide upgrade smoke --mix` 的採集後端。THE 配對語意 SHALL 為 **混合臂 vs 基線臂**（[PM-N1]：基線臂預設
  = 現行生產 old-full，`--baseline new|old` 可調，[U7] R7.1.3a）——混合臂本身不與另一混合臂配對。
- R0.2b.4（**[TL-N-MAJOR-1] e2e gating**）THE 混合臂「產 mini-verdict」的端到端斷言 SHALL **gated 至 [U7]**
  smoke --mix 任務（[U4] verdict 引擎屆時已在）；本 spec 的 T0.2b 只驗 profile 組裝 / mix 映射 / CLI 版本記錄
  （不跨 Wave 依賴 U4 引擎）。

R0.3 — 臂身份入 resumeKey 與 journal header（**F3**，§6，blocker 級；arm 貫穿面 [TL-M2]）
- R0.3.0（arm 為 optional 形參）THE `arm` SHALL 為 `runSuite` 的 **optional 形參**：缺省時（既有非升級 lab
  run）resumeKey/journal 行為與現況**位元不變**（既有 6 處無-arm 測試保綠）；`runSuite` 新增 arm 形參並
  穿透 `computeResumeKey`/`ensureJournal`/`findJournal`/`clearJournals`。
- R0.3.1 WHEN 提供 arm，THE resumeKey SHALL 納入臂身份（`arm.label` + `arm.cliVersion` + `arm.profileName`），
  使兩臂即便**同 suite sha、同 model** 也產生**互異** resumeKey。
- R0.3.2 THE journal header 首行 SHALL 記錄 `{arm:{label,cliVersion,profileName}, suiteSha256, model, repeats,
  createdAt, aiideVersion}`；WHEN 載入既有 journal，系統 SHALL 斷言 header 的臂身份等於當前 arm，不等則
  視為不同身份的獨立 journal（不互相 resume）。WHEN 既有 journal header **缺 arm 欄位**（legacy），
  `findJournal` SHALL 對帶 arm 的當前跑視為**獨立 journal**（不誤 resume legacy 進臂間對比）。
- R0.3.3（**反例／假通過守門**）WHEN 第二臂在第一臂已完成後啟動且兩臂 suite sha 相同，系統 SHALL NOT 讓
  第二臂復用第一臂的 completed repeats；否則 delta≈0 假通過。測試 SHALL 斷言：兩臂各自獨立跑滿 repeats、
  兩 journal 檔名互異、兩臂 experiment 的 repeat 來源不交叉。

R0.4 — scripted-reply resume step + metrics 合併（§2.1，P2/P3 依據）
- R0.4.1 WHEN 一個 case 帶 `must_confirm_before` 斷言（[U1] schema）且該 invocation 終態為 asked-and-halted
  （[U3] 判定），系統 SHALL 以 `claude -p --resume <sessionId>` 注入該 case 的 scripted-reply，續跑完整流。
- R0.4.2 THE resume SHALL 使用**同 `CLAUDE_CONFIG_DIR`、同 workspace cwd、不加 `--fork-session`**（P2 實測：
  同 sessionId、同一 JSONL append、零重放）。
- R0.4.3 THE session 總成本/總 tokens SHALL = **逐 invocation 增量相加**（sum over invocations）——首跑 result 的
  `total_cost_usd`/`usage` + resume invocation 的 result 值相加；SHALL NOT 只取最後一次、SHALL NOT 假設任一次
  為累計值（P2 實測：每次 invocation 回報的是該次增量，非累計）。rounds SHALL 取增量相加。
- R0.4.4（**反例／零重放**）BECAUSE 純 `--resume` 是同檔 append 零重放（P2），對整段 JSONL 全量 parse 即得完整
  多輪流，系統 SHALL NOT 對 JSONL 行做去重（無重複行可去）。成本 SHALL 不從 JSONL 取（JSONL 無 result 行），
  只從各次 invocation stdout JSON 取。IF 未來改用 `--fork-session`（本輪不做），去重鍵為每行 `uuid`。
- R0.4.5（**反例／缺腳本**）IF 一個 asked-and-halted case **無** scripted-reply 腳本，該 repeat SHALL 走
  excluded-not-zero（質量與成本軸**同時**排除，[U4] 消費），並記 `flow-incomplete`（[U3] 分母規則）——不得
  以 C=0 假記，也不得靜默計入 verdict。

R0.5 — 預算預估（§2.5）
- R0.5.1 WHEN `aiide upgrade run/compare` 啟動前，系統 SHALL 印出預算預估表：`session 數（= 臂數 × case 數 ×
  repeats）× 預估時長（併發數代入）× 預估 USD`，USD 用 `metrics.js` 現成定價。
- R0.5.2 THE 預估 SHALL 同時可由 [U7] 報告端消費（CLI 與報告同源預估）。

## 非目標
- ❌ 不處理 `--fork-session` 去重（本輪 resume 一律純 append）。
- ❌ 不重定向 `~/.onchainos/audit.jsonl`（列為對 onchainos 團隊的介面問題，§7 風險）。
