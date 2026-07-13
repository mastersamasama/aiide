# U4 · upgrade-u4-upgrade-verdict — Requirements (EARS)

> Design authority: `docs/onchainos-upgrade-pipeline-design.md` §2.2 (對比與升級判定)、§5 spec 表 U4、
> §6 F1/F2/F3、輪 3 dissenting view（MIN_PAIRS_SKILL=5 CI 僅供參考）。
> Depends on: [U0] (兩臂 journal/採集、**CANONICAL CONFIG `src/upgradeConfig.js`——由 U0 T0.0 定義**)、
> [U1] (case-id 交集配對)、[U3] (L1/L2/L3 + flow-incomplete)、[U2] (歸因)。
> [裁決 TL-B1]：config 定義前移至 [U0]；本 spec **只消費 + 驗證 frozen + 把生效參數印入報告 footer**。

## Constraints (鐵律)
- **零依賴零建置**：bootstrap/Wilson/BH 全零依賴（bootstrap ~30 行、固定種子可重現）。
- **experiment 不可變**：聚合讀 experiment/journal，產 report 物件；不回寫 experiment。
- **server read-only except annotations sidecar（既有 PUT /annotations）**：不新增 server 寫入。
- **治理中立**：verdict 只給採用**證據**，採用永遠是人類決策；SHALL NOT 自動採用/自動改 skill。

## CONFIG 消費（[TL-B1]，本 spec 不定義）
- R4.0.1 THE 本 spec 所有可調參數（`MIN_PAIRS`/`MIN_PAIRS_SKILL`/`nonInferiorityDeltaPp`/`tripwirePct`/
  `tokenWeights`/`bootstrapSeed`/`bootstrapIters`/`fdr`）SHALL 一律 `import` 自 [U0] `src/upgradeConfig.js`，
  SHALL NOT 重複定義。
- R4.0.2 THE verdict 報告 footer SHALL 印出**實際生效**的 config 參數值（δ、MIN_PAIRS、種子等）供審計。
- R4.0.3 THE 聚合入口 SHALL 驗證 `UPGRADE_CONFIG` 為 frozen（防呼叫端在跑中被改動）。

## Requirements

R4.1 — 四元組 task 級聚合（excluded 分母明寫）
- R4.1.1 THE 聚合 SHALL 對每 case 產出四元組軸：質量三層通過（L1/L2/L3）+ 三連續量（turn 數、等效全價
  token @ `tokenWeights`、端到端秒）。
- R4.1.2 THE 成本三軸與質量三層的分母 SHALL **明確排除** excluded-not-zero repeats（env-noise 排除 +
  [U3] R3.4.2 的 harness-halt 排除）；每個聚合值 SHALL 併帶 `excludedRepeats` 計數（沿用 S2 degraded 紀律）。
- R4.1.3（反例／flow-incomplete 分母不同）THE flow-incomplete rate 的分母 SHALL 為全部嘗試 repeat（[U3]
  R3.5，**含** excluded）——與 R4.1.2 的成本/質量分母**刻意不同**；本 spec SHALL 分別維護兩個分母。

R4.2 — Paired bootstrap delta CI（連續量，§2.2）
- R4.2.1 THE 三連續量 SHALL 用 **per-case 配對差值 + bootstrap 重抽樣 delta CI**（固定種子
  `bootstrapSeed`、`bootstrapIters` 次、`ciLevel`）；PRNG SHALL 為 **splitmix32**（seed=`0x9E3779B9`），
  [TL-m3] 明名以確保跨平台可重現。
- R4.2.2 THE bootstrap SHALL 可重現：同輸入同種子 → 同 CI（金樣本測試鎖定）。
- R4.2.3 THE 比例量（三層通過率、flow-incomplete rate）SHALL 用 Wilson，不用 bootstrap；Wilson SHALL
  **複用 `score.js:237` 既有 `wilson(successes, n, z)`**（`ciLevel`→z 換算，如 0.95→1.96），[TL-m1] 不新造。

R4.3 — 非劣性門（**F2**，§2.2/§6）
- R4.3.1 THE 質量門 SHALL 為**非劣性檢定**：配對質量 delta 的 CI 下界 > −δ（`nonInferiorityDeltaPp`），
  SHALL NOT 用「CI 重疊 = 持平」的預設通過（避免樣本越少 CI 越寬越易假持平）。
- R4.3.2（邊界值 AC）WHEN CI 下界**恰等於** −δ，SHALL 判**不通過**（門為嚴格 `>`，邊界不放行）。
- R4.3.3 THE δ SHALL 取自 CONFIG 並**印在報告**；case 層沿用 `score.js` belowFloor 模式（`score.js:179`）。

R4.4 — Intent 參數化 verdict（§2.2）
- R4.4.1 THE 全域 verdict SHALL 依 intent 參數化：
  - `cost-opt`：質量三層 + flow-incomplete **全過**非劣性門 ∧ 至少一成本軸**顯著降** ∧ 其餘不顯著升。
  - `quality-fix`：目標質量軸**顯著升** ∧ 成本三軸**不顯著升**。
  - `neutral-refactor`：質量過非劣性門 ∧ 成本不顯著退步。
