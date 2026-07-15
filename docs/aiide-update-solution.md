# aiide Update Solution（PM × Tech A2A 收斂定稿）

> 產出：PM lead × Tech lead 對抗式收斂迴圈，2 輪達成雙向 SIGN-OFF（2026-07-09）。
> 依據：`competitor-gap-analysis-aiide.md` + `competitor-harbor.md` + `competitor-claude-tap.md`
> （內部 KB 研究稿，位於 `.kiro/kb/raw/research/`，未隨 OSS 發佈）、aiide 現有代碼（`bin/aiide.js`、`src/*.js`、`web/index.html`、
> `docs/adapters.md`）、KB 原則頁（local-first trust、deterministic-first、AX-first、產品形態 CLI→OSS→企業）。
> 所有技術聲稱附 `file:line` 佐證，經 tech lead 核對。

---

## 目標敘事

aiide 的獨特生態位是**唯一在單機、零侵入前提下把「觀測（看 agent 做了什麼）」與「評測（給 agent 打分）」
合進同一個迭代迴圈的工具**。這一輪 update 不追 Harbor 的雲端規模，也不追 claude-tap 的 wire-level 抓包廣度——
而是把這個獨有迴圈補到**工業級可信**：

> **讓 skill 開發者「敢信任 aiide 給的分數，且能一眼看懂分數從何而來」。**

四個既有護城河（誠實部分評分、context/skill 成本可觀測、metadata 可重現、零依賴零侵入）在這一輪不只被保留，
還被進一步**放大並講響**：每個 Wave 都是在強化其中一條護城河，不是抄競品功能表。核心用戶始終是
**單人 skill 開發者在本機迭代**——他改了 skill／prompt／被測產品代碼，跑 suite 看分數，分數變了想知道為什麼，
再回頭改。這個迴圈裡有幾個真實的「痛苦時刻」，Wave 就按「解決哪一個痛苦」來切，而不是按「借自哪個競品」。

---

## 解決方案總覽

| Wave | 用戶心智狀態 | 放大的護城河 | 功能 |
|---|---|---|---|
| **Wave 1 — 可信的分數** | 「這個 C=0 到底是 skill 爛，還是外部服務掛了？」「跑到一半白費了。」 | 誠實部分評分 | 增量落盤+resume、錯誤分流 retry+excluded、file_exists verifier、pass@k |
| **Wave 2 — 看懂為什麼** | 「context 為何從 3400 長到 8000 tok？」「上次那個 tool 呼叫在哪個 run？」 | context 成本可觀測 | context diff（surface 既有歸因）、跨 run 指標卡、detail panel 折疊+copy、全文搜尋 |
| **Wave 2.5 — 結構性觀測護城河** | 「skill X 在我所有 run 裡到底表現如何？」「改了 skill 有沒有變好？」「觸發這個 skill 真的有幫助嗎？」「這個 loop 是不是在鬼打牆？」 | skill 一等公民 / loop 逐輪敘事 / 觀測×評測合體 | skill profile 視圖、skill 版本因果 compare、loop 逐輪演變、activation×outcome 因果、（Wave 4）OTel 匯出 |
| **Wave 3 — 邊跑邊看** | 「我想邊跑邊看 context 怎麼長，而不是跑完才 ingest。」 | 零侵入（走檔案不走 proxy） | `aiide watch` + SSE live-tail |
| **Wave 4 — 長跑與擴展** | 「我要寫 suite 但不知格式」「runs 只增不減」「這 task 其實是多步」 | metadata 可重現 / 零侵入 | lab init 腳手架+aiide skill、CLI 保留清理、多步驟 task |

**排程紅利（tech lead 核實）**：Wave 1 全部只動 `lab.js`／`score.js`；Wave 2 全部只動 `web/index.html`／`server.js`。
**兩組檔案集互斥 → Wave 1 與 Wave 2 可真正並行，無 rebase 衝突。** 唯一必須序列化的是 Wave 1 內部的
`S1→S2→S3(→S12)`（都動同一個 task/repeat 巢狀迴圈 `lab.js:383-411`）。全案僅兩個 M-L 重活（S1 resume、S9 watch），其餘 S/M。

**守住的四條鐵律**（皆已驗證本輪方案不觸碰）：
1. **零依賴、零 build**：Wave 2/3 沒有任何一項需要 build step 或前端框架。SSE 用瀏覽器內建 EventSource；
   搜尋用 client 過濾 +（選配）~30 行 Node grep 端點，**不建 inverted index**（對本機幾十~幾百 run 的規模是過度工程）。
2. **experiment.json write-once immutable**：resume 走全新的 append-only journal，**不讓 experiment.json 變 mutable**；
   annotations sidecar 契約完全不動。
3. **server 永遠 read-only（唯一例外 annotations PUT，`server.js:24` 明文）**：保留/清理走 CLI（`aiide prune`），
   **不新增任何 DELETE 端點**。這正是相對 claude-tap（dashboard 有 bulk delete 可變表面）的信任差異化。
4. **自我改進中立層 — aiide 只做驗證/資料層，永不自動採用（Wave 2.5 治理硬 invariant）**：Wave 2.5 沒有任何 spec
   可寫回 skills／自動改 suite／自動選版本。skill profile、因果 compare、activation×outcome 全部只輸出**唯讀證據**
   給人看、給 AI 讀；採用決策永遠在人。這是 `dec-2026-07-self-improvement-neutral-layer` 的 anti-goodhart + HITL 線焊成代碼級。

---

## Wave 與功能詳述（含 UX 概念）

UX 品味沿用內部 IxD 規格 `docs/ixd/feature-experiment-metadata.md`（IxD 交付套件，未隨 OSS 發佈）：**常態靜音、異常醒目；會變的排前面；一頁一焦點；
零學習成本沿用既有慣例（`┌─│└` 框線、panel/badge/✓✗、dark theme、en+zh-hans i18n）；terminal 與 GUI 同等重要**。

### Wave 1 — 可信的分數

#### 1.1 增量落盤 + resume / skip-completed
**心智狀態**：跑 `3 task × 5 repeat × 2 model = 30 runs`，跑到第 22 個外部服務 access token 過期（`adapters.md:130`
token 壽命約 1h），整批白費。這是 KB 明載的真實痛點（`pit-2026-07-external-cli-auth-uncontrolled-benchmark-variable`）。

**技術形態**：新增獨立 artifact 類別——append-only 進度 journal
`<data-dir>/experiments/.inprogress/<resumeKey>.jsonl`，`resumeKey = ${suite.name}-${model}-${suiteSha8}`。
每完成一個 repeat append 一行；跑完從所有 repeat（resumed+new）組出 experiment.json、寫時間戳 immutable 檔（`lab.js:340`
不變）、刪 journal。**immutable 保證精確保留**——只是新增「未完成」概念，不改既有 sealed 檔。

