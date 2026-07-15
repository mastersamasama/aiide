# Wave 0 證據探針報告

**目的**：用真實 claude CLI（headless `claude -p`）跑受控 session，實測 skill 觸發／確認回合／resume／併發／permission-denied 在 session JSONL 上的機械形態，作為 onchainos skill 升級回歸管線 spec（建於 aiide 之上）U0/U2/U3 requirements 的事實依據。**只報實測事實。**

## 實測環境

- claude CLI `2.1.201 (Claude Code)`，本機已登入；隔離 profile 由 `aiide/src/lab.js` 的 `ensureProfile` 建立（獨立 `CLAUDE_CONFIG_DIR`，複製 `.credentials.json`，僅裝指定 skill）。
- 模型：`sonnet`（全部 session）。`--strict-mcp-config --mcp-config {"mcpServers":{}}`（無外部 MCP）。
- 測試 skill：`probe-skill`（SKILL.md + references/fake-coin-guide.md），description 觸發場景為「fake-coin 餘額查詢／轉帳」。
  - 路徑：`.../scratchpad/wave0/skills/probe-skill/`
- 隔離不變式（`verifyIsolation`）：全部 4 個 profile 皆 `{ ok: true, actual: ["probe-skill"], extra: [] }`。
- 總計 7 個 session：P1×1、P2×1、P2-resume×1、P3×3、P4×1。全部一次成功，無 auth/rate-limit 重試。

---

## P1 — 觸發證據形態

**問題**：skill 觸發後，session JSONL 上長什麼樣？`Skill` tool_use 的 input 形態？`attributionSkill` 真實存在嗎、在哪類行？skill body 以什麼形態進 context？Read references 的行形態？

**程序**：profile 裝 probe-skill，跑 1 session，prompt = `What is alice's fake-coin balance? Please look it up.`，allowedTools = `Read Skill`。

**JSONL 原始證據**：
`.../scratchpad/wave0/data/profiles/probe-p1/projects/C--...-workspaces-p1-balance/2da6f102-065d-45ee-8bd1-cd9911fa3595.jsonl`（17 行）

正確答案 `Alice's fake-coin balance is **1240 FAKE**.`（1240 來自 guide，非模型記憶 → 確證真實觸發＋讀取）。

### 事實發現

**1. `Skill` tool_use 形態（line 8，assistant）**
```json
{ "type":"tool_use", "name":"Skill",
  "input": { "skill":"probe-skill", "args":"Look up alice's fake-coin balance" } }
```
→ skill 名在 **`input.skill`** 欄位；另有 `input.args`（模型自填的呼叫意圖）。這與 `parser.js:124`（`block.name === 'Skill' ? block.input?.skill : null`）的假設**一致**。

**2. `attributionSkill` 確實存在，但只在特定行**
- 全 17 行中，`attributionSkill` 欄位只出現在 **2 行**：line 12、line 15，值皆 `"probe-skill"`，且**都是 `type:"assistant"` 行**。
- 關鍵：**啟動 skill 的那個 assistant 請求本身沒有 `attributionSkill`**。line 7（thinking）、line 8（`Skill` tool_use）屬 `requestId = req_011CcrWU...`，該欄位**不存在**（`"attributionSkill" in obj === false`）。被歸因的 line 12/15 屬**後續的另一個 requestId** `req_011CcrWV...`。
- 機制推斷：`attributionSkill` 標記的是「skill 已在 stack 上活躍時**生成的 assistant 回合**」，以 requestId 為界；**觸發回合（呼叫 Skill 的那一回）不被標記**，其後在 skill context 內生成的回合才被標記。

**3. skill body 如何進 context —— 不是 tool_result**
- Skill tool_use 的 tool_result（line 9，user）內容只有 28 字元：`Launching skill: probe-skill`，且 `toolUseResult = {"success":true,"commandName":"probe-skill"}`。**SKILL.md 正文不在這裡。**
- SKILL.md 正文走**另一行**（line 10，`type:"user"`）的 `text` block（1457 字元），開頭 `Base directory for this skill: <profile>/skills/probe-skill\n\n# Fake-Coin Operations ...`（完整 SKILL.md 正文）。該行帶 **`isMeta: true`** 與 **`sourceToolUseID = <Skill tool_use 的 id>`**（回指 line 8）。
- **對 spec 的直接含義（重要）**：`lab.js:754` 的 `skillBodyCostEst` 只累計 `name==='Skill'` 的 tool_use 之 `tc.result` 長度——但真實 body 不在 tool_result（僅 28 字元），在後續 `isMeta` user 行。現行估算**嚴重低估** skill body context 成本。要準確計 body 成本，須抓 `sourceToolUseID` 指回 Skill tool_use 的 `isMeta` user 文字行。

