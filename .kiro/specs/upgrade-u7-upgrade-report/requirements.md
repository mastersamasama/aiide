# U7 · upgrade-u7-upgrade-report — Requirements (EARS)

> Design authority: `docs/onchainos-upgrade-pipeline-design.md` §1 (階段 4 判定+報告)、§3 (報告設計/雙受眾
> 同構)、§5 spec 表 U7；視覺與互動細節見 `docs/ixd/`。
> Depends on: [U4] (verdict 物件 + 版本四元組 + 檢定揭露 + regressed 聚類)、[U5] (依賴圖建議)、[U6] (靜態
> 預檢結果)、[U0] (預算預估 + CANONICAL CONFIG + 混合 bundle 採集後端 R0.2b)。

## Constraints (鐵律)
- **零依賴零建置**：CLI 與 report.js 零依賴；**ECharts 完整版僅 vendored 進報告產物**（pin 版本 + sha256 +
  NOTICE inline），SHALL NOT 進 aiide dashboard 核心、SHALL NOT 成為 npm 依賴。
- **experiment 不可變**：報告只讀 experiment/verdict，產 report.json/md/html（**寫後不可變**，見 R7.6）；不回寫。
- **server read-only except annotations sidecar（既有 PUT /annotations）**：報告為 CLI 產物；[U8] 另新增
  **唯讀** GET `/api/upgrades` 供 dashboard 讀（[裁決 TL-M1]，不違反只讀鐵律）。
- **治理中立**：報告只給 verdict 與證據，**採用永遠是人類決策**；SHALL NOT 標「已採用」。

## Requirements

R7.1 — `aiide upgrade` CLI（run / compare / report / smoke --mix）
- R7.1.1 THE CLI SHALL 提供 `aiide upgrade run`（採集）、`compare`（兩臂聚合+verdict）、`report`（產出）
  子命令；`report --format json|md` 選格式。
- R7.1.2 WHEN 啟動 run/compare，CLI SHALL 先印 [U0] 預算預估表（session 數 × 時長 × USD）。
- R7.1.3（**[PM-B1] 混採閉環 + [PM-N1] 對照臂**）THE CLI SHALL 提供
  `aiide upgrade smoke --mix skillA=new,skillB=old`：以 [U0] R0.2b 混合 profile 採集、走 [U4] 同一 verdict
  引擎產 bundle 級 **mini-verdict**；報告 header SHALL 標 `mixed-bundle` + 完整 mix 映射（對齊 ixd P01
  mixed-bundle 變體）。
- R7.1.3a（**[PM-N1] 對照臂定義**）THE mini-verdict SHALL 為**配對檢定**：混合臂 vs **基線臂**。THE 基線臂
  預設 = **現行生產 old-full**（語意：「混採相對今天在跑的非劣即可採」）；THE CLI SHALL 提供 `--baseline new|old`
  切換基線臂；報告 header SHALL **記錄對照臂身份**（label + cliVersion + 是否 full）。

R7.2 — report.json（verdict-first schema）
- R7.2.1 THE report.json schema **第一層即 verdict**（鏡像資訊三層同構）；下鑽依序 verdict → 三軸+三層質量
  卡（含 CI 與 n）→ 逐 case/逐圖證據。
- R7.2.2 THE schema SHALL 含：全域 verdict + intent、per-skill 診斷表（帶「非採用證書」標記）、三軸 delta +
  bootstrap CI、L1/L2/L3 通過率（permission-artifact 與 flow-incomplete 單獨列）、依賴圖建議、版本四元組、
  檢定總數與策略揭露、排除率。

R7.3 — report.md（編號標題可 grep）
- R7.3.1 THE report.md SHALL 用編號標題（`## N.`）使 AI 可 grep 截取章節；章節順序鏡像 report.json 層級。
- R7.3.2 THE verdict SHALL 為第一章（verdict-first）。

R7.4 — 單檔 HTML（ECharts inline，離線可攜）
- R7.4.1 THE HTML SHALL 為**單檔**、離線可攜（~1.2MB），ECharts 完整 dist **inline vendored**；vendor 檔
  SHALL pin 版本 + 附 sha256 + NOTICE（授權）inline。
- R7.4.2 THE HTML SHALL 呈現：verdict banner（intent 徽章）、per-skill 診斷表、三軸 delta 卡（bootstrap
  CI）、L1/L2/L3 質量表（permission-artifact 與 flow-incomplete 單獨列）、共觸發 graph（節點=觸發率、
  邊寬=共觸發率、紅=合併候選）、共讀 heatmap、intent→skill→reference sankey、盈虧平衡表、拆/合建議卡
  （展開證據 session + n）、footer（版本四元組 + 檢定揭露 + ECharts 版本/NOTICE）。