- **入口**：`aiide lab run` 偵測到同 resumeKey 的 journal → 預設自動 resume；`--fresh` 強制重跑。
- **預設態（靜音）**：無未完成 journal 時完全無感，照常跑。
- **醒目態**：resume 時 preflight 後印一行 `↻ resuming: 21/30 repeats done, 9 to go`。
- **失敗態**：
  - config drift（suite sha8／model／repeats 變）→ `✗ cannot resume: suite changed (a1b2→c3d4) — use --fresh`，**不啟動**。
    （sha256 於 `meta.js:172` 已在算，提前到 `cmdLabRun` 即可。）
  - journal 壞尾行 → parser 天生容忍（`parser.js:34`），append-only + crash-safe。
- **terminal**：逐 repeat 進度，已完成的印 `✓ (cached)` 而非重跑。
- **GUI**：**零 server 改動**——`listExperiments`（`server.js:117`）只收 `endsWith('.json')` 且 readdirSync 非遞迴，
  `.jsonl` 與 `.inprogress/` 子目錄自動被濾掉，dashboard 對 journal 天生隱形。（此為乾淨設計的證據，必須寫明。）

#### 1.2 錯誤型別分流 retry + excluded 語義（★ 本輪最強的護城河放大）
**心智狀態**：分數是 C=0，但我分不清是 skill 真爛，還是外部服務 auth 死了。

**政策（雙方 2 輪辯論後定稿）**：
1. repeat 失敗時比對 **signature-based 白名單**：HTTP 429／529、`ECONNREFUSED`、auth-expiry 字串（含 onchainos 53017）、
   rate-limit。命中 → 指數退避 retry。
2. **retry 成功 → 替換該 repeat**，`n` 維持 = repeats，Wilson 分母誠實（處理 transient 抖動）。
3. **retry 耗盡且仍命中白名單 → 標 `excluded (env-noise)`、從分母剔除**（`n` 縮小）。
   **絕不算 C=0**——因為 auth 過期是「未受控 benchmark 變因」（KB pitfall），算 C=0 等於把環境變因灌進 skill 分數，
   skill 根本沒得到公平嘗試。有效樣本變少 → CI 本就該變寬 → 信心本就該降低，**這是誠實不是 bug**。
4. **timeout 不進白名單**（可能是 skill 打轉）→ 照常算 C=0。generic `exit != 0` 亦不認。
5. 每個 excluded repeat 的**原始 error 落 per-repeat log**（見 1.5）——exclusion 是有證據、可稽核的決定，不是靜默縮分母。

**統計嚴謹性（入檔）**：剔除之所以無偏，是因為 aiide 的 repeats 是**同一個 identical task 的重複**，env-noise 與
task 難度近似獨立（MCAR，missing completely at random）→ 剔除不引入選擇偏誤。此假設成立正因我們重複的是完全相同的 task。

**三道護欄（spec 硬驗收，缺一則變評分後門）**：
1. **all-excluded → C=null、composite=null，不是 0**。修既有暗雷：`cVals` 空時 `mean([])` 回 0（`score.js:161`）會產**假 C=0**，
   必須特判成 null，走 H=null 同款路徑（`score.js:64-68`）。
2. **修 scoreExperiment null 污染**：`mean(scored.map(t=>t.composite))`（`score.js:137`）遇 `composite=null` 會把 null 當 0 拉低整體，
   必須 filter 掉 null（沿用 `score.js:139-140` 既有 pattern）。
3. **白名單 signature-based**（skill 造不出——skill 沒法讓 API 回 529）+ raw error 落盤 + valid-n 跌破 floor
   （沿用 `MIN_REPEATS=3`／既有 lowSample 機制：欄位定義 `score.js:125`、顯示字串 `bin/aiide.js:207`）→ 該 task composite 顯示 **n/a**。

**excluded-rate 必須傳播（tech lead 的綁定條件）**：`scoreTask` 產出 `excludedRepeats` 計數（與 `failedRepeats`
`score.js:119` 並排），並**傳播到 experiment summary 與 model-comparison view**（`bin/aiide.js:177-189` `printComparison`）。
否則場景：`--models a,b` 逐 model 重啟 service 時 model B 跑的時段 auth 全掛，B 被剔 3 個 rep，對比表照印 composite 卻不標 degraded
→ 顯示假的「B < A」誤導決策。這是本功能存在的核心理由，不可只停在單一 scorecard。

- **入口／預設態**：無 excluded 時完全靜音。
- **醒目態**：只要有任何 excluded → preflight 後與 scorecard 頂印
  `⚠ degraded: 2 repeats excluded (env-noise: auth-expired) — score on valid samples only`；comparison 印 `B: degraded (3 excluded)`。
- **terminal**：`price-query r3/5 … retry 1 (429, backoff 2s) … excluded`；task 行 `ok=3/3 (2 excluded)`。
- **GUI**：per-task repeats，excluded repeat 用 `--warn` 色 + `excluded` badge + hover 原因；全 excluded → task composite 顯 `n/a`。

#### 1.3 file_exists verifier + pass@k
**心智狀態（file_exists）**：我的 task 是「agent 產出一個檔案」，`regex` 驗不了最終文字。

- **技術形態**：verifier 分兩類——**純文字 verifier**（現有 `runVerifier(v, text)` `score.js:10`，regex/numeric/json 不動）
  與新的**filesystem verifier**（獨立類別，不污染純文字函式），把 `workspaceDir` 穿進執行；型別
  `{"type":"file_exists","path":"out/result.json"}`（+ 可選 JSON schema）。驗收須對齊 adapter runtime 的 cwd 語義
  （`adapters.md:26` `cwd` 省略 = 每 repeat 空 workspace）。
- **GUI/terminal**：verifier 明細沿用既有呈現，加 `file_exists: out/result.json ✓`。

**心智狀態（pass@k）**：想用業界通用語言講「這 skill pass@3 多少」。
- **技術形態**：純算 `scoreTask` 既有的 per-repeat C 陣列，**進 scorecard 診斷區、不進複合分**（守 deterministic-first
  iron rule `score.js:2-3`）。
- **terminal**：diag 行 `pass@1=0.67 pass@3=1.00`。

