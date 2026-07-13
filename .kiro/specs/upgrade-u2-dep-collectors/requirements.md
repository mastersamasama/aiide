# U2 · upgrade-u2-dep-collectors — Requirements (EARS)

> Design authority: `docs/onchainos-upgrade-pipeline-design.md` §1 (階段 2 採集)、§2.3 (依賴圖資料)、
> §5 spec 表 U2。
> Evidence base: `docs/wave0-probe-report.md` P1 (觸發/body/Read 歸因形態)、P4 (permission-denied 形態)、
> §「對 U0/U2/U3 的裁決」1/5。**本 spec 的 requirements 以探針實測為依據。**
> Consumed by: [U3] (L1 用 primary/auxiliary 觸發集 + permission-artifact)、[U5] (共讀/共觸發原始事件)。
> Depends on: [U1] (`allowed_auxiliary` 判 auxiliary 合法性)。

## Constraints (鐵律)
- **零依賴零建置**：只用 node builtins 解析 session JSONL。
- **experiment 不可變**：採集只讀 JSONL、產衍生事件；不回寫 session 檔。
- **server read-only except annotations sidecar（既有 PUT /annotations）**：不新增 server 寫入。
- **治理中立**：只讀 transcript，不改 skill。

## Glossary
- **primary trigger**：一個 session 內**首個** `Skill` tool_use 的 `input.skill`（P1 line 8）。
- **auxiliary trigger**：primary 之後的其他 `Skill` 觸發；在 case `allowed_auxiliary[]` 內者為合法連帶。
- **ref-read attribution**：一個 `Read` 屬於某 skill，判據 = `input.file_path` 前綴命中
  `<profile>/skills/<name>/`（P1 line 12/13）。

## Requirements

R2.1 — 觸發集合偵測（P1 實測依據）
- R2.1.1 THE skill 名 SHALL 取自 `Skill` tool_use 的 `input.skill` 欄位（P1：`parser.js:123`
  `block.name==='Skill' ? input.skill : null` 假設經實測確認一致）；`input.args` 為模型自填意圖，記錄但不作
  歸因鍵。
- R2.1.2 系統 SHALL 對每 session 產出 `{primarySkill, auxiliarySkills[]}`：primary = 首個 Skill 觸發；
  auxiliary = 其餘 Skill 觸發（去重）。
- R2.1.3（**主歸因裁決**，探針§裁決 1）THE 主歸因源 SHALL 為 `Skill` tool_use 的 `input.skill`（觸發事實）
  **加** Read/Write `input.file_path` 命中 `skills/<name>/` 前綴；`attributionSkill` **只作 optional 增強
  訊號**，SHALL NOT 作唯一歸因源。
- R2.1.4（**增強訊號邊界**）THE `attributionSkill` SHALL 僅覆蓋「skill 啟動後、同一 headless invocation 內、
  skill 活躍期生成的 assistant 回合」；系統 SHALL NOT 依賴它覆蓋觸發回合（P1：觸發回合不帶）與跨 resume
  邊界的後續動作（P2：resume 後 Write 漏歸因）。缺歸因時 SHALL 退回 R2.1.3 的主歸因源。

R2.2 — ref 讀取歸因（P1 line 12/13 依據）
- R2.2.1 系統 SHALL 判定一個 `Read` 屬於某 skill，當且僅當其 `input.file_path` 絕對路徑前綴命中
  `<profile>/skills/<name>/`（含 `references/`）；此為主判據。
- R2.2.2 THE 同行若帶 `attributionSkill` SHALL 作雙重佐證（增強），但缺此欄位不影響 R2.2.1 判定。
- R2.2.3 成功 Read 的 tool_result `is_error` 欄位**不存在**（P1 line 13）；系統據此判讀取成功。

R2.3 — skill body context 成本準確化（**修 `lab.js:754` bug**，P1 §事實 3 依據）
- R2.3.1 系統 SHALL 從**帶 `isMeta:true` 且 `sourceToolUseID` 回指該 Skill tool_use 的 user 文字行**抓取
  skill body（P1：SKILL.md 正文走此行，1457 字元），SHALL NOT 只計 Skill tool_use 的 `tool_result`
  長度（P1：該 result 僅 28 字元 `Launching skill: <name>`，**嚴重低估**）。