- R7.4.3（治理呈現 + **[PM-B2] 可行動下一步**）THE per-skill 診斷表 SHALL 明標「非獨立採用證書」；
  WHEN verdict = inconclusive/insufficient-data，banner SHALL 明顯呈現該狀態與原因，並 SHALL 附**下一步指引**：
  - `insufficient-data`（配對不足）→ SHALL 印「還需 N 條配對」（N = `MIN_PAIRS` − 現有配對數）。
  - `inconclusive`（排除率絆線）→ SHALL 列**被排除的 case-id + 各自原因**（env-noise / harness-halt）+ 建議
    動作（如「補 scripted_reply」）。
  - per-skill「僅供參考」（5-7 cluster）→ SHALL 印「補到 `MIN_PAIRS_SKILL` 條可脫離僅供參考」。
- R7.4.4（heuristic 標注）WHEN L3 判定走啟發式（[U3] R3.3.3 無 sentinel），報告 SHALL 明標 `heuristic`。

R7.5 — vendor 完整性
- R7.5.1 WHEN 建置報告，系統 SHALL 校驗 vendored ECharts 檔的 sha256 == pin 值；不符 SHALL 報錯不產 HTML。
- R7.5.2 THE vendor 檔 SHALL 只存於 `aiide/web/vendor/`，SHALL NOT 被 aiide dashboard 核心 import。

R7.6 — 報告產物落點（**[TL-M1]**）
- R7.6.1 THE 三份產物 SHALL 落於 `<dataDir>/upgrades/<compare-id>/`：`report.json` + `report.md` +
  `report.html`；`<compare-id>` SHALL 為穩定可讀識別（含兩臂 label + 時間戳）。
- R7.6.2 THE 產物 SHALL **寫後不可變**（沿用 experiment 不可變紀律）；重跑產新 `<compare-id>` 目錄，不覆蓋舊者。
- R7.6.3 THE `upgrades/` 目錄 SHALL 為 [U8] 唯讀 GET `/api/upgrades`（+`?trend=1`）的資料源。

R7.7 — 跑後自動化（**[PM-B3]**，§2.4 跑後）
- R7.7.1（regressed case 卡）FOR 每個 regressed case，報告 SHALL **並排呈現兩臂**：L1 觸發集、L2 verifier
  結果、L3 終態、read-set diff（哪些 ref 新臂多讀/少讀）。
- R7.7.2（報告 diff）WHEN 存在上一次同譜系 report.json，報告 SHALL 產**結構化對比節**（本次 vs 上次：verdict
  變化、各軸 delta 變化、新增/消失的 regressed case）。
- R7.7.3（regressed 聚類）THE regressed case SHALL 聚類到 `skill × category`（聚類計算由 [U4] 提供介面、本
  spec 呈現）；卡片按聚類分組。

R7.8 — 盈虧平衡表列代入值（**[PM-B4]**）
- R7.8.1 THE 盈虧平衡表每列 SHALL 列出代入值：`Σ成員desc`、`估計合併desc`、`P(組觸發)`、算出的膨脹上限
  （不只給結論數，供審計重算）。

## 反例／邊界 AC
- R7.EB1 verdict = insufficient-data → HTML banner 明示配對不足，不呈現「可採用」字樣（R7.4.3）。
- R7.EB2 vendored ECharts sha256 不符 pin → 報錯、不產 HTML（R7.5.1）。
- R7.EB3 report.md grep `## ` → 章節可截取、verdict 為第一章（R7.3）。
- R7.EB4 L3 無 sentinel → 報告標 heuristic（R7.4.4）。
- R7.EB5（[PM-B2]）配對 7、MIN_PAIRS 8 → banner 印「還需 1 條配對」；inconclusive → 列被排除 case-id + 原因
  + 建議動作（R7.4.3）。
- R7.EB6（[TL-M1]）重跑 → 產新 `<compare-id>` 目錄，舊產物不被覆蓋（R7.6.2）。
- R7.EB7（[PM-B3]）無上一次 report.json → 報告 diff 節優雅缺省（不報錯，標「無基準」）（R7.7.2）。

## 非目標
- ❌ ECharts 進 aiide dashboard 核心（僅報告產物 vendored，§7）。
- ❌ 報告不依賴 `~/.onchainos/audit.jsonl`（§7 風險）。
