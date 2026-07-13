# U5 · upgrade-u5-depgraph-engine — Requirements (EARS)

> Design authority: `docs/onchainos-upgrade-pipeline-design.md` §2.3 (依賴圖分析/拆合決策引擎)、
> §5 spec 表 U5、§7 明確不做（語義判拆合）。
> Depends on: [U2] (逐 session `triggerSet`/`readSet`/`category` 原始事件，readSet 已 **[TL-M3]** _shared
> 歸一)、[U1] (`category`/full 層級)、[U0] (CANONICAL CONFIG `depgraph` 段：所有閾值。[裁決 TL-B1] config
> 前移 U0)。
> Consumed by: [U7] (共觸發 graph / 共讀 heatmap / sankey / 盈虧平衡表 / 拆合建議卡)。

## Constraints (鐵律)
- **零依賴零建置**：Jaccard/連通分量/盈虧平衡全零依賴。
- **experiment 不可變**：只讀採集事件，產建議物件；不回寫。
- **server read-only except annotations sidecar（既有 PUT /annotations）**：不新增 server 寫入。
- **治理中立**：只出**拆/合候選 + 證據**，SHALL NOT 自動 merge/split skill（merge-map 僅為候選）。

## Glossary
- **讀取率**：`P(ref 被讀 | 該 ref 所屬 skill 觸發)`。
- **共讀率**：一對 reference 在同 session 被同時讀的比率。
- **共觸發率**：一對 skill 在同 session 共觸發的比率。
- **Jaccard（拆分訊號）**：按 case category 分組 session 的讀取集合，組間平均 pairwise Jaccard。

## Requirements

R5.1 — 讀取率（內聯/外移/灰區，§2.3）
- R5.1.1 THE 系統 SHALL 對每個 reference 算讀取率；WHEN ≥ `inlineReadRate`（0.60）→ 建議「內聯」；
  ≤ `externalReadRate`（0.20）→ 建議「保持外移」；介於兩者 → 建議「灰區段級拆」。閾值取自 [U0] CONFIG。
- R5.1.2 THE 每條建議 SHALL 帶 `n`（有效 session 數，延續 null-not-zero 紀律）。

R5.2 — 共讀（合併檔案，§2.3）
- R5.2.1 WHEN 一對 reference 的共讀率 ≥ `coReadMerge`（0.80），系統 SHALL 出「合併檔案」候選，帶 n 與證據
  session。
- R5.2.2（**[TL-M3] _shared 歸一後計算**）THE 共讀率計算 SHALL 消費 [U2] R2.4.1a 歸一後的邏輯 ref；跨 skill
  的 `_shared` 同內容副本 SHALL 被視為同一 ref，其共讀率 SHALL NOT 因每 skill 各持一份而被稀釋。

R5.3 — 共觸發（合併候選 + merge-map，§2.3）
- R5.3.1 THE 系統 SHALL 算 skill 對共觸發率，並以 `coTriggerGraph` 閾值建圖（節點=觸發率、邊=共觸發率）。
- R5.3.2 THE 自動 merge-map 候選 SHALL 取共觸發圖的**連通分量** + 盈虧平衡過濾（R5.5）。
- R5.3.3（硬排除）安全/冷觸發 skill SHALL 由 CONFIG `hardExcludeSkills` 硬排除於任何 merge 候選之外
  （對齊 onchainos ROUTE-04 紅線）；被排除的 skill 即使高共觸發也 SHALL NOT 出現在 merge-map。

R5.4 — Jaccard 拆分（**統計守門**，§2.3）
- R5.4.1 WHEN 一個 skill 的組間平均 pairwise Jaccard < `jaccardSplit`（0.30），系統 SHALL 出「拆分候選」+
  建議切分（各 category 專屬讀取集）。
- R5.4.2（守門）THE Jaccard 拆分訊號 SHALL 只在滿足 **≥ `minCategories`（2）個 category 且每 category
  ≥ `minSessionsPerCategory`（5）個有效 session** 時產出；否則 SHALL = `insufficient-data`（帶 n）。
- R5.4.3（限 full 集）THE Jaccard 拆分 SHALL **只在 full 集**上跑；smoke 集 SHALL 只出共觸發率與讀取率
  （不出拆分/合併決策）。
- R5.4.4（反例）WHEN category 數 = 1（單一 category）→ Jaccard 無定義 → `insufficient-data`，SHALL NOT
  誤出拆分建議。

R5.5 — 盈虧平衡（合併後正文膨脹上限，§2.3）
- R5.5.1 THE 常駐節省 SHALL = `(Σ成員desc − 估計合併desc) / breakEvenDivisor`（4）；÷ `P(組觸發)` 得合併後
  正文可膨脹上限。閾值/除數取自 CONFIG。
- R5.5.2 THE 盈虧平衡 SHALL 留生產遙測觸發率代入接口（公式參數化 `P(組觸發)`，本輪用實驗分布）。

R5.6 — 誠實標注（§2.3）
- R5.6.1 THE 報告物件 SHALL 固定帶警語：「實驗分布 ≠ 生產分布」；每個統計 SHALL 帶 n。
- R5.6.2 THE 所有拆/合建議 SHALL 為候選（治理中立），SHALL NOT 標為「已採用」或自動執行。

## 反例／邊界 AC
- R5.EB1 某 skill 只有 1 個 category → Jaccard insufficient-data（R5.4.4）。
- R5.EB2 某 category 只有 4 個有效 session（< 5）→ 該 skill Jaccard insufficient-data（R5.4.2）。
- R5.EB3 smoke 集請求拆分 → 只回讀取率/共觸發、不回拆分建議（R5.4.3）。
- R5.EB4 高共觸發的安全 skill（在 hardExcludeSkills）→ 不進 merge-map（R5.3.3）。
- R5.EB5 讀取率恰 0.60 → 內聯（`≥`）；恰 0.20 → 保持外移（`≤`）；0.20-0.60 開區間 → 灰區。
- R5.EB6（[TL-M3]）兩 skill 各持同內容 `_shared/util.md`、10 session 中 8 個同讀 → 歸一為單一 ref、共讀率
  0.80 觸發合併候選（不因副本分裂稀釋成 0.40）。

## 非目標
- ❌ 不用語義相似度判拆合（維持確定性訊號：Jaccard/共讀率/盈虧平衡，§7）。
- ❌ 不接生產遙測（留公式接口，onchainos repo 側工作）。