#### 1.5 per-repeat log 目錄（併入 S1 交付）
每 repeat 落地 `exception`／`stdout`／`trace` 到獨立目錄。**從 gap-analysis 的 Wave C 提前到 Wave 1**：與 1.1／1.2 同動
`lab.js` 執行迴圈與落盤，一起做省 rebase，且 1.2 的 excluded 稽核（原始 error 落盤）本就依賴它。

### Wave 2 — 看懂為什麼（走檔案不走 proxy）

#### 2.1 相鄰回合 context diff（★ 相對 claude-tap 近乎免費的差異化）
**心智狀態（最痛）**：「context 為何從 3400 長到 8000 tok？」claude-tap 的招牌是 diff wire prompt；aiide diff 的是
**context footprint 的組成歸因**——對「為什麼變貴」其實更直接。

**關鍵事實**：**資料與計算已存在**。`web/index.html:449-458` 已逐 round 算出 `_delta`（footprint 增量）與
`_attr{prevOut, toolRes, injected, other}`（歸因四桶）。本功能是 **surface 既有歸因，不是建**，成本 **S**。

- **入口**：run detail timeline，每個 round summary 右側常態顯示 `Δ+4600 tok` chip。
- **預設態（靜音管理）**：`_delta` 不顯著時 chip 用 `--dim`；顯著（超閾值）才上色（`--warn`）。只有一個 round（無前一回合）→ 不顯示。
- **展開**：列出四桶**按貢獻降序**（會變的、貢獻大的排前面）：`prevOut`／`toolRes`／`injected`／`other`。
- **失敗態／邊界（入檔必備）**：`_attr.other` 是殘差 `delta − prevOut − toolRes − injected`（`web:456`），遇 context
  compaction／cache eviction 時 footprint 會掉、殘差**變負**。UX 必須把 `other` 當**對帳殘差（±）**標示，
  **不可**當一個正的「貢獻桶」渲染，否則 compaction 邊界會顯示垃圾數字。（parser 已跳過 compact-boundary `parser.js:7`，
  但 footprint 仍會掉，此邊界真的會遇到。）

#### 2.2 跨 run 總覽指標卡
**心智狀態**：打開 dashboard 想一眼看健康度——最近的 run 錯誤率多少、燒了多少 token／成本。

- **入口**：runs 頁（`#runs`）頂部一列指標卡（沿用既有 panel 視覺，不搶列表焦點）：total runs／**error-rate %**／tokens／cost。
- **技術形態**：聚合既有欄位（`server.js:104-108` 已帶 `toolErrors`／tokens／cost），成本 S。error-rate 是 observability 核心儀表。
- **醒目態**：error-rate 超閾值時該卡上色。

#### 2.3 detail panel 結構化折疊 + copy
- **心智狀態**：看 run detail 想聚焦某段、其他收起，且跨 round 保持。
- **技術形態**：`<details>` 已在用（`web:497`，`toggleRounds` `web:503`）。加 **折疊狀態 localStorage 持久化**
  （以 section 類型為 key，跨 round 保持）+ **copy JSON／cURL** 鈕。成本 S。

#### 2.4 全文搜尋
- **心智狀態**：「上次那個 `market_price` tool 呼叫在哪個 run？」
- **入口**：頂部 nav 旁 search box，`Cmd/Ctrl+F` 聚焦（j/k 導覽作為附屬，不獨立投入）。
- **技術形態**：client-side 過濾已載入的 list metadata（aiide 本機規模下瞬時）；要搜進 round/tool 本文 → 加**選配
  ~30 行 read-only `/api/search?q=`** 端點，Node fs 直接掃 run JSON 回 `runId`+snippet，**不建索引**（本機規模過度工程）。

### Wave 2.5 — 結構性觀測護城河（三個競品全空白的維度）

> 依據 KB `fin-2026-07-market-observability-gaps`：13 家主流觀測平台（LangSmith/Langfuse/Braintrust/AgentOps…）資料模型
> 全停在 trace/span/tool-call，三個維度無人覆蓋——(S1) skill 一等公民、(S2) loop 逐輪演變、(S3) 自我改進閉環的驗證步。
> Wave 2 是競品 table-stakes；**Wave 2.5 才是 aiide 資料層幾乎唯一能做的結構性護城河**。
> **治理硬 invariant 貫穿全 Wave**：所有輸出皆唯讀證據，aiide 永不寫回 skill/suite、永不自動採用（見鐵律 4）。
> **視圖預算：恰好新增一個視圖（`#skills`）**；其餘皆塞進既有 run detail / compare / scorecard，防視圖爆炸。

#### 2.5a Skill profile 視圖（S1 空白 — 讓 skill 有自己的家）
**心智狀態**：skill 是 aiide 的核心名詞（SkillScore、隔離 skill lab），卻沒有自己的頁——「skill X 在我**所有** run/experiment
裡表現如何？成本趨勢、觸發率、版本演變？」**代碼實勘**：無 `#skills` 視圖（router `web:381-386` 只有 runs/experiments）；
skill 資料散三層互不相連（per-run `metrics.perSkill`、per-experiment `contextInsights.skillListing`、env `skills[]={name,hash}`
`meta.js:180`）。這是唯一的結構性新增。
- **入口**：runs/experiments 表既有的 skill badge（`web:415`/`web:563`）點擊 → `#skill/<name>`；nav 加**第三個 tab `skills`**。
- **技術形態**：新 read-only `/api/skills` 端點，server 端**同構於 `listExperiments`（`server.js:117`）全掃目錄**——join 兩來源：
  experiments（分數/hash/listing，靠 targetSkills+composite）+ runs（per-skill token/rounds，靠 `metrics.perSkill`）。
  **不建持久 index**（本機幾十~幾百規模是過度工程，同上輪搜尋結論）。用 **skill hash 當 key** 對齊版本。
- **預設態（一頁一焦點）**：頂部**版本演變時間線**（x 軸 = skill hash 序列，hash 變化點醒目）+ 四張卡（觸發率／每次觸發
  listing+body token／用它的 experiment 數／平均分）+ 下方「用到此 skill 的 experiments 表」各自分數。
- **可比性護欄（誠實核心，與 S15/neutral-layer 同源）**：同一 skill 跨 experiment 的分數趨勢**不是** apples-to-apples——
  experiment 可能用不同 suite/model。故**趨勢線只在同一 comparability cohort（suite sha256+model+runtime）內連線；跨 cohort
  不連**，改畫**同圖上不同顏色的獨立線**（各自 y 可比、y 軸標註 `suite@sha·model` 讓圖自我說明）。稀疏本身即誠實訊號
  （「你這些點條件不同，本來就不該連成一條趨勢」）——是資訊不是缺陷。**反對「全連+警語」的簡化**（線是強視覺斷言，警語壓不住誤讀）。
