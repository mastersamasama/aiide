# U7 · upgrade-u7-upgrade-report — Tasks

Design: `docs/onchainos-upgrade-pipeline-design.md` §3/§5 表 U7; 視覺見 `docs/ixd/`. Files: `bin/aiide.js`
（`upgrade run/compare/report` 子命令）、新 `src/report.js`（report.json/md/HTML 組裝、vendor sha256 校驗）、
`aiide/web/vendor/`（ECharts pinned dist + sha256 + NOTICE）、`test/report.test.js`、
`test/fixtures/synthetic-bundle/*`（3-4 假 skill + 12 用例的合成 verdict 物件）。

## Tasks

- [x] T7.1 — `bin/aiide.js` `upgrade` 子命令：`run`/`compare`/`report --format json|md`/**`smoke --mix`**；
  run/compare 前印 [U0] 預算表；**[PM-B1/PM-N1]** `smoke --mix skillA=new,skillB=old [--baseline new|old]`
  走 [U0] R0.2b 混合採集 + [U4] verdict 引擎產 mini-verdict（配對 = 混合臂 vs 基線臂，預設 old-full）、header
  標 mixed-bundle + mix 映射 + 對照臂身份。內聯測試：四子命令路由；report --format 切換；budget 表先印；
  `--mix` 解析 → 混合 profile + mixed-bundle header；`--baseline` 切換基線臂、預設 old-full。
  **[TL-N-MAJOR-1] e2e（從 U0 移入）**：smoke --mix 端到端跑通 → 產 bundle 級 mini-verdict（混合臂 vs 基線臂
  配對）、header 記錄對照臂身份。
  _Requirements: R7.1.1, R7.1.2, R7.1.3, R7.1.3a_
- [x] T7.2 — `src/report.js` report.json：`buildReportJson(verdict, depgraph, staticGates, meta)` verdict-first
  schema（三層同構）；落點 **`<dataDir>/upgrades/<compare-id>/`**、寫後不可變（[TL-M1]）。**金樣本測試
  （synthetic bundle）**：第一層即 verdict；permission-artifact 與 flow-incomplete 單獨欄；per-skill 表帶
  「非採用證書」；版本四元組 + 檢定揭露 + 排除率齊全；重跑產新 compare-id 目錄不覆蓋舊者（R7.EB6）。
  _Requirements: R7.2.1, R7.2.2, R7.6.1, R7.6.2, R7.6.3_
- [x] T7.3 — report.md：`buildReportMd(reportJson)` 編號標題（`## N.`）、verdict 第一章。內聯測試：grep
  `## ` 可截章節；verdict 首章（R7.EB3）。
  _Requirements: R7.3.1, R7.3.2_
- [x] T7.4 — 單檔 HTML：`buildReportHtml(reportJson)` inline ECharts + 全圖（graph/heatmap/sankey/delta
  卡/質量表/**盈虧表列代入值 Σ成員desc/估計合併desc/P(組觸發)/上限 [PM-B4]**/建議卡）+ footer（含生效 config
  參數）；inconclusive/insufficient-data banner + **[PM-B2] 下一步指引**（還需 N 條 / 被排除 case-id+原因+
  動作 / 補到 MIN_PAIRS_SKILL）；L3 heuristic 標注。內聯測試：單檔含 ECharts inline；insufficient-data →
  無「可採用」+ 印「還需 N 條配對」（R7.EB1/R7.EB5）；盈虧表列代入值；無 sentinel → heuristic（R7.EB4）。
  原型 QA：Playwright + TreeWalker 可見文字斷言 + 截圖（避 textContent.includes script 假陽性）。
  _Requirements: R7.4.1, R7.4.2, R7.4.3, R7.4.4, R7.8.1_
- [x] T7.7 — **[PM-B3] 跑後自動化**：`regressedCards(reportJson)` 並排兩臂 L1 觸發集/L2 結果/L3 終態/
  read-set diff，按 [U4] `clusterRegressed` 的 skill×category 分組；`reportDiff(curr, prev)` 結構化對比節
  （無 prev → 標「無基準」不報錯）。內聯測試：regressed case 卡含兩臂 diff + 聚類分組；報告 diff 呈現 verdict/
  各軸變化；無 prev → 優雅缺省（R7.EB7）。
  _Requirements: R7.7.1, R7.7.2, R7.7.3_
- [x] T7.5 — vendor 完整性：`aiide/web/vendor/echarts.min.js`（pin 版本 + NOTICE）+ `verifyVendorSha256()`；
  dashboard 核心不 import vendor。內聯測試：sha256 == pin → 產 HTML；篡改 → 報錯不產（R7.EB2）；掃描確認
  `web/index.html` 核心不 import vendor（R7.5.2）。
  _Requirements: R7.5.1, R7.5.2_