- R4.4.2 THE flow-incomplete（[U3] R3.5）SHALL 納入**所有** intent 的質量判準。
- R4.4.3 THE 全域 verdict（bundle 級）SHALL 為唯一「採用證書」。

R4.5 — insufficient-data / 排除率絆線（**F1 絆線**，§2.1/§2.2）
- R4.5.1 WHEN 全域配對 case < `MIN_PAIRS`（8），verdict SHALL = `insufficient-data`（不出成立/不成立）。
- R4.5.2 WHEN 被整案排除的 case 佔配對集 > `tripwirePct`（12%），verdict SHALL 強制 = `inconclusive` 並
  明標排除率——堵「大量 halted 靜默流失、verdict 產於倖存集」。
- R4.5.2a（**[PM-N1] 順手**）THE 聚合輸出 SHALL 含**整案排除的 case-id 清單**（每筆帶排除原因 env-noise/
  harness-halt），非僅計數——供 [U7] R7.4.3 的 inconclusive 指引枚舉 case-id（枚舉已存在於算率過程，補輸出
  欄位即可）。
- R4.5.3（邊界值 AC）WHEN 排除率**恰等於** 12%，SHALL **不**觸發 inconclusive（絆線為嚴格 `>`）；恰
  12.0001% → 觸發。
- R4.5.4（反例／單臂缺失）WHEN 某臂整體採集失敗或版本斷言未過（[U0] R0.2.2），配對集為空 → verdict
  SHALL = `insufficient-data`，SHALL NOT 以單臂數據產出成立判定。

R4.6 — Per-skill cluster bootstrap + BH（§2.2 N2/N6、輪 3 dissent）
- R4.6.1 THE per-skill 顯著性 SHALL 用 **cluster bootstrap over case×repeat 單元（case 為 cluster）**。
- R4.6.2 WHEN 某 skill 配對 case < `MIN_PAIRS_SKILL`（5），SHALL 只出描述統計 + `insufficient-data` 徽章。
- R4.6.3 WHEN 5 ≤ 配對 case ≤ 7，CI SHALL 明標「僅供參考」（輪 3 dissent 妥協）。
- R4.6.4 THE per-skill 顯著徽章 SHALL 做 **Benjamini-Hochberg FDR** 校正；全域 3 軸不校正但 footer 明標
  檢定總數與策略。
- R4.6.5（治理，**PM-B1 閉環 + PM-N1 對照臂**）THE per-skill 診斷表 SHALL NOT 作獨立採用證書（兩臂各為
  完整 bundle、路由全局耦合、混採未被測過）；報告明標。PM 若按表混採，管線 SHALL 提供**已實作**的混合
  bundle 確認 smoke（≤150 session，採集後端 [U0] R0.2b、CLI [U7] `aiide upgrade smoke --mix`），走**本 spec
  同一 verdict 引擎**產 bundle 級 mini-verdict。THE 配對語意 SHALL 為 **混合臂 vs 基線臂**（基線臂預設 =
  現行生產 old-full，`--baseline new|old` 可調，[U7] R7.1.3a）；作為採用前最後一跑。

R4.7 — 兩臂 journal 隔離斷言（**F3**，§6，落 U0+U4）
- R4.7.1 WHEN 聚合讀入兩臂 experiment，系統 SHALL 斷言兩臂的 journal/resumeKey 臂身份互異（[U0] R0.3）；
  IF 偵測到兩臂共用 repeats 來源（同 resumeKey 串臂），SHALL 報錯並拒絕產 verdict（防 delta≈0 假通過）。

R4.8 — 版本自報（§2.2）
- R4.8.1 THE experiment metadata SHALL 含兩臂各自 `onchainos --version` 自報值 + preflight 斷言結果 +
  每 skill sha256 + 模型 + harness 版本 + isolation flag；verdict 報告 footer SHALL 呈現此版本四元組。

R4.9 — regressed case 聚類介面（**[PM-B3c]**，§2.4 跑後）
- R4.9.1 THE 本 spec SHALL 提供 `clusterRegressed(pairedCases)` 介面：把 quality 退步的 regressed case 聚類
  到 `skill × category`（skill 取自 [U2] 主歸因、category 取自 [U1]），回傳 `{ [skill×category]: caseId[] }`
  供 [U7] R7.7.3 呈現。此為分析介面（[U7] 只呈現不重算）。

## 反例／邊界 AC 匯總
- R4.EB1 配對 case = 7（< 8）→ insufficient-data（R4.5.1）。
- R4.EB2 排除率 = 12.0%（邊界）→ 不 inconclusive；= 12.5% → inconclusive（R4.5.3）。
- R4.EB3 質量 delta CI 下界 = −5.0pp（邊界）→ 非劣性門不通過（R4.3.2）。
- R4.EB4 單臂缺失 → insufficient-data，不以單臂判成立（R4.5.4）。
- R4.EB5 某 skill 5 case → CI「僅供參考」；4 case → insufficient-data 徽章（R4.6.2/R4.6.3）。

## 非目標
- ❌ 不自動採用/自動改寫 skill（治理中立鐵律）。
- ❌ 不把 composite 拆成 per-skill 貢獻（假精度；>1 skill 變動時 per-skill 降為相關性）。