- **失敗態（skill 開發者最該看到的訊號）**：skill 裝了但**從未觸發**（activation=0%）→ 醒目標「installed but never triggered —
  純 context 稅」，並把因 runtime 沒寫 `attributionSkill`、表現為一般 tool call（Read/Bash）的 round **明確歸到既有
  "unattributed" 桶（`web:524` 詞彙已在），不靜默丟**——誠實評分護城河延伸到觀測側。
- **terminal**：`aiide skill okx-dex-market` 印 `┌─│└` 版本時間線 + 觸發率 + token 稅 + 分數趨勢箭頭（cohort 分組）。

#### 2.5b Skill 版本因果 compare（S3 閉環的 A/B 驗證步）
**心智狀態**：「我把 skill 從 a1b2 改到 c3d4，分數到底有沒有因此變好？」把既有 compare 從「diff + 分數並列」升為**因果驗證器**。
- **代碼實勘**：viewCompare（`web:579-618`）已把兩 experiment 全載入 client（`web:580`），結構化 per-skill `{name,hash}` 在
  `environment.skills[]`（`meta.js:180`）——只差**關聯**。
- **UX**：compare 頂部新增因果敘事行：`skill okx-dex-market: a1b2→c3d4  ⇒  SkillScore +0.12 (C +0.08 · activation +5pp)`。
- **honest-comparison 護欄（關鍵，兩層）**：
  1. **只有兩實驗可比（同 `suite.sha256` + 同 model + 同 runtime）才用因果箭頭「⇒」**；任一不同 → 降為「correlational
     （不可歸因，其他變因並存）」+ 既有 cross-runtime 警示。注意既有警示（`web:615-616`）只查 runtime+endpointHost，
     S15 須**擴充**成也比對 `suite.sha256`（`meta.js:172`）+ model。
  2. **常態靜音防假因果**：因果行常態只印 `⇒ +0.12`（乾淨）；**只有當 delta 落在兩邊 task CI 重疊區（不顯著）才醒目附
     `[within noise — CIs overlap]`**（資料在 `task.wilsonCi` `web:607`）——顯著時靜音、不顯著時才把警語當「異常」凸顯，
     不讓 `+0.02` 被讀成「改進」。
- **失敗態**：skill hash 相同（沒改 skill）→ 不顯示因果行（無變因可歸因）。

#### 2.5c Loop 逐輪演變（S2 空白 — context 是「誰」逐輪填大的）
**心智狀態**：「context 長大了，但逐輪看是**誰**在填？這 loop 是不是在鬼打牆？」
- **代碼實勘**：run detail 只有單線 `contextPerRound` sparkline（`web:477`）+ `outputPerRound` barChart（`web:478`）；四桶歸因
  `_attr`（`web:449-458`）只用於單 round diff（S4），**無跨 round 堆疊、無 loop 偵測**。
- **UX 主體**：四桶 `_attr`（prevOut/toolRes/injected/unattributed）**堆疊面積/柱狀圖 over turns**（零依賴 SVG/CSS 手畫）。
  **關鍵誠實處理**：既有 sparkline/barChart（`web:967`/`web:977`）都 `max=Math.max(...vals,1)` **假設非負**；而 `_attr.other`
  殘差可為負（compaction/cache eviction）。堆疊圖**必須新做**：正四桶疊 stack、**負 other 畫 baseline 下方 diverging segment
  或標「context shrank (compaction)」marker，絕不當正高度渲染**。
- **loop 健康訊號（次要、deterministic-only 焊死邊界）**：**只認純結構訊號**——連續 N 輪（同 tool name + input JSON 正規化後
  **完全相等或 exact-prefix**）／連續同型 tool error／round 逼近 maxTurns 而 C 未達。**絕不做語義相似度**（那是偽 LLM-judge，
  破 deterministic-first）。常態靜音、高信心才 fire、閾值 N 可配置、依據攤開：`⚠ suspected loop (deterministic: 4× identical Bash input)`。
- **失敗態**：單 round → 不畫堆疊。

#### 2.5d activation × outcome 因果（★ 只有 aiide 能做的「兩半壁合體」）
**心智狀態**：「觸發這個 skill 到底**有沒有幫助**？」這是 observe（skill 有沒有觸發）× eval（分數）在同一筆記錄的關聯——
13 家平台有觀測 OR 評測，**從無兩者合體**。把 activation 從虛榮指標變因果訊號。
- **技術形態（AX-first）**：資料已在 `task.repeats[].{activated, C}`（`score.js:106`/`:131`）。相關性算成 **score.js task 欄位
  `activationOutcome:{triggered:{n,meanC}, notTriggered:{n,meanC}}`**（AX-first：AI 讀 scorecard JSON 直接拿到因果訊號，
  不用自己重算），序列在 Wave 1 S2/S3 後——但它是對既有 `repeats[]` 的**純加法讀取**，邏輯獨立於 retry/excluded 改動，
  衝突只是同函式區域（`score.js:118-132`），rebase 近零。
- **UX**：scorecard per-task 加一行：`triggered okx-dex-market → 0.91 (n=3) · not triggered → 0.30 (n=2)`。
- **三條 null 誠實護欄（與 H=null/excluded 同 DNA）**：(1) activation=null（無 targetSkills）→ 欄位 null/省略，**不是 `{n:0}`**
  （不假裝有比較）；(2) 一側 partition n=0（全觸發或全沒觸發）→ **只顯示有資料那側**，例 `triggered → 0.91 (n=5) · never
  not-triggered`，絕不渲染 0/0 對比；(3) 小 n → 標「correlational, low sample」（沿用 `score.js:125` lowSample 哲學）。
- **terminal + GUI 對稱**：scorecard 與 dashboard 都出。

### Wave 3 — 邊跑邊看

#### 3.1 `aiide watch` — live-tail（走檔案不走 proxy）
**心智狀態**：想邊讓 Claude Code 跑邊看 context 怎麼長，而不是跑完才手動 `aiide ingest`。這是 claude-tap live 的賣點，
但 aiide 用**零 proxy／零 CA／零侵入**的方式拿到。

- **技術形態**：`aiide watch <dir>` 用 **`fs.watchFile`（輪詢 stat，~500ms，跨平台可靠——不用 `fs.watch`，
  它在 win32 出名地漏事件）** tail 正在寫的 JSONL → 整檔重解（`parser.js:17`，session 還在跑時檔案不大，正確且夠快，
  變大再用 byte-offset 優化）→ 經**新 SSE 端點（GET `text/event-stream`，不破 read-only）**推前端 → 前端 EventSource
  client **append 新 round**（不全量重繪）。