- [x] T7.6 — 合成 fixture 端到端：3-4 假 skill + 12 用例（含 multi_intent/safety_negative/allowed_auxiliary）
  跑通全管線，驗 report.json schema + HTML 產出（設計 §8 驗證計畫）。
  _Requirements: R7.2, R7.4_

## 交叉一致性註記
- **ECharts 僅 vendored 進報告產物**（pin+sha256+NOTICE），是鐵律硬要求；dashboard 核心零 ECharts。
- 報告消費 [U4] verdict / [U5] 依賴圖 / [U6] 靜態閘 / [U0] 預算，本 spec 不重算統計。

## Rollup（完成狀態）
狀態：**全 7 任務完成**（T7.1–T7.7）。`node --test test/upgrade-report.test.js` = 23/23 綠；`node --test` 全套 = 281/281 綠（無回歸）。

交付檔：
- `src/report.js`（新）：`buildComparison`（配對→U4 aggregateArm/pairedBootstrapCI/decideVerdict/perSkillDiagnostics/clusterRegressed + score.js compareFlowIncomplete 折疊 mini-verdict）、`buildReportJson`（verdict-first schema）、`buildReportMd`、`buildReportHtml`（inline ECharts + inline JSON 單檔）、`verifyVendorSha256`、`writeReport`（寫後不可變）、`buildRegressedCards`、`reportDiff`、`makeCompareId`。
- `bin/aiide.js`：`aiide upgrade lint|preflight|run|compare|report|smoke`；三條累積接線（lint→U1 lintSuite、跑前印 U0 estimateBudget 預算表、preflight→U6 runStaticGates fatal 即非零退出）。
- `web/vendor/echarts-5.6.0.min.js`（sha256 bf4a2235…c07b1，校驗相符）+ `web/vendor/NOTICE`（Apache-2.0）。
- `test/upgrade-report.test.js`（新）、`test/fixtures/synthetic-bundle/bundle.js`（4 假 skill × 13 配對，含 regressed/excluded/reference-only/heuristic/permission-artifact + mixed 臂）。

裁決記錄（小）：
- **report.json = 扁平 verdict-first schema，對齊 `docs/aiide-skill.md` §AX（U7↔U8 介面契約，team-lead 裁決）**。頂層第一鍵即 `verdict`（`verdict`/`established`/`intent`/`pairs`/`gates`/`reasons` = decideVerdict 輸出逐字攤平在根）；`arms.{new,old}`、`header.{baselineArm,mixedBundle,mix,exclusion,echarts}`、`axes.{quality,cost,flowIncomplete}`、`l2Breakdown.permissionArtifact`、`perSkill.{skills,note}`、`depgraph`、`footer.{config,versionQuad,tests}`、`cohort`/`lineage`/`cases[].{caseId,delta,regressed}`。server 端 `GET /api/upgrades`（listUpgrades 讀 `verdict/established/intent/compareId/createdAt/cohort/lineage/arms.*`）、`/api/upgrades/<id>`（整份 report.json）、`?trend=1`（cohort/lineage 分組 + case-id 交集序列）**已 e2e 驗證消費無誤**。HTML 的 S1-S6 錨點改為映射到扁平 schema 的子樹（copy-JSON 複製子樹，維持 AI 同構）。
  - （原設計曾為 `s1_verdict..s6_footprint` 分區頂層鍵；因 u8 的 server+dashboard 已按 §AX 扁平 schema 消費，且 §AX 更貼合「第一層即 verdict」的字面，故整體對齊過去、重構 buildReportJson/Md/HTML + 測試。）
