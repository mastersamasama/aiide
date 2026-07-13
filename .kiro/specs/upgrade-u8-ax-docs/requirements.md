# U8 · upgrade-u8-ax-docs — Requirements (EARS)

> Design authority: `docs/onchainos-upgrade-pipeline-design.md` §3 (AI 受眾 AX)、§5 spec 表 U8。
> Depends on: [U7] (report.json/md schema、`upgrades/<compare-id>/` 落點、`aiide upgrade` CLI 契約)、
> [U4] (verdict 語意)。

## Constraints (鐵律)
- **零依賴零建置**：文檔與 dashboard 檢視沿用既有零依賴 web（`web/obs.js` 純邏輯 + 單檔 dashboard）。
- **experiment 不可變**：dashboard 只讀 experiment/report；不回寫。
- **server read-only except annotations sidecar（既有 PUT /annotations）**：本 spec **僅新增唯讀 GET
  `/api/upgrades`（+`?trend=1`）**（[裁決 TL-M1]：唯讀 GET 不違反只讀鐵律），SHALL NOT 新增任何寫入端點。
- **治理中立**：文檔明述「採用為人類決策」；dashboard 不提供任何自動採用/改寫入口。

## Requirements

R8.1 — `aiide-skill.md` AX 章節增補（§3）
- R8.1.1 THE `aiide-skill.md` SHALL 增補 AX 章節，說明 `aiide upgrade run/compare/report` 契約、report.json
  verdict-first schema 的頂層鍵、report.md 編號標題 grep 慣例。
- R8.1.2 THE AX 章節 SHALL 說明 verdict 語意（cost-opt/quality-fix/neutral-refactor/insufficient-data/
  inconclusive）與其對 AI 消費者的判讀規則（尤其 insufficient-data/inconclusive 不可當「持平/可採」）。
- R8.1.3 THE AX 章節 SHALL 明述治理中立：per-skill 診斷表非採用證書、採用為人類決策。

R8.2 — dashboard upgrade 檢視（§3）
- R8.2.1 THE dashboard SHALL 新增唯讀 upgrade 檢視，呈現 verdict banner + 三軸/三層卡 + 版本四元組
  （複用既有唯讀渲染，可測純邏輯落 `web/obs.js`，沿用 Track B 範式 [[aiide-web-obs-testable-module]]）。
- R8.2.2 THE 檢視 SHALL NOT inline ECharts（重圖走 [U7] 單檔 HTML 報告；dashboard 保持零 ECharts 核心）。
- R8.2.3 WHEN verdict = insufficient-data/inconclusive，檢視 SHALL 明顯呈現該狀態與原因，並 SHALL **同步
  [U7] R7.4.3 的下一步指引**（還需 N 條配對 / 被排除 case-id + 原因 + 建議動作 / 補到 MIN_PAIRS_SKILL）。

R8.4 — 唯讀 GET /api/upgrades（**[TL-M1]**）
- R8.4.1 THE server SHALL 新增**唯讀** GET `/api/upgrades`：列 `<dataDir>/upgrades/` 下各 `<compare-id>` 的
  report.json 摘要（verdict + 兩臂 label + 時間戳）供 dashboard 檢視載入。
- R8.4.2 WHEN 帶 `?trend=1`，GET `/api/upgrades` SHALL 回同 model cohort、case-id 交集配對的**趨勢序列**
  （對齊 ixd P03 趨勢線；superseded 譜系自動斷開，[U1] R1.3.4）。
- R8.4.3 THE 端點 SHALL 為純 GET 唯讀，SHALL NOT 提供任何寫入/採用/刪除操作。

R8.3 — 文檔一致性
- R8.3.1 THE 文檔 SHALL 引用權威設計 `docs/onchainos-upgrade-pipeline-design.md`（不重述演算法細節，避免漂移）。
- R8.3.2 THE 文檔 SHALL 標注 Wave 0 探針報告為 U0/U2/U3 事實依據附件。

## 反例／邊界 AC
- R8.EB1 upgrade 檢視載入 insufficient-data 報告 → banner 明示不足 + 印「還需 N 條配對」，不呈現可採（R8.2.3）。
- R8.EB2 dashboard 核心掃描 → 零 ECharts import（R8.2.2）。
- R8.EB3 GET `/api/upgrades` 非 GET 方法（POST/PUT/DELETE）→ 405（沿用 server.js:24 只讀守則，R8.4.3）。
- R8.EB4 `?trend=1` 跨 superseded 譜系 → 趨勢線斷開不接續（R8.4.2）。

## 非目標
- ❌ dashboard 不提供自動採用/改寫 skill 入口（治理中立）。
- ❌ 不在 dashboard 重繪 [U7] 的完整 ECharts 圖組（重圖只在單檔 HTML 報告）。
