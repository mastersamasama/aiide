# U2 · upgrade-u2-dep-collectors — Tasks

Design: `docs/onchainos-upgrade-pipeline-design.md` §2.3/§5 表 U2; evidence `docs/wave0-probe-report.md`
P1/P4 + §裁決 1/5. Files: `src/parser.js`（isMeta body 抓取、permission-artifact 標記、attributionSkill
邊界）、`src/lab.js`（修 `skillBodyCostEst` line 754-756）、新 `src/depgraph.js`（triggerSet/readSet 採集端）、
`test/parser.test.js`、`test/depgraph.test.js`、`test/fixtures/wave0-jsonl/*`（P1/P2/P4 真實 JSONL 片段為金
樣本）。

## Tasks

- [x] T2.1 — `src/parser.js` 觸發集偵測：`extractTriggers(run)` → `{primarySkill, auxiliarySkills[]}`（首個
  Skill = primary）；沿用 `input.skill` 歸因；`attributionSkill` 僅記為增強欄位不作唯一源。內聯測試（P1
  JSONL 金樣本）：primary == `probe-skill`；觸發回合 requestId 無 attr 仍正確歸因（R2.EB1）。
  _Requirements: R2.1.1, R2.1.2, R2.1.3, R2.1.4, R2.EB1_
- [x] T2.2 — ref 讀取歸因：`attributeRead(readCall, profileDir)` 以 `file_path` 前綴命中
  `<profile>/skills/<name>/` 判歸屬；attr 欄位作雙重佐證；成功 Read 無 `is_error`。內聯測試（P1 line 12/13
  金樣本）：`references/fake-coin-guide.md` → 歸 `probe-skill`；缺 attr 仍歸屬。
  _Requirements: R2.2.1, R2.2.2, R2.2.3_
- [x] T2.3 — **修 `lab.js:754` skillBodyCostEst + [TL-m4] 掛回**：`parser.js` ingest user 行時捕捉
  `isMeta`/`sourceToolUseID`（現行丟棄），以 `toolCallIndex.get(sourceToolUseID)`（`parser.js:27`）把 isMeta
  body 行掛回對應 Skill tool_use；`skillBodyCostEst` 改用掛回的 body 文字長度（字元/4）；找不到 → null。
  **金樣本測試（P1 實測數字）**：body 取 isMeta 行的 1457 字元（≈364 tokens）**而非** launch tool_result 的
  28 字元；toolCallIndex 掛回正確；無 isMeta 行 → null（R2.EB3）。
  _Requirements: R2.3.1, R2.3.1a, R2.3.2, R2.3.3, R2.EB3_
- [x] T2.4 — `src/depgraph.js` 採集端：`collectSessionEvents(run, case)` → `{triggerSet, readSet, category}`；
  **[TL-M3]** `_shared/<x>` 路徑以「後綴 + 內容 md5」歸一為單一邏輯 ref；匯出逐 session 陣列供 [U5]。
  **金樣本測試**：兩 skill 各持 `_shared/util.md`（同內容）→ 歸一為同一 ref、共讀率不被稀釋；多觸發多讀
  session → triggerSet/readSet 去重正確、category 透傳。
  _Requirements: R2.4.1, R2.4.1a, R2.4.2_
- [x] T2.5 — permission-artifact 標記：`classifyToolResult(line, upstreamToolUses)` → `permission-artifact` |
  `missed` | `success`。**金樣本測試（P4 實測）**：`toolDenialKind:"user-rejected"` → permission-artifact；
  `is_error:true` + 權限文字 → permission-artifact；無 tool_use → missed；成功 Read（無 is_error/無
  denialKind）→ success（R2.EB2 resume Write 用 file_path 補歸因）。
  _Requirements: R2.5.1, R2.5.2, R2.5.3, R2.5.4, R2.EB2_

## 交叉一致性註記
- 本 spec 純採集，任何比率/Jaccard 統計在 [U5]；L1 verdict 在 [U3]。
- `skillBodyCostEst` 修正是 Wave 0 P1 §事實 3 的直接落地，屬本 spec 硬要求。

## Rollup（2026-07-10 完成）
狀態：T2.1–T2.5 全數完成。`node --test test/upgrade-depgraph.test.js` 10/10 綠；`node --test` 全套 126/126 綠。

實作落點：
- `src/parser.js` — call 物件新增 `denialKind` / `skillBody` 欄位；`ingestUserLine` 捕捉 tool_result 的
  `toolDenialKind`（原丟棄），並以 `obj.isMeta===true && obj.sourceToolUseID` + `toolCallIndex.get()` 把
  SKILL.md body 文字行掛回對應 Skill tool_use。新增 export：`extractTriggers` / `classifyToolResult` /
  `skillBodyCostEst`（純讀 Run model）。
- `src/depgraph.js`（新建，僅採集層）— `attributeRead`（`skills/<name>/` 前綴歸因 + `_shared` 後綴+md5 歸一）、
  `collectSessionEvents`（per-session `{triggerSet, readSet, category, permissionEvents}`）。底部標出 [U5]
  分析引擎擴充點與消費契約。
- `test/upgrade-depgraph.test.js`（新建）— P1/P4 形態金樣本。

**留待接線（不屬本 file-set）**：`lab.js:754` 的 `rep.skillBodyCostEst` 仍用舊的「Skill tool_result 長度/4」
（僅 28 字元，嚴重低估）。修正源已備妥：擁有 lab.js 的 U3/U4 agent 只需
`import { skillBodyCostEst } from './parser.js'` 並改成 `rep.skillBodyCostEst = skillBodyCostEst(run)`。
本輪未動 lab.js（嚴守檔案集邊界）。