- **測試路徑用合成 fixture 而非真跑 claude**（R0.2b.4 移交明示「用 stub 採集資料即可」）：`smoke --mix` e2e 走 `armMixed vs armOld` → U4 引擎產 bundle 級 mini-verdict，header 記錄 mix 映射 + 對照臂身份。
- **金樣本 verdict = cost-opt 不成立**（regressed 案例 swap-006 拉低 L1 非劣性 CI）——刻意選 fail 路徑當主樣本以同時涵蓋 regressed 卡 / reason / fail 徽章；insufficient/inconclusive/established/reference-only 三態另以行內小臂覆蓋。
- **HTML 版型**：自帶精簡但完整的單檔生成器（借鑑 ixd phase7 原型的 `__REPORT_DATA__`/`__ECHARTS__` 注入手法與 ECharts option 程式碼），schema 為權威、零 docs/ixd 執行期耦合。
- **呈現層文案改版（用戶回饋，schema 零變更）**：全域判定改布林推薦式（`升级推荐: true/false`；insufficient/inconclusive → `无法判定（…）`，絕不顯示 false）；徽章下方第一屏敗因一句話（從非劣性門/flow/成本訊號導出，如「败因：L1 路由质量未过非劣性门（配对 delta CI 下界 -9.1pp，边界 -5pp）」）；三軸卡標籤 axisT/axisTok/axisSec → 轮数/Token 成本（等效全价）/耗时；下一步指引改人話（「onchain.swap 样本 6 条（偏少，结论仅供参考）→ 补到 8 条可信」）。全為既有呈現欄位（summary/nextSteps.message/i18n label）文字或 render-層導出，`verdict`/`established`/`gates`/`reasons`/`axes` 等 U8 消費欄位一律不動。導出 `recommendationText`/`failureCause`/`axisLabel` 供 md+bin 共用，HTML inline JS 鏡像同邏輯。
- **產出統一 zh-hans（目標讀者 onchainos 團隊為簡體）**：report.js 全部 render/md/HTML 字串繁→簡（連 U5 傳入的 disclaimer 也在呈現層正規化，不動 depgraph.js）；bin CLI 本就簡體；測試斷言同步簡體 + 新增 zh-hans 回歸守衛（掃 report.md/visible-HTML 無繁體字洩漏）。
- **S1 副標黑話重寫 + 統計術語 tooltip（用戶回饋）**：S1 副標「採用證書/第一屏必達結論/治理中立」設計師自語 → 人話「本区结论适用于整包 skill（不可据此拆开混搭采用）· 工具只给证据，是否采用由你决定」；統計術語（paired/MIN_PAIRS/排除率/非劣性門δ/CI/仅供参考/flow-incomplete/permission-artifact/intent 三型）加原生 `title=` hover tooltip + 虛線底線（`.gloss`，零依賴），文字集中成導出的 `GLOSSARY` 常數（單一來源，build 時注入 HTML）。**Playwright 實測**：真實瀏覽器渲染確認 S1 副標無黑話、13 個 `.gloss[title]` 掛上 DOM、術語→tooltip 對映正確、echarts 內聯正常。
- **敗因句人話三段式（用戶回饋）**：`failureCause()`/`failureCauses()` 按 gate 類型出模板，形狀「哪裡變差 → 差多少（容差）→ 對用戶意味著什麼」，統計退居括號（L1 例：「新版把问题派给正确 skill 的比例明显下降——最坏估计比旧版低 27.3 个百分点（容差 5pp），用户的问题会被路由到错的 skill」）；L2/L3/flow-incomplete/cost-opt-無成本降/成本升 各有模板；多 gate 同時 fail 逐條列、最嚴重在前（safety>routing>result>flow>cost）；「最坏估计」掛 worstCase tooltip（=配對 delta 95% CI 下界）。md/CLI 用單串接版、HTML 用清單版。Playwright 實測敗因句渲染 + 最坏估计 tooltip 掛 DOM。
- **S1.1 per-skill 表四項修正 + 題目下鑽（用戶回饋）**：(1) 修徽章重複渲染 bug（原「∅ insufficient-data insufficient-data」→ 每格單一徽章）；(2) 狀態詞中文化 + 收進 tooltip（`∅ 样本不足`/`～ 仅供参考`，解釋進 title）；(3) 表頭黑話去 spec 編號（R4.6.5 不進 UI）→「单个 skill 的诊断用于定位问题，不能据此拆开采用；要混搭需另跑混采确认（smoke --mix）· 点行展开该 skill 的题目明细」；(4) 點 skill 行 → 行下方就地展開該 skill 的題目清單（caseId/prompt 原文/category/新舊兩臂 L1/L2/L3/成本 delta/regressed 標紅），資料從 `cases[]` 依 skill 過濾，與 S5 聯動並存（不 scroll away）。「主要关注」欄人話（swap→「路由正确率疑似下降（最坏 -50pp）」；無訊號→「数据不足，建议补题」）。導出 `perSkillStatus`/`perSkillConcern`。S5 每題顯示 prompt 原文。cases[] 加 `prompt`/`arms.{new,old}.{l1,l2,l3}`/`costDelta`（additive，U8 讀 caseId/delta 不受影響）。Playwright 實測：徽章單一、表頭無 R4.6.5、點行展開題目明細（prompt+兩臂逐層+成本 delta+regressed 紅）、S5 顯 prompt、0 console error、截圖存證。
- **下鑽子表 diff-first 緊湊化 + 「臂」出 UI（用戶回饋）**：(1) 全報告 sweep「新臂/旧臂/两臂/单臂」→「新版/旧版/两版/单版」（md+HTML visible 零「臂」，加守衛斷言；arm 只留 JSON/code）；(2) 子表欄改 `题目 id · prompt · category · 路由 · 结果 · 安全 · 成本变化`（L1/L2/L3 人話化、舊新合併一欄），每格用 `layerDiff` 出緊湊符號：兩過 `✓`(淡)/兩不過 `✗`(淡紅)/**退步 `✓→✗`(醒目紅，唯一該跳出)**/改善 `✗→✓`(綠)，monospace 無框；成本 `costCompact` 緊湊（`轮 -2 · tok +340`，無變化 `—`）；regressed 行淡紅底、格內不堆色塊；同格式同步 S5。導出 `layerDiff`/`costCompact`。Playwright 實測：swap-006 路由格 `✓→✗`(class dc reg)、成本「轮 -2」、整頁 innerText 零「臂」、S5 同 route/result/safety 欄、截圖存證。
- **S2-S6 全節文案審計（用戶回饋 loop-1）**：S2 欄名`A旧/B新`→`旧版/新版`、加「结论」欄人話（L1「新版变差（最坏 -27.3pp，超 5pp 容差）」/L2L3「没问题」）、副標人話、flow→「确认后中断率」+ tooltip、permission→「权限拒绝：N 例（工具没拿到权限，不算路由错误）」、L3 heuristic 去 spec 編號→「安全判定基于启发式识别（skill 未输出 CONFIRM_REQUIRED 标记…）」；S3 seed 從卡片+CI tooltip 移除（挪 S6）、零變化`— 持平`無箭頭、副標 tooltip、不显著 tooltip；S4 disclaimer 展開整句；S5 特殊態標籤（price-001`∅ 权限拒绝`+tooltip、excluded`∅ 已排除`、unpaired`∅ 未配对`）、英文枚舉→中文（`ENUM_ZH` 集中 map：ok→正常/wrong-route→路由错/executed-after-confirm→确认后执行…）、read-set diff 只列非空半句、prompt 尾部重複題號`stripCaseId`剝掉；S6`版本四元组`→`环境版本`、检定总数+bootstrap seed 掛 tooltip。導出 `stripCaseId`/`zhEnum`/`ENUM_ZH`。**Playwright 全頁掃：0 spec 編號(R\d)、0 英文枚舉、0 debug seed 在卡片**，截圖存證。**測試 45/45**（+7 審計斷言）。
- **fresh-eyes loop-2 12 條修復（不懂統計的 skill 工程師視角）**：(1) S5 chips/副標/聚類中文（全部/退步题/已排除/流程未完成）；(2) S1 頂零值成本卡 `▲ 0 tok`→`— 持平`，S1/S3 共用 `costHead`（零值無箭頭）；(3)「显著」補 tooltip；(4)「等效全价」補 tooltip；(5) S2 刪可見「Wilson」（進 tooltip）；(6) S2 heuristic 警告→「部分 skill 没明确标注需要确认…」（CONFIRM_REQUIRED 進 tooltip）；(7) intent→「本次改动性质：省成本/修质量/中性重构」（英文枚舉進 tooltip）+ summary 去掉與敗因/徽章的逐字重複；(8) 裸變數名出 UI：MIN_PAIRS→可信下限、benjamini-hochberg→多重比较校正、seed 數值只進 tooltip；(9) mixed header「（混采确认 smoke）」→「（混采确认）」；(10) 最坏 pp 精度統一一位小數；(11) S4 tab 中文（共同触发图/共同读取热力/意图→skill→文档 流向图）+ 建议标题；(12) S1.1「仅列数字，暂不下结论」+ 列頭「路由变化区间」。導出 `intentZh`；`costHead`/`axLabelHtml` 共用。**Playwright 全頁掃 innerText：0 spec 編號、0 英文枚舉/裸變數名、0 seed 數值可見、零值皆「— 持平」無箭頭**，全頁截圖存證。**測試 48/48 · 全套 312/312**。
- **fresh-eyes loop-3 收尾（N2 + PARTIAL-7 + MINOR）**：(N2) 全 GLOSSARY 過一遍——主句人話、術語/原名只在句尾括號（可信下限「整包至少 8 题、单个 skill 至少 5 题才给统计结论（内部名 MIN_PAIRS…）」；CI/最坏估计/非劣性/路由变化區間的「bootstrap 重采样」「配对 delta CI」「置信区间」→ 改「反复重抽样本估…」；CONFIRM_REQUIRED 降到句尾括號）；(PARTIAL-7) 3 處裸「per-skill」→ nav「S1.1 单 skill」/小節標題「各 skill 归因诊断」/summary「各 skill 诊断」；(MINOR) S5 表頭「prompt」→「题目原文」、S2 表頭「delta」→「变化」+tooltip、S6「报告 diff」→「与上次报告对比」、「排除率绊线」→「排除率上限」（原詞 tooltip）。**Playwright 快掃：0 tooltip 以裸術語開頭、可見文字 0 個 per-skill/prompt/delta 表頭、36 tooltip 主句皆人話**，截圖存證。**測試 51/51 · 全套 316/316**。
