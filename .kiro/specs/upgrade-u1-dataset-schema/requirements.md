# U1 · upgrade-u1-dataset-schema — Requirements (EARS)

> Design authority: `docs/onchainos-upgrade-pipeline-design.md` §1 (階段 1 資料集)、§2.2 (配對與譜系)、
> §5 spec 表 U1。
> Depends on: [U0] (`MIN_PAIRS_SKILL`/`dataset.*` 值取自 CANONICAL CONFIG `upgradeConfig.js`；本 spec 引用
> 不定義。[裁決 TL-B1]：config 前移至 U0)。
> Consumed by: [U0] (case sha 進 resumeKey)、[U3] (`must_confirm_before`/`safety_negative`/`allowed_auxiliary`
> 驅動 L1/L3)、[U4] (配對鍵 = case-id 交集)、[U5] (`category` 驅動 Jaccard 拆分)。

## Constraints (鐵律)
- **零依賴零建置**：case schema 校驗與 sha256 只用 node builtins（`node:crypto`）。
- **experiment 不可變**：資料集為輸入不是 experiment；但**只增不改**紀律等價守護（見 R1.3）。
- **server read-only except annotations sidecar（既有 PUT /annotations）**：本 spec 不新增 server 寫入。
- **治理中立**：lint 只讀 suite/case 檔並報錯，永不自動改寫用例。

## Glossary
- **case**：一條用例，schema 見 R1.1。
- **canonical-JSON**：鍵排序、無多餘空白的確定性序列化，供 per-case sha256 用。
- **lineage（譜系）**：資料集版本間的父子關係；新版必為舊版超集（case-id 只增不改）。
- **superseded_by**：修 case 的唯一合法路徑——棄舊 id、發新 id，舊 case 標 `superseded_by:<新id>`。

## Requirements

R1.1 — Case schema
- R1.1.1 每個 case SHALL 具備欄位：`id`（穩定字串）、`prompt`、`expected_skill`、`allowed_auxiliary[]`
  （合法連帶觸發的 skill 名清單）、`category`、`multi_intent[]`、`assertions[]`、`safety_negative`
  （布林，安全反例）、`added_in`（首次引入的資料集版本）。
- R1.1.2 THE schema SHALL 支援 `must_confirm_before`（斷言：呼叫危險工具前必須先有確認回合，[U3] L3 消費）
  與 `scripted_reply`（[U0] R0.4 續跑用）；帶 `must_confirm_before` 者 SHALL 強制配 `scripted_reply`
  （否則 lint 報錯——堵 asked-and-halted 無腳本流失）。
- R1.1.2a（**[TL-B2] must_confirm_before 結構明定**）THE `must_confirm_before` SHALL 為結構
  `{tools:[string], pathPattern?:string, note?:string}`：`tools[]` 列哪些 tool_use 名（如 `Write`/`Bash`）
  算危險操作、可選 `pathPattern` 限定路徑樣式、可選 `note` 說明。[U3] 的 executed-without-ask 判定與
  confirmTurn「無完成副作用」判定 SHALL **共用同一定義**（危險操作 = 命中 `tools[]`（且若有 pathPattern 則
  路徑亦命中）的成功 tool_use）。
- R1.1.3 THE schema SHALL 支援 `held_out`（布林）；`held_out:true` 的 case SHALL 標記為不參與 skill 迭代期
  回饋（goodharting 防護，治理紅線）。
- R1.1.4 IF case 缺任一必填欄位 OR 型別不符，`loadSuite` SHALL 報明確錯誤（欄位名 + case id）並不啟動任何跑。

R1.2 — Per-case canonical sha256（§2.2 譜系 lint 基礎）
- R1.2.1 系統 SHALL 為每個 case 計算 `caseSha256` = sha256(canonical-JSON(**whitelist 欄位**))。THE whitelist
  SHALL 為**逐欄位窮舉分類**（[TL-M4] 裁決，每個 schema 欄位標 include|exclude；新增欄位必須顯式分類）：

  | 欄位 | 分類 | 理由 |
  |---|---|---|
  | `prompt` | **include** | 判分語義（改字即改題） |
  | `expected_skill` | **include** | L1 路由判準 |
  | `allowed_auxiliary` | **include** | L1 false_positive 判準 |
  | `assertions` | **include** | L2 verifier 判準 |
  | `multi_intent` | **include** | 判分語義 |
  | `safety_negative` | **include** | L3 安全判準 |
  | `must_confirm_before` | **include** | L3 危險操作定義（[TL-B2]） |
  | `scripted_reply` | **include** | 續跑流內容影響三軸 |
  | `category` | **include** | 驅動 [U5] Jaccard 分組 / [U4] regressed 聚類 / [U2] 逐 session 事件——改了必須斷譜系 |
  | `id` | **exclude** | 身份鍵本身（非內容；改 id = 發新 case） |
  | `added_in` / `superseded_by` | **exclude** | 譜系元資料（標譜系不得改 sha） |
  | `held_out` | **exclude** | 純治理旗標；移進移出 held-out 是合法操作，不逼發新 id |
  | `note` / `tags` | **exclude** | display-only |