**4. Read references 的行形態（line 12，assistant，帶 attributionSkill）**
```json
{ "type":"tool_use", "name":"Read",
  "input": { "file_path": "<profile>/skills/probe-skill/references/fake-coin-guide.md" } }
```
- 對應 tool_result（line 13，user）：`is_error` 欄位**不存在**（成功），content 為 cat -n 格式檔案內容（2228 字元，開頭 `1\t# Fake-Coin Reference Guide`）。
- 「讀取歸因」的證據源：`file_path` 絕對路徑落在 `<profile>/skills/<skillName>/` 底下 → 可用「file_path 前綴命中 skill 目錄」判定該 Read 屬於某 skill。且此 Read 行本身帶 `attributionSkill:"probe-skill"`，是雙重佐證。

---

## P2 — 確認回合 ＋ resume

**問題**：轉帳請求下，「確認回合」的機械特徵？resume 可行嗎、產生新 sessionId／新檔還是 append？是否重放歷史行、uuid/requestId 是否一致（去重合併鍵）？result 的 usage/cost 累計還是增量？transfer-done.txt 是否寫出？

**程序**：跑 1 session，prompt = `Please transfer 5 fake-coin to alice.`，allowedTools = `Read Skill Write`；預期問確認後停。再用 `claude -p --resume <sid> "Yes, I confirm..."`（同 `CLAUDE_CONFIG_DIR` env、同 workspace cwd）續跑。

**JSONL 原始證據**（單一檔，resume 後 append）：
`.../scratchpad/wave0/data/profiles/probe-p2/projects/C--...-workspaces-p2-transfer/a7290040-127d-4b7c-ac88-68fbd35b48c4.jsonl`（首回合 14 行 → resume 後 24 行）

### 事實發現

**A. 確認回合的機械特徵（首回合最後 assistant，line 12）**
- 首回合 result：`Just to confirm: you'd like to transfer **5 fake-coin to alice**. Should I proceed?`（未執行任何轉帳）。
- line 12 形態：`type:"assistant"`、`stop_reason:"end_turn"`、**content 只有 `text` block（零 tool_use）**、文字含問句、`attributionSkill:"probe-skill"`。
- 觸發鏈：line 6/7（thinking＋`Skill` tool_use，`req...WcHU`，無 attr）→ line 8/9/10（launch tool_result＋skill body）→ **line 12（`req...WcUV`，text-only，有 attr，end_turn）**。即 skill 讀完指示後，同一 headless invocation 內直接產出「確認問句」並自然結束（`end_turn`），**沒有** `tool_use`、**沒有** `stop_reason:"tool_use"`。
- **「確認回合」機械定義**：一次 headless invocation 的最末 assistant 回合，`stop_reason === "end_turn"` 且該回合 `toolCalls.length === 0`（純 text），而任務語意上尚未完成（無成功副作用工具呼叫、無 transfer-done 產物）。這是「停下等待人類」與「已執行完成」的可機讀分界。

**B. resume 行為**
- `claude -p --resume <sid>` **不加 `--fork-session`**：回傳 **同一個 sessionId**（`newSessionId === resumedFrom`，`sameId:true`），**不產生新檔**——`projects/` 下仍只有 1 個 `.jsonl`，由 14 行 **append 到 24 行**。
- **無重放/重複**：原 session 的 line 0–13 在 resume 後**逐字不變**（uuid 完全一致：`c25a5b48`/`63e5412e`/`3d49bc53`/`81083301`…），新內容純 append 在 line 14–23。續跑內容：line 16（user，確認語）→ line 19（assistant `Write` tool_use，寫 transfer-done.txt）→ line 20（tool_result 成功）→ line 21（assistant `The transfer of 5 fake-coin to alice is complete.`，end_turn）。
- **去重合併鍵含義**：純 `--resume` 是「同檔 append」，整個 session 就是一個連續 JSONL、無重複行，**根本不需要去重**。若未來用 `--fork-session`（本次未測，該旗標會產生新 sessionId）才可能出現複製歷史行，屆時 `uuid`（每行唯一、resume 後保持穩定）是天然的去重鍵。
- **resume 後 skill 歸因斷點（重要）**：line 19 的 `Write`（正是 skill 指示的「確認後寫 transfer-done.txt」動作）與 line 21 最終回合**都沒有 `attributionSkill`**。跨 resume 邊界後 skill 已不在 stack 上活躍，即使語意上是 skill 驅動的動作，也**不被歸因**。→ attributionSkill 只覆蓋「skill 啟動的那一次 invocation 內」的回合，多輪確認流的後半段會漏歸因。

