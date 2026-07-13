# U8 · upgrade-u8-ax-docs — Tasks

Design: `docs/onchainos-upgrade-pipeline-design.md` §3/§5 表 U8. Files: `aiide/docs/aiide-skill.md`（AX 章節
增補）、`aiide/web/obs.js`（upgrade 檢視純邏輯，可單測）、`aiide/web/index.html`（唯讀 upgrade 檢視渲染）、
`aiide/src/server.js`（**[TL-M1] 新增唯讀 GET `/api/upgrades`**）、`test/obs.test.js`、`test/server.test.js`。

## Tasks

- [x] T8.1 — `aiide-skill.md` AX 章節：`upgrade run/compare/report/smoke --mix` 契約、report.json 頂層鍵、
  report.md `## N.` grep 慣例、verdict 語意 + 判讀規則（insufficient-data/inconclusive 不可當持平/可採）、
  治理中立聲明。內聯檢查：文檔含各 verdict 值說明 + 「採用為人類決策」句 + 引用權威設計文檔路徑。
  _Requirements: R8.1.1, R8.1.2, R8.1.3, R8.3.1, R8.3.2_
  → `docs/aiide-skill.md` 新增「AX — driving the upgrade pipeline」章節：子命令表（run/compare/report/
    `smoke --mix --baseline`/lint/preflight）、report.json verdict-first 頂層鍵逐一列、report.md `## N.` grep
    契約（含 `grep -A20 '^## 1\.'`）、五 verdict 語意表 + 硬規則（insufficient-data/inconclusive 非「持平/可採」）、
    治理中立段（per-skill 非採用證書、**adoption is always a human decision**）、引用權威設計 §1/§2.2/§3/§5 +
    Wave 0 探針附件、`/api/upgrades` 唯讀端點。
- [x] T8.2 — `web/obs.js` upgrade 檢視純邏輯：`buildUpgradeView(reportJson)` → banner/卡/版本四元組 +
  **[PM-B2] 下一步指引**（還需 N 條 / 被排除 case-id+原因+動作 / 補到 MIN_PAIRS_SKILL）view model。內聯測試
  （`test/obs.test.js`）：verdict banner 文案對映；insufficient-data → 明示不足 + 「還需 N 條」（R8.EB1）；
  三軸卡帶 CI 與 n。
  _Requirements: R8.2.1, R8.2.3_
  → `web/obs.js` 新增 `upgradeVerdictGlyph`（四態 ✓✗~∅）/`upgradeAdoptable`/`upgradeNextSteps`/`upgradeRedlist`/
    `buildUpgradeView`（純函式，沿 [[aiide-web-obs-testable-module]] 範式）。測試落既有 `test/web-obs.test.js`
    （專案實際檔名，非 spec 佔位的 obs.test.js）新增 6 個 U8 案例：四態 glyph、非採用（insufficient/inconclusive
    永不 adoptable）、「還需 N 條」= MIN_PAIRS−pairs、inconclusive 枚舉 case-id+原因+動作、紅名單排序、
    buildUpgradeView 組裝 + 依 report footer 的 MIN_PAIRS 算 N。
- [x] T8.3 — `web/index.html` 唯讀渲染：新增 upgrade 檢視 tab（走 GET `/api/upgrades` 讀摘要 + 選定
  compare-id 讀 report.json），零 ECharts inline。內聯檢查：dashboard 核心掃描零 `echarts` import（R8.EB2）；
  檢視唯讀（無寫入/採用入口）。
  _Requirements: R8.2.1, R8.2.2_
  → `web/index.html` 新增 nav `#upgrades` + 三檢視（`viewUpgrades` 列表 / `viewUpgrade` 詳情卡 /
    `viewUpgradeTrend` 趨勢）+ 手寫 SVG `miniDelta`/`trendChart` + zh-hans/en 雙語 dict。`grep -i echarts`
    僅命中文案/註解 4 處（無 import/script），R8.EB2 成立。全檢視唯讀、無採用入口。瀏覽器 e2e 驗過三態
    渲染 + 雙語切換（見 rollup）。
