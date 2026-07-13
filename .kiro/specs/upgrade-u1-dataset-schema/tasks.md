# U1 · upgrade-u1-dataset-schema — Tasks

Design: `docs/onchainos-upgrade-pipeline-design.md` §1/§2.2/§5 表 U1. Files: `src/suite.js`（schema 校驗、
`caseSha256`、譜系/超集 lint、覆蓋/多意圖/smoke-tier lint）、`bin/aiide.js`（`aiide upgrade lint` 子命令）、
`test/suite.test.js`、`test/fixtures/upgrade-suite/*`（金樣本資料集：v1 + v2 超集 + 一條 superseded +
帶註解模板檔）。CONFIG 引用 [U0] `src/upgradeConfig.js`（`MIN_PAIRS_SKILL`/`dataset.*`）。

## Tasks

- [x] T1.1 — `src/suite.js` case schema 校驗：擴 `loadSuite` 校驗 R1.1 全欄位（含 `allowed_auxiliary`/
  `safety_negative`/`multi_intent`/`scripted_reply`/`held_out`/`added_in`）；**[TL-B2]** `must_confirm_before`
  校驗為結構 `{tools:[string], pathPattern?, note?}`（tools 非空陣列）；`must_confirm_before` 無 `scripted_reply`
  → 報錯；缺欄位錯誤帶 case id + 欄位名。內聯測試：合法 case round-trips；缺 `expected_skill` → 帶 id 報錯；
  `must_confirm_before` 無腳本 → 報錯；`must_confirm_before.tools` 非陣列 → 報錯。
  _Requirements: R1.1.1, R1.1.2, R1.1.2a, R1.1.3, R1.1.4_