**C. cost/usage 累計 vs 增量**
- 首回合 `total_cost_usd = 0.1263`（cache_creation 17928、cache_read 53821、output 135）。
- resume invocation `total_cost_usd = 0.0846`（cache_creation 10210、cache_read 67034、output 213）。
- resume 值 **< 首回合值**（0.0846 < 0.1263），且其 cache_read 反而更大（把整段歷史從 cache 讀回）→ 每個 `claude -p` invocation 回報的 `total_cost_usd`/`usage` 是**該次 invocation 的增量**，**不是**整段 session 的累計。JSONL 本身**不含 result 行**（parser 的 `KNOWN_SKIP_TYPES` 已列 `result`；實測 JSONL 內也確無 result 型別行），成本只從各次 invocation 的 stdout JSON 取得。
- **合併規則含義**：要得整段 session 總成本／總 tokens，須**逐次 invocation 相加**（sum over invocations），不能只取最後一次，也不能假設任一次是累計值。

**D. 完整確認流證明**
- `transfer-done.txt` 最終**寫出**，內容 = `TRANSFER 5 fake-coin TO alice CONFIRMED`（與 SKILL.md 指定格式一致）。即「觸發→確認回合停下→resume 確認→執行副作用」全鏈打通。

---

## P3 — 併發安全

**問題**：同一 profile 同時跑多個 session，全成功？JSONL 各自獨立無交叉污染？有無 lock/錯誤？

**程序**：對**同一** profile（probe-p3）用 `Promise.all` **並行**跑 3 個 headless session，各自不同 workspace 子目錄（p3-a/b/c）與不同 prompt（bob／carol／dave 餘額）。

**JSONL 原始證據**（各自獨立檔）：
- `.../profiles/probe-p3/projects/C--...-workspaces-p3-a/30ac9a58-9cfe-42f6-96f8-0756961e4267.jsonl`（18 行）
- `.../profiles/probe-p3/projects/C--...-workspaces-p3-b/49e4a391-182c-46d1-bb1f-cec1280e93ae.jsonl`（18 行）
- `.../profiles/probe-p3/projects/C--...-workspaces-p3-c/96cb2e3e-2cad-49d9-b6d3-cb33478c902c.jsonl`（17 行）

### 事實發現

- **全部 3 個成功**（exitCode 0、無 timeout、stderr 空），答案各自正確且來自 guide：bob `875 FAKE`、carol `60 FAKE`、dave `0 FAKE`。3 個 session 皆 `hasSkillToolUse:true`（各自獨立觸發 skill）。
- **無交叉污染**：每個 JSONL 內掃描 `sessionId` 欄位，`foreignSessionIds` 皆為 `[]`——沒有任何一檔混入他 session 的行。三檔各自對應唯一 sessionId 與唯一 workspace（claude 依 cwd 對 workspace 路徑做 slug，落到不同 `projects/<slug>/` 子目錄，天然隔離）。
- **無 lock／無錯誤**：3 個並行、總 wall 約 21 秒（非序列相加），無任何檔案鎖或寫入衝突報錯。
- **對 spec 的直接含義**：同一 profile 併發多 session 安全的前提是**每個 session 用不同 workspace cwd**（JSONL 依 cwd-slug 分目錄）。回歸管線可安全並行跑多題／多 repeat，共用一個隔離 profile。

---

## P4 — permission-denied 形態

**問題**：被拒工具呼叫的 tool_result 行長什麼樣（error 欄位／文字模式）？這是「missed（模型沒呼叫）vs permission-artifact（呼叫了但被拒）」的機械依據。

**程序**：跑 1 session，allowedTools **只給 `Read`**（不給 Write/Bash），prompt = `Create a file named hello.txt ... Do it now.`。

**JSONL 原始證據**：
`.../profiles/probe-p4/projects/C--...-workspaces-p4-denied/77f0db26-14b7-413d-9982-e450431f41e5.jsonl`（12 行）

### 事實發現