- **依賴（收窄）**：watch 需要的是「新 round 進來就 append」的 **append 原語**，**不是** virtual scroll 的「開窗」——
  兩者不同原語。故 watch **自帶 append-render**，**不依賴任何 render 優化 spec**。這把它從關鍵路徑解耦、去風險。
- **優先級理由**：排 Wave 3 而非 Wave 1，因為 Wave 1 是「信任」關鍵、與 watch 零共用代碼；且 live 對「評測」核心用例
  價值有限（跑完看 scorecard 即可），真正香的是「觀測 session」場景。這是**價值/風險排序**，非技術阻塞。

### Wave 4 — 長跑與擴展

#### 4.1 `aiide lab init` 腳手架 + aiide 操作 skill（AX-first）
- **心智狀態**：要寫 suite 但全手寫 JSON、不知格式。
- **形態**：`aiide lab init --suite my.json` 產出含註解骨架（tasks/verifiers/runtime/service **含 Wave 1 新欄位**
  retry 白名單/file_exists 範例）；附一個「aiide 操作 skill」(doc) 降低 AI 代寫 suite 的錯誤率（呼應 AX-first：
  每功能先有 AI 可讀介面）。依賴 Wave 1 schema 凍結。成本 S。

#### 4.2 資料保留/清理 — `aiide prune`（CLI-only，守 read-only 鐵律）
- **心智狀態**：runs 只增不減。
- **形態**：`aiide prune --older-than 30d` / `--max N`（CLI destructive）；**dashboard 唯讀顯示「會刪什麼」+ 可複製指令**，
  **不加任何 DELETE 端點**。守「server 永遠 read-only（唯一例外 annotations PUT）」——這是可對外講響的信任賣點。

#### 4.3 多步驟 task
- **心智狀態**：真實 skill 常是多步（「先查價、再下單、再確認」）。
- **形態**：`[[steps]]` + per-step verifier + `min_reward` 前一步沒過就不跑下一步。JSON schema 擴充，動 `lab.js` 迴圈。
  依賴 S3（verifier 型別）+ S1（執行迴圈）。成本 M。

#### 4.4 OTel GenAI 匯出（履行已承諾 decision + interop 敘事）
- **心智狀態**：「我想把本機 aiide 迭代的結果匯到我團隊的 OTel 平台。」**這是 `dec-2026-07-data-layer-otel-genai-compat`
  （MAJOR）承諾「資料層 100% OTel GenAI semconv 相容、全資料可匯出」的未實裝欠債**（src 全碼無 otel/semconv）。
- **定位（PM 裁決）**：**與本輪「in-app 觀測深化」正交** — Wave 2.5 是觀測**深度**，這是觀測資料**可攜/互通**（open protocol >
  closed feature 金標準）。故標 **Wave 4 最低優先、scope 壓力下第一個延後**；team-lead 若要本輪純聚焦 in-app 深度，可整條移到獨立排程。
- **技術形態（守零依賴）**：`aiide export --otel [runId]` **手寫 OTLP/JSON**——`@opentelemetry/*` SDK = npm 依賴 = 違鐵律，禁用。
  映射（合 gen_ai semconv，據 `fin-2026-07-otel-genai-semconv-standard`）：頂層 `invoke_agent` span（一個 run）→ 每 round 一個
  `chat` 子 span（`gen_ai.request.model`/`gen_ai.usage.input_tokens`/`output_tokens`）→ 每 toolCall 一個 `execute_tool` 子 span
  （`gen_ai.tool.name`）；skill/Scorecard/RuntimeTarget 走 vendor-namespaced `aiide.*` custom attributes（semconv 明確允許的擴充）。
- **範圍**：本輪 run→OTel（乾淨映射）；experiment→OTel 用 root span + scorecard 掛 custom attributes「便宜就做、卡就延後」，
  增量滿足「全資料可匯出」。output **pin 明確 semconv 版本並註記**（gen_ai semconv 仍演進中，消費端才知依哪版）。一次性 export，非常駐 exporter。

---

## Spec 切分與依賴順序（供 `/kirokb` 逐個實作）

> 命名穩定、以依賴分組。**Wave 1（lab/score）與 Wave 2（web/server）檔案集互斥，可並行**；
> 僅 Wave 1 內部 `S1→S2→S3→S12` 須序列。共 16 個 spec（第一輪 11 個 + 第二輪 Wave 2.5 的 S14-S17 + Wave 4 的 S18；
> S6 render 優化與 S13 headless export 經辯論裁定本輪不做）。

### Wave 1（序列：S1 → S2 → S3 → S12）

**S1 `eval-resume-incremental`** — 成本 M
- 範圍：append-only 進度 journal（`experiments/.inprogress/<resumeKey>.jsonl`，`resumeKey=name-model-sha8`）+ resume/skip-completed
  + config-drift 拒絕（suite sha256 提前到 `cmdLabRun`）+ per-repeat log 目錄（exception/stdout/trace）。
- 驗收要點：(a) 中斷後 `aiide lab run` 自動接續、已完成 repeat 印 `✓ (cached)`；(b) suite/model/repeats 任一變 → 拒絕 resume 且不啟動；
  (c) 完成後 experiment.json 仍 write-once immutable、journal 被刪；(d) **零 server.js 改動**（journal 對 dashboard 天生隱形，
  `server.js:117` 非遞迴 + `endsWith('.json')` 已濾）；(e) journal 壞尾行不 crash。
- 依賴：無。

**S2 `eval-error-triage-retry`** — 成本 M
- 範圍：signature-based env-noise 白名單（429/529/ECONNREFUSED/auth-expiry/rate-limit）+ 指數退避 retry（成功=替換，`n` 不變）
  + retry 耗盡=excluded 剔除分母 + degraded 語義。
- 驗收要點（三護欄，硬性）：(a) **all-excluded → C=null/composite=null**（修 `score.js:161` `mean([])→0` 假零，走 H=null 路徑）；
  (b) **scoreExperiment filter 掉 null composite**（修 `score.js:137` null 污染，沿用 `:139-140`）；
  (c) timeout 與 generic `exit!=0` **不剔除**、照算 C=0；(d) 每 excluded repeat 原始 error 落 per-repeat log（可稽核）；
  (e) **`degraded`／`excludedRepeats` 必須同時出現在兩條 render 路徑——`printScorecard`（`bin/aiide.js:203-221`）
      與 `printComparison`（`bin/aiide.js:177-189`）**，comparison 每格標 `degraded (N excluded)`。兩者是不同 render 路徑：
      若只在 scorecard 標 degraded、對比表照印裸 composite，`--models a,b` 時 B 時段 auth 死光→假「B<A」就沒被關掉；
  (f) valid-n < `MIN_REPEATS` → task composite n/a + lowSample 旗標。