- [x] T1.2 — `caseSha256`：`canonicalJson(case)`（鍵排序、確定序列化）→ `sha256`；**[TL-M4]** 以逐欄位
  whitelist 常數（R1.2.1 表）決定 include|exclude；schema 出現未分類欄位 → lint 報錯。**金樣本測試（固定
  輸入）**：同內容不同鍵序 → 同 sha；改 prompt/`allowed_auxiliary`/`must_confirm_before.tools`/**`category`**
  → sha 變；只改 `superseded_by`/`note`/**`held_out`** → sha 不變；注入未分類新欄位 → lint 報錯。
  _Requirements: R1.2.1, R1.2.2_
- [x] T1.3 — 譜系超集 lint：`lintLineage(oldSuite, newSuite)`：新版 id ⊇ 舊版（否則報「非超集」）；同 id 不同
  sha → 報「content changed … 用 superseded_by」；合法 superseded（舊標 superseded_by + 新 id 新增）→ 通過；
  懸空 superseded_by → 報錯。**金樣本測試**：fixture v1→v2 超集通過；v1→v2' 改 prompt → 報錯；v1→v2''
  superseded 路徑 → 通過；v1→v2''' 移除 case → 報錯。
  _Requirements: R1.3.1, R1.3.2, R1.3.3, R1.3.4, R1.EB2, R1.EB3_
- [x] T1.4 — case-id 穩定性 + 交集配對輔助：`dedupeCheck`（重複 id 報錯）、`pairByIdIntersection(armA, armB)`
  返回共有 id 集（[U4] 消費）。內聯測試：重複 id 報錯；兩集交集正確（不要求 dataset sha 全等）。
  _Requirements: R1.4.1, R1.4.2_
- [x] T1.5 — 兩層 + held-out + 各 lint：`splitTiers`（smoke/full）、`heldOut` 篩選、`lintSkillCoverage`
  （<`MIN_PAIRS_SKILL` → `insufficient-coverage` 警告帶 `{skill,currentN,target,needMore}` [PM-B6]）、
  `lintMultiIntent`（多意圖佔比 <`minMultiIntentPct` → 警告 [PM-B5]）、`lintSmokeTierSize`（smoke 數在
  `[smokeTierMin,smokeTierMax]` 外 → 警告 [PM-B7]）；產帶註解 case 模板檔 fixture。內聯測試：held_out 篩出
  正確；某 skill 3 case → 警告帶 needMore=2；多意圖 10% < 15% → 警告；smoke 15 case → 區間外警告；模板檔可過
  `loadSuite`。
  _Requirements: R1.5.1, R1.5.2, R1.6.1, R1.6.2, R1.7.1, R1.8.1, R1.8.2, R1.EB1_

## Rollup（實作完成 2026-07-10）

**檔案**：`src/suite.js`（U1 全部實作，附加於既有 loader/scaffold 之後）、`test/upgrade-suite.test.js`
（31 測試）、`test/fixtures/upgrade-suite/case-template.jsonc`（帶註解全欄位模板，R1.8.2）。

**驗收**：`node --test test/upgrade-suite.test.js` → 31 pass / 0 fail；`node --test`（全套）→ 157 pass /
0 fail（既有 126 未破）。

**AC ↔ 證據**
- R1.1（schema 校驗）：`validateCase` 校全欄位 + 型別；`loadSuite` 偵測 `cases[]` 才校驗，classic
  task-suite（`tasks`、無 `cases`）原樣穿透 → T1.1 一組測試（缺 `expected_skill` 帶 id 報錯、型別錯、
  loadSuite 拋錯前不返回）。
- R1.1.2 / R1.1.2a（[TL-B2]）：`must_confirm_before={tools:[string],pathPattern?,note?}`；`tools` 非空
  字串陣列；無 `scripted_reply` → `missing-scripted-reply` → T1.1 專測。
- R1.2（canonical sha）：`CASE_FIELD_CLASSIFICATION` 逐欄位 include|exclude 常數；`canonicalJson`
  鍵排序保陣列序；`caseSha256` 遇未分類欄位拋 `unclassified-field` → **golden 測試**（固定輸入 sha=
  `c5b05bbf…ca36c`、鍵序無關、改 prompt/allowed_auxiliary/category/must_confirm_before→變、改
  superseded_by/note/tags/held_out/tier/added_in/id→不變、注入未分類→拋）。
- R1.3（譜系超集）：`lintLineage` 超集 + per-case sha 相等 + 懸空 superseded；訊息含
  `content changed (<8>→<8>) … superseded_by` → T1.3 四路（v2 超集過 / v2' 改字報 / v2'' supersede 過 /
  v2''' 移除報）+ 懸空 R1.EB2。
- R1.4：`dedupeCheck`（重複 id）、`pairByIdIntersection`（交集、不要求 sha 全等、接受 suite/case 陣列/
  raw id 陣列）→ T1.4。
- R1.5–R1.8 / R1.EB1：`splitTiers`、`heldOut`、`lintSkillCoverage`（`{skill,currentN,target,needMore}`
  [PM-B6]）、`lintMultiIntent` [PM-B5]、`lintSmokeTierSize` [PM-B7]、`lintAuxiliaryRedundancy`
  [R1.EB1]、`lintSuite` 聚合 → T1.5（needMore=2 / 10%<15% / smoke 15 區間外 / 模板過 loadSuite）。

**自行裁決（小）**
1. **`tier` 欄位分類**：R1.2.1 whitelist 表未列 `tier`，但 R1.5.1 要求 case 可標層級。新增 `tier`
   （`'smoke'|'full'`）並在 `CASE_FIELD_CLASSIFICATION` 標 **exclude**（理由同 `held_out`：組織性層級標記，
   移動層級是治理操作、非內容編輯，不應動 sha / 逼發新 id）。已在常數處註記。
2. **CLI 未接線**：tasks.md 提及 `bin/aiide.js` 的 `aiide upgrade lint` 子命令，但該檔不在本 agent 檔案集
   （並行 agent 動用）。改為將 `lintSuite` 等以 library export 提供，CLI 接線留給 U0/pipeline owner。
3. **校驗落點**：R1.1.4 指名 `loadSuite` 報錯 → 於 `loadSuite` 內在偵測到 `cases[]` 時呼叫
   `validateSuiteCases`（含重複 id 拒絕），無 `cases` 的既有 suite 完全不受影響。

## 交叉一致性註記
- 本 spec 只**提供** `category`/層級標記/覆蓋 lint；閾值（`MIN_PAIRS_SKILL`/`dataset.*` 等）唯一定義在
  [U0] config `src/upgradeConfig.js`、本 spec 引用不重定義；Jaccard 守門在 [U5]、per-skill 診斷在 [U4]。
- per-case canonical sha256 + superseded_by 譜系為本 spec 專屬硬要求（交叉一致性清單）。