- 模型**確有呼叫** Write（line 8，assistant `tool_use name:"Write"`），隨即被拒。
- **被拒 tool_result 行（line 9，user）**：
  - content block：`is_error: true`，文字 = `Claude requested permissions to write to <path>\hello.txt, but you haven't granted it yet.`
  - 頂層 `toolUseResult` = `"Error: Claude requested permissions to write to <path>\hello.txt, but you haven't granted it yet."`（前綴 `Error: `）
  - 頂層 **`toolDenialKind: "user-rejected"`**（最乾淨的機械信號；headless 未授權工具 → 自動 reject）
- line 10：assistant text `The write was denied by permissions...`，end_turn。
- **對照成功工具**（P1 line 13 成功 Read）：`is_error` 欄位**不存在**（undefined），**無** `toolDenialKind` 鍵。
- **permission-artifact 判別規則**：一個 tool_result 是「permission-artifact」當且僅當該行 `toolDenialKind` 存在（實測值 `"user-rejected"`）**或** `is_error===true` 且文字符合 `/Claude requested permissions to .+ but you haven't granted it yet/`。此時上游必有對應 assistant `tool_use`（模型有嘗試）。反之「missed」= 該工具**根本沒有對應的 tool_use 行**（模型從未呼叫）。兩者可純機讀區分，不需看模型自然語言。

---

## 對 U0/U2/U3 requirements 的裁決

**1. `attributionSkill` 可用性判定 → 部分可用，不可作唯一歸因源。**
- 事實：欄位真實存在於 session JSONL 的 `type:"assistant"` 行，值為 skill 名（如 `"probe-skill"`）。
- 邊界：只標記「skill 啟動後、同一 headless invocation 內、於 skill 活躍期生成的 assistant 回合」；**觸發回合本身不帶**，**跨 resume 邊界的後續動作不帶**（P2 的 Write 漏歸因）。
- 裁決：可作「該回合是否在 skill context 內」的**強正信號**，但**會漏**（多輪確認流後半、resume 續跑）。要完整歸因，須輔以：(a) `Skill` tool_use 的 `input.skill`；(b) Read/Write 等工具 `input.file_path` 是否命中 `<profile>/skills/<name>/` 前綴；(c) `isMeta` user 行的 `sourceToolUseID` 回指鏈。

**2. 確認回合機械特徵定義 → 可機讀。**
- 定義：一次 headless invocation 的**最末 assistant 回合**滿足 `stop_reason === "end_turn"` **且** 該回合 `toolCalls.length === 0`（純 `text` block），而任務尚無完成副作用（目標產物未出現 / 無成功的狀態改變工具呼叫）。
- 反例對照：已執行完成的回合，其鏈中會有成功的狀態改變 tool_use（如 P2 resume 的 `Write`）＋產物（transfer-done.txt）。

**3. resume metrics 合併規則建議。**
- 純 `claude -p --resume <sid>`（不加 `--fork-session`）：**同 sessionId、同一 JSONL append、零重放**。
- 解析：直接對「不斷成長的單一 JSONL」全量 parse 即得完整多輪對話，**無需去重**。
- 成本/tokens：每次 invocation 的 stdout `total_cost_usd`/`usage` 是**增量**，總量 = **逐次相加**。JSONL 內無 result 行，metrics 不可只從 JSONL 取成本。
- 去重鍵（僅未來若用 `--fork-session` 才需要）：以每行 `uuid` 為鍵（resume 後原行 uuid 穩定不變）。

**4. 併發安全結論 → 安全，附前提。**
- 同一隔離 profile 可並行跑多 session；前提是**每個 session 用不同 workspace cwd**。claude 依 cwd-slug 把 JSONL 分到不同 `projects/<slug>/` 子目錄，各檔獨立、無交叉污染、無 lock 錯誤。回歸管線可放心並行多題/多 repeat 共用一 profile。

**5. permission-artifact 判別規則 → 可機讀。**
- permission-artifact：tool_result 行 `toolDenialKind` 存在（實測 `"user-rejected"`）或 `is_error===true` 且文字符合 `Claude requested permissions to … but you haven't granted it yet`；且上游有對應的 `tool_use`。
- missed：該工具**無任何 `tool_use` 行**（模型從未嘗試呼叫）。
- 成功：tool_result 無 `is_error`（或 false）、無 `toolDenialKind`。
- 三態純結構可分，回歸評分可據此把「因權限被擋」與「模型真沒做」分開計分。