- 依賴：S1（共用執行迴圈 + per-repeat log）。

**S3 `eval-verifier-fileexists-passk`** — 成本 S-M
- 範圍：filesystem verifier 獨立類別（`file_exists` + 可選 JSON schema，穿 `workspaceDir`，不污染純文字 `runVerifier`）；pass@k 進診斷區。
- 驗收要點：(a) `file_exists` 對齊 adapter cwd 語義（`adapters.md:26`）；(b) pass@1/pass@k 顯示於 scorecard 診斷區、**不進 composite**；
  (c) 純文字 verifier（regex/numeric/json）行為零回歸。
- 依賴：S2（同動 `score.js`/`lab.js`，序列避免咬）。

**S12 `eval-multistep-task`** — 成本 M（Wave 4 內容，但排 lab 序列尾）
- 範圍：`[[steps]]` + per-step verifier + `min_reward` 提前中止。
- 驗收要點：(a) 前一步 reward < min_reward → 中止後續步、記錄中止點；(b) 單步 suite 完全向後相容。
- 依賴：S3（verifier 型別）+ S1（執行迴圈）。

### Wave 2（與 Wave 1 並行；彼此無硬依賴）

**S4 `obs-context-diff`** — 成本 S
- 範圍：surface 既有 `_delta`/`_attr`（`web:449-458`）：round summary `Δ±tok` chip + 展開四桶降序。
- 驗收要點：(a) `_delta` 顯著才上色（靜音管理）；(b) **`_attr.other` 當對帳殘差（±）渲染，可為負，不當正貢獻桶**；(c) 首 round 無 chip。
- 依賴：無。

**S5 `obs-overview-metrics`** — 成本 S
- 範圍：runs 頁頂指標卡（total/error-rate %/tokens/cost），聚合既有欄位。
- 驗收要點：(a) error-rate 超閾值上色；(b) 不搶列表焦點（沿用 panel 視覺音量）。
- 依賴：無。

**S7 `obs-detail-panel-copy`** — 成本 S
- 範圍：`<details>` 折疊狀態 localStorage 持久化（跨 round，以 section 類型為 key）+ copy JSON/cURL。
- 驗收要點：(a) 切 run 保留折疊偏好；(b) copy 成功有輕量確認（沿用既有微互動）。
- 依賴：無。

**S8 `obs-fulltext-search`** — 成本 S（list）/ M（body）
- 範圍：client-side list metadata 過濾 + 選配 ~30 行 read-only `/api/search?q=` grep run JSON（**不建索引**）。
- 驗收要點：(a) `Cmd/Ctrl+F` 聚焦；(b) 命中高亮定位；(c) server 端點唯讀、不改可變表面。
- 依賴：無。

### Wave 3

**S9 `obs-live-watch`** — 成本 M-L
- 範圍：`aiide watch <dir>` + 新 SSE 端點（GET `text/event-stream`，不破 read-only）+ `fs.watchFile`（非 `fs.watch`）+ 自帶 append-render。
- 驗收要點：(a) 新 round 到達 append（不全量重繪）；(b) win32 上穩定（輪詢 ~500ms）；(c) SSE 不引入依賴；
  (d) **不依賴任何 render 優化 spec**（append-render 自帶）。
- 依賴：無硬依賴（Wave 3 排序為價值/風險考量）。

### Wave 2.5（結構性護城河；除 S16 依賴 S4、S17 依賴 Wave 1 外皆獨立可並行）

> 治理硬 invariant 貫穿 S14/S15/S16/S17：**輸出唯讀，不寫回任何 skill/suite 檔，不自動採用**。恰一個新視圖（`#skills`）。

**S14 `obs-skill-profile`** — 成本 M（S1 旗艦，唯一新視圖）
- 範圍：`#skill/<name>` 視圖 + 第三 nav tab `skills` + 新 read-only `/api/skills` 端點（join experiments+runs 兩目錄全掃、
  不建 index、skill hash 當 key）+ `aiide skill [name]` CLI。含版本演變時間線、觸發率/token 稅/分數卡。
- 驗收要點：(a) `/api/skills` 純 GET read-only、輸出不寫回任何 skill/suite；(b) **趨勢線只在同 comparability cohort
  （suite sha256+model+runtime）內連線，跨 cohort 畫不同顏色獨立線、y 軸標 cohort**，不「全連+警語」；(c) 未觸發 skill 醒目標
  「installed but never triggered — context 稅」；(d) null-attribution round **明確歸 "unattributed" 桶（`web:524`）不靜默丟**。
- 依賴：無。

**S15 `obs-skill-causal-compare`** — 成本 S（S3 驗證步）
- 範圍：viewCompare 頂部因果敘事行 `skill: hashA→hashB ⇒ ΔSkillScore`，讀 `environment.skills[]` 結構化陣列。
- 驗收要點：(a) **「⇒」閘門 = 同 `suite.sha256`（`meta.js:172`）+ 同 model + 同 runtime**，否則降 correlational + 既有警示
  （須擴充現有只查 runtime+endpointHost 的 `web:615-616`）；(b) **常態只印 delta；僅 task CI 重疊（不顯著）才附
  `[within noise — CIs overlap]`**（`task.wilsonCi` `web:607`）；(c) hash 相同不顯示因果行；(d) 唯讀，不寫回。
- 依賴：無（讀既有 experiment 物件）。

**S16 `obs-loop-evolution`** — 成本 S-M（S2）
- 範圍：run detail 四桶 `_attr` 堆疊圖（新做）+ deterministic loop 偵測。
- 驗收要點：(a) 堆疊圖**新做，不重用 sparkline/barChart**（它們 `max=Math.max(...vals,1)` 假設非負，`web:967`/`web:977`）；
  (b) **負 `_attr.other` 畫 baseline 下方 diverging 或標 compaction marker，絕不當正高度**；(c) loop 偵測**只認 exact/exact-prefix
  結構重複，零語義相似度**（否則破 deterministic-first），依據攤開、常態靜音高信心才 fire、閾值 N 可配置。
- 依賴：**S4**（共用 `_attr` + viewRun 渲染區），且與 S7/S8 序列（同動 viewRun）。

