# U5 · upgrade-u5-depgraph-engine — Tasks

Design: `docs/onchainos-upgrade-pipeline-design.md` §2.3/§5 表 U5. Files: `src/depgraph.js`（讀取率/共讀/
共觸發/Jaccard/盈虧平衡/merge-map）、`test/depgraph.test.js`、`test/fixtures/depgraph/*`（合成多 category
session 事件金樣本）。CONFIG 引用 [U0] `src/upgradeConfig.js` 的 `depgraph` 段。

## Tasks

- [x] T5.1 — 讀取率：`readRates(sessionEvents)` → 每 ref `{rate, n, advice}`（≥0.60 內聯 / ≤0.20 外移 /
  中間灰區）。**金樣本測試（邊界）**：rate=0.60 → 內聯、0.20 → 外移、0.40 → 灰區（R5.EB5）；每建議帶 n。
  _Requirements: R5.1.1, R5.1.2_
- [x] T5.2 — 共讀合併：`coReadPairs(sessionEvents)` → 共讀率 ≥0.80 的 ref 對 + n + 證據 session；消費 [U2]
  **[TL-M3]** 歸一後 ref。內聯測試：兩 ref 8/10 session 共讀 → 合併候選；6/10 → 不出；**金樣本**：兩 skill
  各持同內容 `_shared/util.md` 8/10 同讀 → 歸一單一 ref 共讀率 0.80 觸發（不稀釋成 0.40，R5.EB6）。
  _Requirements: R5.2.1, R5.2.2_
- [x] T5.3 — 共觸發圖 + merge-map：`coTriggerGraph(sessionEvents)`（節點觸發率/邊共觸發率）；
  `mergeMap(graph)` = 連通分量 ∩ 盈虧平衡過濾 ∖ `hardExcludeSkills`。內聯測試：連通分量正確；
  hardExcludeSkills 內的高共觸發 skill 不進 merge-map（R5.EB4）。
  _Requirements: R5.3.1, R5.3.2, R5.3.3_
- [x] T5.4 — **Jaccard 拆分 + 守門**：`jaccardSplit(skill, sessionEvents, {full})`：組間平均 pairwise
  Jaccard < 0.30 → 拆分候選 + 各 category 專屬讀取集；守門 ≥2 category × ≥5 session、限 full；否則
  insufficient-data。**金樣本測試（固定 Jaccard）**：兩 category 讀取集近乎不相交 → Jaccard≈0 <0.30 拆分；
  1 category → insufficient-data（R5.EB1）；某 category 4 session → insufficient-data（R5.EB2）；smoke →
  不出拆分（R5.EB3）。
  _Requirements: R5.4.1, R5.4.2, R5.4.3, R5.4.4_
- [x] T5.5 — 盈虧平衡：`breakEven(members, mergedDescEst, pTrigger)` = `(Σdesc − mergedDescEst)/4 / pTrigger`；
  pTrigger 參數化接口。**金樣本測試（固定數字）**：已知 desc/觸發率 → 膨脹上限對照手算。
  _Requirements: R5.5.1, R5.5.2_
- [x] T5.6 — 誠實標注：所有建議物件帶 n + 固定警語「實驗分布 ≠ 生產分布」+ 候選標記（非已採用）。內聯測試：
  輸出含警語欄位；建議 status == candidate。
  _Requirements: R5.6.1, R5.6.2_

## Rollup（實作完成 2026-07-10）
- 分析引擎附加於 `src/depgraph.js` 底部 `[U5] EXTENSION POINT` 之下；U2 採集層函數一行未改。頂部僅新增
  一行 `import { UPGRADE_CONFIG }`（ESM import 必須頂層 + U0 R0.0.2 禁止在他處重定義閾值——必要小裁決，
  已於檔內註解說明；採集邏輯無變動）。閾值全數取自 [U0] `UPGRADE_CONFIG.depgraph`，未重定義。
- 匯出：`readRates` / `coReadPairs` / `coTriggerGraph` / `mergeMap` / `jaccardSplit` / `breakEven` +
  U7 匯總端 `depgraphReport(sessions, {full, descBySkill})`。所有建議物件帶 `n` + `status:'candidate'` +
  固定警語 `note`；`depgraphReport` 另帶頂層 `disclaimer`。
- 測試：`test/upgrade-depgraph-engine.test.js`（10 tests，全綠）。`node --test` 全套 198/198 綠。
- 裁決：讀取率分母以「該 ref 之擁有 skill(s) 觸發」為條件（`_shared` 跨 skill 消費 → 擁有集取聯集），
  保證 rate ∈ [0,1]；共讀率分母取 N（總 session 數），使 R5.EB6 精確落在 8/10=0.80 vs 副本分裂 4/10=0.40。

## 交叉一致性註記
- Jaccard 守門（≥2 category × ≥5 session、限 full 集）+ 60/20/80 閾值 + 排除名單 + 警語為本 spec 硬要求
  （交叉一致性清單）；閾值全引用 [U0] CONFIG，不重定義。