- R2.3.1a（**[TL-m4] 掛回機制**）THE parser SHALL 先在 ingest user 行時**捕捉** `isMeta` 與
  `sourceToolUseID`（`parser.js` 現行丟棄這兩欄位），再用既有 `toolCallIndex`（`parser.js:27`，tool_use id →
  toolCall 物件）以 `toolCallIndex.get(sourceToolUseID)` 把該 isMeta body 文字行掛回對應的 `Skill` tool_use。
- R2.3.2 THE `skillBodyCostEst`（`lab.js:754-756` 現行實作）SHALL 改為以 R2.3.1a 掛回的 isMeta 行文字長度
  估算 body context 成本；估算單位沿用「字元/4」。
- R2.3.3（反例）IF 一個 Skill 觸發後找不到對應 `sourceToolUseID` 的 isMeta 行，body 成本 SHALL 記 null
  （不可用 28 字元 launch 訊息冒充）。

R2.4 — 共讀 / 共觸發原始事件（[U5] 消費）
- R2.4.1 系統 SHALL 對每 session 產出 `readSet`（該 session 被讀的 ref 路徑集合，歸屬到 skill/reference）
  與 `triggerSet`（該 session 觸發的 skill 集合）。
- R2.4.1a（**[TL-M3] _shared 讀取歸一**）THE 採集端 SHALL 把 `skills/<name>/_shared/<x>` 路徑以
  **「路徑後綴 + 內容 md5」歸一**為同一邏輯 ref（跨 skill 的 `_shared` 副本合併為一個節點）；`readSet` 中的
  `_shared` 條目 SHALL 以歸一後的邏輯 ref 記錄，使 [U5] 共讀率不因每 skill 各持一份副本而被稀釋。
- R2.4.2 系統 SHALL 匯出逐 session 的 `{triggerSet, readSet, category}`（category 取自 [U1] case，readSet
  含 R2.4.1a 歸一後的 ref），作為 [U5] 讀取率/共讀/共觸發/Jaccard 的原始事件；本 spec 只採集不做統計。

R2.5 — permission-artifact 標記（**P4 實測依據**，探針§裁決 5）
- R2.5.1 一個 tool_result SHALL 標記為 `permission-artifact` 當且僅當該行 `toolDenialKind` 存在
  （實測值 `"user-rejected"`）**或** `is_error===true` 且文字符合
  `/Claude requested permissions to .+ but you haven't granted it yet/`，且上游有對應的 `tool_use`。
- R2.5.2 THE `missed` SHALL 定義為：該工具**根本無任何 `tool_use` 行**（模型從未嘗試呼叫）。
- R2.5.3 THE 成功 SHALL 定義為：tool_result 無 `is_error`（或 false）且無 `toolDenialKind`。
- R2.5.4 三態（permission-artifact / missed / 成功）SHALL 純結構可分，SHALL NOT 讀模型自然語言判定
  （[U3] L1 據此把「因權限被擋」與「模型真沒做」分開計分）。

## 反例／邊界 AC
- R2.EB1（觸發回合不帶 attr）一個只含 line 7 thinking + line 8 Skill tool_use 的 requestId 無
  `attributionSkill` → 系統仍 SHALL 正確歸因（走 R2.1.3 主源），不因缺 attr 判為未觸發。
- R2.EB2（resume 後半漏歸因）resume invocation 的 Write（P2 line 19）無 attr → 系統 SHALL 用 file_path 前綴
  或觸發鏈補歸因，不判為「非 skill 驅動」。
- R2.EB3（body 缺 isMeta）Skill 觸發但無 sourceToolUseID isMeta 行 → body 成本 null（R2.3.3），不冒充。

## 非目標
- ❌ 不做多 runtime 抓包廣度（§7 明確不做）。
- ❌ 不在本 spec 做任何比率/Jaccard 統計（純採集，統計在 [U5]）。