**S17 `obs-activation-outcome`** — 成本 S-M（觀測×評測合體，只有 aiide 能做）
- 範圍：`score.js` 加 task 欄位 `activationOutcome:{triggered:{n,meanC}, notTriggered:{n,meanC}}` + scorecard/GUI 一行。
- 驗收要點（三 null 護欄）：(a) activation=null → 欄位 null/省略，**非 `{n:0}`**；(b) 一側 n=0 → 只顯示有資料側、**不渲染 0/0**；
  (c) 小 n → 標「correlational, low sample」（`score.js:125`）；(d) 純加法讀 `repeats[].{activated,C}`、唯讀不寫回。
- 依賴：**Wave 1 S2/S3**（同動 `score.js:118-132` return，textual-not-logical 咬、rebase 近零）；render/CLI 可先從 `repeats[]` 顯示、欄位後補。

### Wave 4

**S10 `lab-init-and-skill`** — 成本 S
- 範圍：`aiide lab init` 腳手架（含 retry 白名單/file_exists/service 範例）+ aiide 操作 skill（doc）。
- 驗收要點：(a) 產出的 suite 直接可跑；(b) 含 Wave 1 新欄位註解範例。
- 依賴：S1/S2/S3 schema 凍結。

**S11 `data-retention-prune`** — 成本 S-M
- 範圍：`aiide prune`（CLI-only，`--older-than`/`--max`）+ dashboard 唯讀「會刪什麼」提示 + 可複製指令。
- 驗收要點：(a) **不新增 DELETE 端點**；(b) prune 前印預覽、需確認；(c) sealed experiment 與其 annotations sidecar 一併處理。
- 依賴：無。

**S18 `export-otel-genai`** — 成本 M（Wave 4 最低優先、正交欠債、壓力下第一個延後）
- 範圍：`aiide export --otel [runId]` **手寫 OTLP/JSON**（禁 `@opentelemetry/*` SDK，守零依賴），新檔 `src/otel.js` + bin CLI。
- 驗收要點：(a) 映射 `invoke_agent`(run)→`chat`(round, `gen_ai.request.model`/`gen_ai.usage.*`)→`execute_tool`(toolCall, `gen_ai.tool.name`)；
  (b) skill/Scorecard/RuntimeTarget 走 `aiide.*` custom attributes；(c) 本輪 run→OTel 先，experiment→OTel「便宜就做否則延後」；
  (d) **output pin 明確 semconv 版本並註記**；(e) 一次性 export、非常駐 exporter。
- 依賴：無（低耦合新檔）。

---

## 明確不做

**沿用 gap-analysis（守定位）**：
- ❌ 內建 MITM proxy 當預設路徑（毀 local-first 零信任成本；wire 深度若要，走 adapter 選配後端而非核心）。
- ❌ 追 15 家 client 抓包廣度（claude-tap 主場，投報率低；aiide 的跨 runtime 軸是 eval adapter）。
- ❌ 雲端 provider / Hub / 強制登入 / Docker 必要路徑 / litellm 重依賴。

**本輪辯論後新增裁定不做**：
- ❌ **本機併發（原 C7 / spec #14）—— 砍**。三個技術理由疊加：(1) 固定 `readyUrl` port 無法 per-repeat、`startService`
  直接 throw（`lab.js:220-222`）；(2) per-session auth home race（`adapters.md:126-131`：固定 token → 同一 `sha256(token)`
  → 同一 `ONCHAINOS_HOME` → 登入態複製/讀取 race，KB `pit-2026-07-per-session-isolated-auth-home-breaks-benchmark`）；
  (3) 併發同時 append 會污染 S1 journal 的行原子性（win32），而 resume 是本輪最高優先的信任功能。ROI（提速）遠不抵風險。
  **序列跑是外部服務評測的安全預設。** 未來若有**自我聲明無狀態**的 command adapter 需求，再議 claude-code-only + service 明確拒絕的併發。
- ❌ **render 優化（virtual scroll / windowing-lite / 原 #6）—— 本輪不做（YAGNI）**。aiide 本機規模（幾十~幾百 round 的
  per-run JSON）vanilla 全量渲染沒問題（tech lead 核實）；「長 session 卡」是從 claude-tap wire-capture 規模（單 SQLite 跨 session
  上千筆）繼承的假設，非 aiide 實測。**無實測痛點不建。** watch 自帶 append-render、search 走已載入資料，皆不依賴它。
  **未來 invariant（預先寫入）**：若某 run 真的超過臨界 round 數卡頓才做 windowing-lite，且**必須帶「export 前強制全渲染再 clone」**
  ——否則會與 `exportHtml`（`web:339` clone 整棵 DOM 樹）相剋、產出被截斷的報告。
- ❌ **headless CLI export（原 #13）—— 本輪不做**。互動側 `exportHtml`（`web:339`，strip script + 保留 `<details>` 原生可展開的
  自包含 HTML）與 `exportPng`（`web:332`，snapdom 已 vendored）**已滿足「貼給同事看」**；headless CLI 只對 CI 有邊際值。
- ❌ **LLM 事後分析**（連 shadow 都延後，本輪聚焦）；❌ **ATIF 相容匯出**（無明確 interop 需求；OTel 才是承諾的 interop 標準，見 S18）；
  ❌ **claude-tap 全套鍵盤導覽**（j/k 作為搜尋附屬即可，不獨立投入）。

**第二輪（Wave 2.5）辯論後新增裁定不做**：
- ❌ **自動採用/自動改進 skill（治理硬 invariant）**：aiide 是 **verification/data layer**，Wave 2.5 沒有任何 spec 可寫回 skills、
  自動改 suite、自動選版本——skill profile / 因果 compare / activation×outcome 全部只輸出唯讀證據，**採用決策永遠在人**。
  這是 `dec-2026-07-self-improvement-neutral-layer` 的 anti-goodhart + HITL 線焊成代碼級 invariant（見鐵律 4），焊進每個 Wave 2.5 spec 驗收。
- ❌ **skill 分數的「分解歸因」**：composite 無法誠實拆到單一 skill，故 S14 的「分數」是**targeted 該 skill 的 experiments/tasks 的分數**，
  非把 composite 拆成 per-skill 貢獻（那是假精確）。
- ❌ **loop 健康的語義相似度判斷**：只認純結構訊號（tool name + input exact/exact-prefix 相等），**絕不做「這輪像在鬼打牆」的語義判斷**
  ——那是偽 LLM-judge，破 deterministic-first。
- ❌ **跨 comparability cohort 的 skill 趨勢連線**：不同 suite/model 的點不連成一條趨勢線（線是強視覺斷言，會製造假趨勢）；改畫多 cohort 獨立彩線。
- ❌ **持久 skill/搜尋 inverted index**：`/api/skills` 與搜尋皆 server 端即時全掃（本機規模夠），不建持久索引（過度工程）。

---