- [x] T8.4 — **[TL-M1]** `src/server.js` 唯讀 GET `/api/upgrades`：列 `upgrades/<compare-id>` report.json
  摘要；`?trend=1` 回同 model cohort、case-id 交集配對趨勢序列（superseded 譜系斷開）；非 GET → 405（沿用
  `server.js:24`）。內聯測試（`test/server.test.js`）：GET 列摘要；`?trend=1` 趨勢序列跨 superseded 斷開
  （R8.EB4）；POST/PUT/DELETE → 405（R8.EB3）。
  _Requirements: R8.4.1, R8.4.2, R8.4.3_
  → `src/server.js` 新增唯讀 `GET /api/upgrades`（`listUpgrades`）、`?trend=1`（`upgradeTrend`+`computeTrend`
    cohort 分組 + lineage 分段斷線 + case-id 交集配對）、`/api/upgrades/<compare-id>`（`sendUpgradeReport`
    全 report.json + report.html 路徑註記）。非 GET → 405 由既有全域守則（`server.js:25`）處理。測試落新建
    `test/upgrade-server.test.js`（非 server.test.js，避免與 u7 並行改動衝突）6 案：列摘要 newest-first、
    詳情 + html 註記、非 GET 405、`?trend=1` 交集 + superseded 斷段、空目錄空集、corrupt 略過不 500。

## 交叉一致性註記
- dashboard 核心保持零 ECharts（重圖只在 [U7] 單檔 HTML）；upgrade 檢視唯讀、治理中立（無自動採用入口）。
- 純邏輯落 `web/obs.js` 沿用 [[aiide-web-obs-testable-module]] 範式（單檔 dashboard 抽可測邏輯 + window shim）。
- [TL-M1] 唯讀 GET `/api/upgrades` 不違反「server 只讀」鐵律（無寫入端點）；資料源 = [U7] `upgrades/` 落點。

## Rollup（完成證據，2026-07-10）
- **U7↔U8 介面**：本 spec 定義並在 `docs/aiide-skill.md` 記錄 canonical report.json（verdict-first）schema
  作為與 [U7] 的介面契約。U7 尚未落地（`test/report.test.js`/`src/report.js` 未存在），故 U8 全程以
  `test/upgrade-server.test.js` 內的 fixture 造 report.json 開發，未依賴 U7 代碼、未碰 u7-impl 檔案集
  （`bin/aiide.js`/`src/report.js`/`web/vendor`）。若 U7 產出欄位有出入即為小裁決，屆時對齊。
- **裁決（小）**：R8.4 只列 `/api/upgrades`(+`?trend=1`)，但 T8.3「選定 compare-id 讀 report.json」需下鑽端點；
  新增唯讀 `GET /api/upgrades/<compare-id>`（沿 `/api/runs/<id>` 既有範式，仍純 GET，不違只讀鐵律）。
- **AC↔證據**
  - R8.1（AX 章節）：`docs/aiide-skill.md` §AX——含五 verdict 值說明、「adoption is always a human decision」句、
    引用 `docs/onchainos-upgrade-pipeline-design.md` §1/§2.2/§3/§5 + Wave 0 探針附件。✔ T8.1 內聯檢查
  - R8.2.1/R8.2.3（檢視 + 下一步指引）：`buildUpgradeView`/`upgradeNextSteps` + 6 obs 測試綠；瀏覽器 e2e
    insufficient-data → 「還需 2 條配对」/「不可采用」、inconclusive → 被排除 c9(harness-halt→補 scripted_reply)/
    c4(env-noise→检查白名单）。✔ R8.EB1
  - R8.2.2（零 ECharts）：`grep -i echarts web/index.html` 僅文案/註解 4 處；瀏覽器頁面 `echarts.init|min|script`
    命中 0。✔ R8.EB2
  - R8.4.1/R8.4.2/R8.4.3（唯讀端點 + trend + 只讀）：`test/upgrade-server.test.js` 6 案全綠；瀏覽器 trend
    渲染 2 段獨立 SVG（L1 四點 c1/c2 交集、L2 superseded 單點斷開）。✔ R8.EB3/R8.EB4
- **測試數字**：`node --test test/upgrade-server.test.js test/web-obs.test.js` = 25/25 綠（6 server + 6 U8 obs
  + 13 既有 obs）。全套 `node --test` = **257/257 綠、0 fail**（含既有 245 + 新 12）。
- **端到端瀏覽器驗證**（agent-browser，非 textContent 假陽性）：`aiide up` server + 5 份 fixture report.json，
  實載 `#upgrades`/`#upgrade/<id>`(adopt/insuf/inconc)/`#upgrade-trend`，可見文字斷言四態徽章 ✓∅~、下一步指引、
  被排除 case 表、三軸 mini-delta SVG、關注名單、版本四元組、開啟完整報告入口；EN/简中雙語切換皆正確。