- R1.2.2 THE include|exclude 分類 SHALL 由 whitelist 常數集中定義；WHEN schema 新增欄位而未分類，lint
  SHALL 報錯（強制作者顯式決定，杜絕漏判分欄位穿透）。

R1.3 — 版本譜系超集 lint（§2.2，N5 prompt 改字穿透守門）
- R1.3.1 WHEN 資料集自宣告為某舊版的新版，lint SHALL 斷言新版 case-id 集合 ⊇ 舊版 case-id 集合（超集）。
- R1.3.2 IF 某 case-id 在兩版皆存在但 `caseSha256` 不同（prompt/內容被改），lint SHALL 報錯
  `case <id> content changed (<oldSha8>→<newSha8>) — 修 case 唯一合法路徑是 superseded_by`，並不通過。
- R1.3.3 THE 唯一合法修改路徑 SHALL 為：舊 case 標 `superseded_by:<newId>`（自身內容不動、sha 不變）、
  新增一條新 id 的 case。此時 lint SHALL 通過。
- R1.3.4（反例／趨勢斷開）WHEN 趨勢線消費譜系（[U4]/[U7]），被 `superseded_by` 的 case 譜系 SHALL 自動斷開
  （新舊 id 不接續為同一趨勢點）。

R1.4 — Case-id 穩定性
- R1.4.1 THE case-id SHALL 為跨版本穩定鍵；[U4] 配對鍵 = 兩臂/兩版 case-id **交集**，不要求 dataset sha 全等。
- R1.4.2 IF 兩個 case 共用同一 id，lint SHALL 報重複並拒絕。

R1.5 — 兩層 + held-out 子集
- R1.5.1 THE 資料集 SHALL 分兩層：`smoke`（20-30 case）與 `full`（≥130 case）；case 可標所屬層級。
- R1.5.2 THE held-out 子集 SHALL 可由 `held_out:true` 篩出，且[U5] Jaccard 拆分等 full-only 分析 SHALL 只在
  full 集上跑（本 spec 提供層級標記，[U5] 消費）。

R1.6 — Per-skill 覆蓋 lint（§2.2 N2 對應）
- R1.6.1 FOR 每個「可獨立關注」的 skill（出現在任一 case 的 `expected_skill`），lint SHALL 檢查其對應
  case 數 ≥ `MIN_PAIRS_SKILL`（值取自 [U0] CONFIG，首版 5）；不足者 SHALL 出 `insufficient-coverage`
  警告（非硬錯——[U4] per-skill 診斷會標 insufficient-data 徽章）。
- R1.6.2（**[PM-B6]** 可行動警告）THE `insufficient-coverage` 警告 SHALL 帶
  `{skill, currentN, target:MIN_PAIRS_SKILL, needMore: target−currentN}`（skill/現有 N/目標/還需幾條）。

R1.7 — 多意圖覆蓋 lint（**[PM-B5]**）
- R1.7.1 WHEN 資料集中帶非空 `multi_intent[]` 的 case 佔比 < `dataset.minMultiIntentPct`（[U0] CONFIG，
  首版 0.15），lint SHALL 出 `insufficient-multi-intent-coverage` 警告（帶現佔比 + 門檻）。

R1.8 — smoke tier size lint（**[PM-B7]**）
- R1.8.1 WHEN smoke 層 case 數落在 `[dataset.smokeTierMin, dataset.smokeTierMax]`（[U0] CONFIG，20-30）
  之外，lint SHALL 出警告（帶實際數 + 區間）。
- R1.8.2 THE 交付 SHALL 含一份**帶註解的 case 模板檔**（示範全欄位含 `must_confirm_before` 結構/
  `multi_intent`/`safety_negative`/`allowed_auxiliary`），供作者複製。

## 反例／邊界 AC
- R1.EB1 空 `allowed_auxiliary[]` 合法（無合法連帶）；`allowed_auxiliary` 含 `expected_skill` 自身 → lint 警告
  （冗餘）。
- R1.EB2 `superseded_by` 指向不存在的 id → lint 報錯（懸空譜系）。
- R1.EB3 新版**移除**了舊版某 case-id（非超集）→ R1.3.1 報錯（只增不改）。
- R1.EB4（[TL-M4]）改 `category` → caseSha256 變（須斷譜系）；移進移出 `held_out` → sha 不變（合法治理操作）。
- R1.EB5（[TL-M4]）schema 新增未分類欄位 → R1.2.2 lint 報錯（強制顯式 include|exclude）。

## 非目標
- ❌ 不做語義相似度判重（用例去重靠 id + sha，確定性）。
- ❌ 不在本 spec 定義任何統計閾值（`MIN_PAIRS_SKILL`/`dataset.*` 等一律引用 [U0] config `src/upgradeConfig.js`）。