## 辯論紀要（雙方主要交鋒點與裁決）

| # | 交鋒點 | PM 立場 | Tech 立場 | 裁決 |
|---|---|---|---|---|
| **A2 excluded 統計** | env-noise retry 耗盡後怎麼算 | **從分母剔除**、絕不 C=0（引 `pit-external-cli-auth`：auth 是未受控變因；`--models` 對比表會出假「B<A」） | 初主張 retry 耗盡算 C=0，怕無界 exclusion 變灌水後門 | **PM 勝，Tech 讓步**。剔除分母是對的，綁三護欄（signature 白名單窄到 skill 造不出 + raw error 落盤 + valid-n<floor→n/a）+ **excluded-rate 傳播 summary/comparison**。統計上是 MCAR（identical task 重複）→ 無選擇偏誤。 |
| **A1 immutable** | resume 是否逼 experiment.json 變 mutable | 擔心需 partial/sealed 狀態模型 | **不需要**——append-only journal 是全新「未完成」類別，sealed 檔仍 write-once | **Tech 解法採納**。immutable 保證精確保留，sidecar 契約不動，且零 server 改動。 |
| **零 build 天花板** | Wave 2/3 是否逼引入 build/框架 | 寧可砍功能也守零 build，怕搜尋要建索引 | **恐懼放錯地方**：SSE 內建、搜尋 client 過濾+30 行 grep、無一需 build | **Tech 澄清採納**。零 build 未被威脅；要砍的是複雜度不是功能；反對任何 build/框架提議。 |
| **watch 依賴/優先級** | watch 該多前面 | 排 Wave 3、依賴 render 地基 | 依賴假設**錯**：watch 要 append 原語≠windowing，應解耦；用 `fs.watchFile` 非 `fs.watch`（win32） | **合流**：watch 自帶 append-render、脫離 render spec、維持 Wave 3（價值/風險排序）。 |
| **併發** | 保留還是砍 | 砍（per-session home race） | 砍/硬 gate（service 敵意 + port collision + journal 原子性 + 無法驗任意 adapter 併發安全） | **雙方一致：砍**。序列為安全預設，未來限無狀態 adapter 再議。 |
| **render 優化 #6** | virtual scroll 該做到什麼程度 | 讓步後**再砍一格：整個不做（YAGNI）** | 反對真 virtual scroll（L+脆），提 windowing-lite | **PM 裁決：本輪不做**，未來帶 export-full-render invariant。（Tech 成本表殘留 #6 為早期框架碎片，已按此收斂統一。） |
| **兩個「已存在」** | — | — | **context diff `_delta`/`_attr` 已算好（`web:449-458`）、export 已存在（`web:339`）** | **PM 驗證屬實並採納**：2.1 降為 surface（S）、export 本輪不做。 |

**第一輪收斂結果**：2 輪達成雙向 SIGN-OFF。最大分歧是 **A2 excluded 統計**——PM 以 KB pitfall + 對比表假訊號論據勝出，
Tech 讓步並反過來焊上「excluded-rate 傳播」與 MCAR 統計論證，使該功能從「潛在評分後門」變成「誠實評分護城河的最強放大」。

### 第二輪（Wave 2.5 — 結構性觀測護城河）

| # | 交鋒點 | PM 立場 | Tech 立場 | 裁決 |
|---|---|---|---|---|
| **#skills 視圖前提** | 擴充現有還是新建 | — | **推翻 team-lead 假設：根本沒有 #skills 視圖**（router `web:381-386`） | **雙方獨立收斂**：skill 一等公民 = 真正新視圖 + 第三 nav tab；但守「恰一個新視圖」防爆炸，其餘塞既有頁。 |
| **S17 相關性算哪層** | AX-first → 進 score.js JSON | 進 score.js，但點明與 S2/S3 是 **textual-not-logical 咬**（純加法讀 `repeats[]`，rebase 近零）；反對只算 render 層（違 AX-first） | **合流**：進 score.js `activationOutcome` 欄位、序列 Wave 1 後、標 low-conflict；render/CLI 可先顯示、欄位後補。加 3 條 null 護欄。 |
| **S14 skill 趨勢可比性** | 只連同條件但**自我顧慮圖會稀疏** | **站 PM 更嚴那版並溶解其顧慮**：只在同 cohort 連線、跨 cohort 畫獨立彩線；稀疏本身即誠實訊號，核心用例（固定 suite 改 skill）根本不稀疏 | **採更嚴版**，反對「全連+警語」。Tech 幫 PM 把自己的直覺焊得更硬。 |
| **S15 因果 vs 相關** | 只在可比時用「⇒」否則 correlational | 認同，**再加一層**：即使可比，小 n 的 delta 幅度有抽樣雜訊，須帶 CI/標 within-noise 防假因果 | **合流 + PM 反加 UX 精修**：常態只印 delta，**僅 CI 重疊（不顯著）才附 within-noise 警語**（守常態靜音）。 |
| **loop 健康偵測** | heuristic guarded 次要 | **焊死紅線**：只認 exact/exact-prefix 結構重複，任何語義相似度 = 偽 judge → 否決 | **雙方一致**：deterministic-only、依據攤開、常態靜音。 |
| **治理 invariant** | 引 neutral-layer 做 scoping | **焊成代碼級 invariant**：無 spec 可寫回 skills/自動採用，全唯讀證據 | **雙方一致**：升為第 4 條鐵律 + 每 spec 驗收 + 明確不做一條。本輪最重要護欄。 |
| **S18 OTel scope** | 保留（承諾欠債 + team-lead 明列） | 質疑與「觀測深化」正交、勿搭車不明講 | **PM 裁決**：保留但標 Wave 4 最低優先、明講正交、壓力下第一個延後；team-lead 可移獨立排程。 |
| **兩個代碼修正** | — | metadataDiffPanel 是串接非結構化 per-skill（改讀 `environment.skills[]`）；cross-runtime 警示未查 suite/model（S15 須擴充） | **PM 驗證採納**，S15 成本仍 S。 |

**第二輪收斂結果**：2 輪達成雙向 SIGN-OFF。Wave 2.5 鎖定三個競品全空白維度（skill 一等公民 / loop 逐輪敘事 / 觀測×評測合體），
最具代表性的是 **S17 activation×outcome**——「觸發 skill 到底有沒有幫助」用 observe×eval 同筆記錄回答，是 13 家平台無一能做的兩半壁合體。
最重要的護欄是**治理硬 invariant**（aiide 只做驗證/資料層、永不自動採用），把 neutral-layer 原則焊成代碼級。全程守零依賴/單檔零 build/read-only/immutable/deterministic-first。
