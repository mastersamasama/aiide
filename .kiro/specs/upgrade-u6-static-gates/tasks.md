# U6 · upgrade-u6-static-gates — Tasks

Design: `docs/onchainos-upgrade-pipeline-design.md` §1/§2.4/§5 表 U6. Files: 新 `src/skillint.js`（desc lint /
觸發碰撞 / _shared 漂移 / 固定稅表 / 宣告版本比對 / fail-fast）、`bin/aiide.js`（`aiide upgrade preflight`）、
`test/skillint.test.js`、`test/fixtures/skillint/*`（含超長 desc / 碰撞 / 漂移金樣本）。CONFIG 引用 [U0]
`src/upgradeConfig.js` 的 `staticGates.descMaxUnicode`。

## Tasks

- [x] T6.1 — desc lint：`descLint(skill)` 以 `[...desc].length`（code point）比 `descMaxUnicode`；>1024 →
  error 帶名/計數。**金樣本測試（邊界）**：1024 中文字元 → 通過、1025 → error（R6.EB1）；code point 計數
  不等於 byte 長度。
  _Requirements: R6.1.1, R6.1.2, R6.1.3_
- [x] T6.2 — 觸發碰撞：`triggerCollision(skills)` 確定性字串比對，列碰撞詞 + skill。內聯測試：重疊觸發詞 →
  警告；無共同詞 → 無警告（R6.EB2）。
  _Requirements: R6.2.1, R6.2.2_
- [x] T6.3 — `_shared` 漂移：`sharedDrift(skills)` 比各 skill `_shared` 片段 md5。內聯測試：不一致 → 漂移
  警告帶 md5；一致 → 無警告（R6.EB3）。
  _Requirements: R6.3.1_
- [x] T6.4 — 固定稅表：`taxTable(skills)` 生成 generic 彙總（desc 字符數/觸發詞數/_shared 引用）結構化物件。
  內聯測試：欄位齊全、generic（無 onchainos 專屬鍵）。
  _Requirements: R6.4.1, R6.4.2_
- [x] T6.5 — 宣告版本比對 + fail-fast：`declaredVersionCheck(arms)`（靜態面，不呼叫 CLI）；
  `runStaticGates(skills, arms)` 匯總，任一 error → fail-fast 零 token、warning 進報告。內聯測試：error +
  warning 並存 → fail-fast 但 warning 仍在報告物件（R6.EB4）；全過 → 不中止。
  _Requirements: R6.5.1, R6.6.1, R6.6.2_

## Rollup（實作完成 2026-07-10）
- 新建 `src/skillint.js`（generic、零依賴、零 token；純字串 + md5）。閘核心對 skill descriptor 物件
  `{name, description, triggers[], shared{path:content}}` 為純函數（可單測、可被 CLI/報告消費）；`descMaxUnicode`
  取自 [U0] `UPGRADE_CONFIG.staticGates`，未重定義。
- 匯出：`descLint` / `triggerCollision` / `sharedDrift` / `taxTable` / `declaredVersionCheck` +
  匯總 `runStaticGates(skills, arms, opts)` → `{errors, warnings, fixedTaxTable, fatal, ok}`。
- 測試：`test/upgrade-skillint.test.js`（8 tests，全綠，含 emoji 代理對 code-point 反例）。`node --test` 198/198。
- 裁決：本 task 原列 `bin/aiide.js`（`aiide upgrade preflight`）CLI wiring，**不在我核准的檔案集內**故未動；
  `runStaticGates` 已回傳結構化物件供 [U0] preflight / CLI 直接接線，接線本身留給持有 bin/ 的 owner。

## 交叉一致性註記
- 本 spec 為 generic（不綁 onchainos）；運行期 `onchainos --version` 斷言在 [U0] R0.2.2，本 spec 只靜態
  宣告面 + 零 token fail-fast。descMaxUnicode 引用 [U0] CONFIG。
