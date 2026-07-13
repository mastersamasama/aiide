# Agent Runtime 可觀測分類法（observability taxonomy）— 設計稿 v6（終版）
（5 輪 challenge：r1 7B+15M+9m / r2 2B+10M+8m / r3 2B+4M+1m / r4 1B+3M+4m /
r5 1B+2M+2m，共 13 BLOCKER + 34 MAJOR + 24 MINOR 全數吸收；記錄見 §6）

> **誠實終局聲明（loop-20260712-13a1f965，verdict = diverged @ round 5 / max_iter）**：
> 記帳腳本在第 5 輪（硬頂輪）判 oscillation（連續兩輪新 ≥MAJOR 4→3，BLOCKER 1→1
> 未達嚴格遞減豁免）。實質軌跡：BLOCKER 7→2→2→1→1 衰減且逐輪換面（r4/r5 均為前輪
> 修訂自身的精度級缺陷，非同一問題反覆）。r5 全部發現已吸收為本版，但**本版未經
> 第六輪覆核、且未達腳本裁定的收斂**。緩解：(1) r5 reviewer 逐點核對確認其餘增量
> 與代碼 ground truth 自洽；(2) 每個歷輪 BLOCKER 都有金樣本機械防線（含 legacy
> fixture 真實形狀規格）；(3) 實作走 kirokb 流程時 spec 對抗輪天然覆核。

> 回答的問題：**要給出更好的統計，一個 agent runtime 到底有哪些東西需要被觀測？**
> 本文件把「觀測什麼」窮舉成**九域**分類法，逐項標注兩條路徑（claude-code 原生 /
> 外部 adapter）現狀與缺口；缺口彙成 gap register 並逐條裁決。
>
> **SSOT 規則**：adapter 輸出 schema 的單一事實點恆為 `adapter-observability-design.md`
> （本文件的 schema 擴展以「v7 amendment」形式列於 §5，落地時追加進該文檔並逐項補
> 配套；該文檔標題改「v6 + a1 amendment」並在其挑戰記錄追加本 loop 出處——「終版」
> 語義由 amendment 節保持誠實）。統計引擎（expstats）新節的權威在本文件 §3。
>
> 鐵律：zero-dep、local-first、確定性、null-not-zero、immutable experiments、
> 誠實揭露（估算恆標 estimate、不可見不猜、不因果）、分母紀律。

## §0 讀法

✅ 已觀測且有消費 · ◐ 已收集但未成統計/未完整收集 · ❌ 未觀測 · 🚫 結構性不可見。
缺口 G-xx → §2。**gate 判別的機械依據**（r2 F-2-04）：seal/stats 層用
`experiment.runtime === 'claude-code'`；run 視圖層用 `run.source !== 'adapter-trace'`
（claude-code 的 run.source 是 JSONL 檔案路徑，**不是**字面量 'claude-code'）。

## §1 九域分類法

### D1 LLM 請求/回應（每輪一次 API call 的兩側）

| 觀測項 | claude-code | adapter | 餵什麼 | 缺口 |
|---|---|---|---|---|
| token 四桶 | ✅ round.usage（串流段取末值） | ✅（缺席保 null，v6） | H、成本、equivTokens、timeline | — |
| context footprint | ✅ | ✅（null 傳染） | 峰值、sparkline | — |
| cache 行為（hit 率、冷暖） | ◐ 可算未成統計 | ◐ | （無） | G-11 |
| context 增量歸因 | ◐ `_attr`：上輪輸出（精確）/工具結果（估算）/注入（**現狀混桶**）/殘差（±，負=compaction 單獨渲染；**正向 cache 位移偽增長不可單獨標出**） | ❌ 無 userEvents 通道 | 逐輪歸因圖 | G-01 |
| context 壓縮事件（compact-boundary） | ◐ JSONL 有此行型，parser 目前丟棄 | 🚫 | （無） | G-01 前置 |
| 首輪基線 | ◐ 總量 + listing 估算；切分 🚫 | 🚫（自述除外） | context insights | G-02 |
| system prompt 內容 | 🚫 | ◐ v6 runtime_info | 自述 diff | G-03 記錄不做 |
| model | ✅ | ✅ | mismatch、pricing | — |
| stop reason | ◐ 已收；**既有消費者：score.js L3 confirm-turn（end_turn 判定）與 otel finish_reason**（r2 勘誤——非「無消費」）；無統計 | ❌ 無欄 | L3 安全鏈、（統計缺） | G-04 |
| text/thinking 長度 | ✅ | ◐ text only | timeline | G-05 記錄不做 |
| 每輪耗時 | ◐ 相鄰輪 ts 差（混合量） | ✅ 自報 | duration | G-12 |
| 工具呼叫耗時（tool_use→tool_result ts） | ◐ 可得未掛 | ◐ 可自報 | 模型 vs 工具時間切分 | G-12 |

### D2 內容載入

| 觀測項 | claude-code | adapter | 餵什麼 | 缺口 |
|---|---|---|---|---|
| skill 觸發 | ✅ | ✅ v6 | 覆蓋率全家 | — |
| SKILL.md body 成本 | ✅ skillBodyCostEst；body 文本同時落 userEvents（G-01 拆桶前置） | ❌ | meanSkillBodyCostEst | G-06 |
| skill listing 成本 | ✅ 估算 | ◐ | insights、trim 建議 | — |
| reference 讀取 | ✅ attributeRead（**已知過度匹配**——§4） | ✅ v6 | refCoverage 全家 | — |
| 檔案 I/O 目標分佈（Read/Write/Edit/NotebookEdit 對象） | ◐ 有路徑無聚合 | 🚫（無命名約定/cwd → n/a） | 「skill 沒被讀時在讀什麼/改了什麼」 | G-07（含寫側 G-14） |
| Glob/Grep | ◐ 目標是模式非檔案——**不入 G-07**（口徑明文） | ◐ | （無） | 記錄不做 |
| runtime 注入文本 | ◐ userEvents 收集但 **三類混桶**：attachment 行、tool_result 旁 text 塊（system-reminder/hook 常走這裡——r2 BLOCKER）、isMeta skill body 都拆不開 | ❌ | harness 稅 | G-08（G-01 前置） |
| 用戶側輸入 | ✅ | ◐ | prompt 顯示 | — |

### D3 工具使用

| 觀測項 | claude-code | adapter | 餵什麼 | 缺口 |
|---|---|---|---|---|
| 工具呼叫全量 | ✅ | ✅ | 計數、P、timeline、env-noise | — |
| 工具分類（skill/agent/mcp/builtin/other） | ◐ 名字機械可分 | ◐ 可自報 | MCP 依賴度 | G-09 |
| permission denial | ✅ | ✅ v6 | 豁免、permissionEvents | — |
| 探針 | ✅ | ✅ | probe 全家 | — |
| 子代理用量佔比 | ◐ 已收且污染 totals 無歸因 | ❌ 無通道 | 側鏈份額 | G-16 |
| 工具結果體積 | ◐ | ◐ | 歸因桶 | 併 G-01 |

### D4 Runtime 自述（權威：adapter-observability-design §4）

（同 v2——invocation 配置 ✅、工具名單 ◐、定義文本/system prompt 全文 🚫。）

### D5 成效與效率

C/P/H · activation · pass@k · 成本（估算 + 自報；**自報成本 CLI stdout ✅ /
session 回填 ◐**——`result` 行被丟，G-15）· wallMs · rounds · env-noise 剔除 ·
**verifier 級結果分佈 ◐**（verifierResults/stepDetail 全量落盤無統計——r2 新列，
併 G-17 statsHealth）· **workspace 產物清單 ❌**（記錄不做，誠實列出）·
repeat 級穩定性（方差 ◐ / 暖化 ◐ / 決定性 ❌ → G-11/G-13）。

### D6 實驗環境

suite sha256 · model · inventory · isolation · captures · runtimeVersion ·
observedSignals · invocation 配置 ✅（allowedTools 已持久化於
environment.suite.params）· cwd/workspaceDir ✅ · context 窗口上限 = 配置假設（§4）。

### D7 執行異常與觀測管線健康

| 觀測項 | 現狀 | 缺口 |
|---|---|---|
| timeout | ◐ 僅 error 字串字面量（無結構化欄——r2） | G-17（前置：rep.timedOut 結構化，lab 一行） |
| 退出碼/stderr | ◐ 收集 + logs | G-17 |
| excluded 原因 | ✅ excludedSignature | G-17（分佈） |
| **env-noise 重試史** | ❌ 成功前的失敗嘗試零痕跡（僅 onProgress 事件）——duration 低估、簽名分佈只見尾部（r2 新列） | G-17（前置：rep.retries=[{attempt,signature,backoffMs}]） |
| multi-step 中止步 | ◐ abortedAtStep | G-17 |
| parse 健康度 | ◐ parseWarnings 無消費 | G-17 |
| API 層重試/限流 | 🚫 兩路徑不可見（§4） | 記錄不做 |

### D8 跨 run/repeat 湧現

repeat 序 × cache 暖化 → G-11；方差/漂移/決定性 → G-13 記錄不做。
側鏈輪的截斷（子代理輸出腰斬）→ **記錄不做**（明文，r2）。

### D9 Service-under-test 生命週期（r2 新增域）

| 觀測項 | 現狀 | 缺口 |
|---|---|---|
| 啟動配置/endpoint/envKeys | ✅ experiment.service meta | — |
| ready 等待時長 | ❌ 可得未收 | G-18 |
| 運行期 stderr / 非正常退出 | ◐ 進程持有未落 | G-18 |
| teardown | ✅ finally 必殺 | — |

## §2 Gap Register（裁決；T1/T2 = 本分類法波次，與 v6 Wave 1/2 對照見 §6 尾）

| id | 裁決 | 要點 |
|---|---|---|
| G-01 | **做（T1）** | §3.1（前置修繕 ×5：userEvents 五類標記、compact-boundary、共用模組、gate、result 行收集） |
| G-02 | 做（T1） | baseline 桶誠實文案（fresh vs 續接 session 兩式——§3.1） |
| G-03/05/13 | 記錄不做 | 不可見/假精度/需獨立統計設計 |
| G-04 | **做（T1 + v7a）** | §3.3；**adapter 自報 stopReason 不參與 score.js L3 confirm-turn（明文豁免——避免無聲行為變更；要參與需另行裁決 + 金樣本）** |
| G-06 | 做（T2 + v7a） | round.skillBodyChars 自報 |
| G-07/14 | **做（T1，claude-code only）** | §3.4 fileTargets |
| G-08 | 做（T1） | = §3.1 injectedHarness 桶（判準修訂——r2 BLOCKER） |
| G-09 | **做（T1 + v7a）** | §3.2 toolUsage |
| G-10/16 | 做（T1；G-10 已併 G-16） | §3.5 sidechainShare（**gate + equivTokens**）+ §3.2 scope.sidechain 桶（兩節共同承載） |
| G-11 | 做（T1） | cacheHitRate + 暖化揭露（footprint=0 防禦——§3.5） |
| G-12 | 做（T2） | toolCall.resultTs 收集 + 工具/其餘時間切分（estimate） |
| G-15 | 做（T1） | selfReport **多 result 行 Σ 語義**（r2 修訂——§3.5） |
| G-17 | 做（T1） | exclusionBreakdown + 重試史 + verifier fail 分佈（statsHealth） |
| G-18 | 做-lite（T2） | service.meta 加 readyMs；非正常退出 → experiment warning + stderr 尾段落 logs；其餘記錄不做 |

## §3 新統計提案（expstats **schemaVersion 3**）

### §3.0 版本與相容性（r2 F-2-07 改裁決）

- **statsresolve A1 增補（修復既有 v1 死路，同時服務 v3）——返回契約釘死（r3
  F-3-02 BLOCKER）**：embedded 有效但 schemaVersion 舊時，`resolveExpStats` 的
  **`stats`/`statsAuthority` 保持完全不動**（embedded 恆權威、byte 不變），新增獨立
  頂層欄位：
  `supplemental: { sections: {…}, authority: 'non-authoritative-recompute',
  schemaVersionFrom, schemaVersionTo }`
  ——sections 只收 **schemaVersion→節名閉集映射表**中高於 embedded 版本的節（v3 節
  鍵**逐字枚舉**（r5 F-5-04）：contextComposition, toolUsage, truncation,
  fileTargets, cacheHitRate, selfReport, sidechainShare, statsHealth——
  exclusionBreakdown 定為 statsHealth 子欄非獨立節）；**embedded 缺 schemaVersion
  欄 → 視同 1**（與 obs.js 既有 no-schemaVersion→v1 慣例對齊，r5 F-5-03；embedded
  v1 金樣本雙形態：顯式 schemaVersion:1 與欄位缺席各一例，斷言 supplemental 節集
  相同），sidecar
  對 v2 既有節的重算差異**不外洩**；`sidecarIgnored` 語義窄化為「權威數字未採用
  sidecar」（supplemental 存在時兩旗標並存）。obs.js 為 supplemental 節**獨立渲染**
  「回填（非权威）」徽章（絕不掛在「权威（封存时计算）」下）。金樣本：embedded v2 +
  sidecar v3 → v2 數字 byte 不變、v3 節帶獨立 authority、v2 重算差異不外洩。
  **「真路徑」範圍限定（r4 F-4-02）**：supplemental 只載**頂層新節**（v3+），v1→v2
  的**節內形狀升級**（caseJoin、bySkill[].refs）不經此機制——v1 實驗的 v2 級特性
  維持現狀 + 文檔誠實聲明「節內升級需重跑」；金樣本補 embedded v1 case。
  **生產路徑接線（r4 F-4-03）**：bin/aiide.js 裁決——embedded 有效但 schemaVersion
  < 當前 → plain `--write` 自動走重算分支（authority 'non-authoritative-recompute'），
  upgradeHint 文案同步；supplemental 提取**只認** authority='non-authoritative-
  recompute' 且 sidecar schemaVersion > embedded 的 sidecar（authoritative-embedded
  byte 副本忽略）。各補金樣本。
- compare/S8：一側缺節 → 佔位、不出 delta。
- 金樣本重錄清單：synthetic-bundle（schemaVersion ×2）、statsresolve（並列供給新
  case）、S8。
- **null 觸發條件表**：contextComposition——runtime 非 claude-code → null（reason
  'no-user-events-channel'）；**tag-presence guard（r4 F-4-01 / r5 F-5-01 改謂詞）：判別依據 = run 級
  parse 時刻版本標記**——新 parser 在 run 上寫 `userEventsTagVersion`，五類標記放
  **新欄 `srcKind`**（不覆用 `kind`：舊 parser 產物**已帶** kind:'user'/'attachment'，
  兩值恰在五類值域內，「事件缺標記」謂詞對 legacy run 永假——r5 勘誤；新欄缺席才是
  結構性可偵測事實）。run 缺 `userEventsTagVersion` → 跳過 + 揭露（reason
  'untagged-legacy-run'），全部 run 未標記 → 整節 null——五類是 parse 時刻資訊
  （tool-result-side 需訊息結構、meta-injected 需 isMeta 旗標，事件層不可重建），
  絕不回填混桶數字。**legacy fixture 規格釘死**：必須含 kind:'user' 且文本為
  system-reminder 混合文本的事件，斷言該 run 被跳過且該事件絕不入 injectedUser；
  toolUsage——valid runs 即可知
  （零呼叫 = 0 合法）；truncation——全輪 stopReason null → null；fileTargets——cwd
  缺 → null；cacheHitRate——usage 全缺 → null；sidechainShare——非 claude-code
  runtime → null（'no-sidechain-channel'），claude-code 且無側鏈才是 0；
  **selfReport——run 無 result 行記錄 → null（reason 'no-result-lines'；舊封存 run
  恆 null，絕非 0——r4 F-4-04）**；exclusionBreakdown——excludedSignature/
  abortedAtStep 分佈恆可知；**timeoutRate 與重試史子欄在 rep 缺結構化欄位（舊實驗）
  時 null + legacy 揭露計數，絕不以 error 字串或 0 回填（r4 F-4-08）**。
  金樣本：v2 時代封存 run 回填 → contextComposition null/降級（非混桶數字）、
  selfReport null、timeoutRate null。

### §3.1 contextComposition（G-01/02/08，claude-code only）

語義：「**最終 context 視窗的增量組成**」——非成本視角（cost-weighted 變體記錄
不做；文案禁用「token 花在哪」）。

- **前置修繕**：
  (a) parser userEvents 帶來源標記——**五類，判定序唯一命中（r3 F-3-03）**：
  `skill-body`（isMeta+sourceToolUseID）→ `tool-result-side`（同訊息含 tool_result
  的 text 塊——system-reminder/hook 主通道）→ `attachment` → `meta-injected`
  （**isMeta 無 sourceToolUseID**——caveat/命令注入等，併入 injectedHarness 桶）→
  `user`（其餘純用戶行）。金樣本：isMeta 無 sourceToolUseID 行不入 injectedUser；
  (b) compact-boundary 收集機制釘死：parser 收為 **run 級事件 {ts}** 並按**行序**掛
  `compactBefore:true` 給其後第一個新建的**同 isSidechain 域** round（主 boundary →
  主 round；「新建」= 該 requestId 首個 segment 行——r3 F-3-06；檔尾 boundary →
  只計 run 級計數）。金樣本：boundary 後先側鏈後主 round 的交錯 JSONL，斷言
  compactBefore 落主 round；
  (e) **parser 收 result 行 → `run.selfReports[]` 陣列**（保留欄位集
  total_cost_usd/num_turns/duration_ms/is_error 原名——G-15 的載體，r4 F-4-04）；
  (c) `computeRunItems` 抽到 **web/obs.js**（依據：obs.js 已被 test/web-obs.test.js
  以 node --test 直接 import，Node ESM 相容已證——r2 刪除懸空的「NUL 實測」聲稱），
  expstats import 同一份（src→web 依賴方向 encode-in-code）；恆等式金樣本；
  (d) gate 依 §0 判別（experiment.runtime / run.source——不用不存在的字面量）。
- **桶**：firstRoundBaseline（文案兩式：fresh session ≈「system prompt+工具定義+
  listing，不可切分」；續接 session「含前史」——run.meta.experimentId 有無切換，r2）
  · prevOut（精確）· toolRes（估算）· injectedUser（**僅純用戶行**）· injectedHarness
  （attachment + tool-result-side + **meta-injected**——r4 與 (a) 判定序對齊；
  **harness 稅在此**；文案注明含 reminder/hook 的混合文本，估算；金樣本斷言
  meta-injected 事件**入 injectedHarness**，不只「不入 injectedUser」）
  · skillBody（單一 chars 來源）· residualPos（未歸因，含 cache 位移）
  · compaction（負殘差；有 compactBefore 標記 → 'compaction-confirmed'、無 →
  'compaction-inferred'；**永不與正殘差淨加總、永不入佔比分子**）。
- 聚合：per-run 佔比的**分母 = baseline + Σ正桶**（r3 F-3-04：「增量組成」的自洽
  分母——含 compaction 的 run 下若用末輪 footprint 作分母，被壓縮逐出的增量仍在分子
  → 佔比合計必 >100%；改此分母後 Σ 恆 = 100%）；末主輪 footprint 另列為峰值欄；
  compaction 以絕對量 + 對分母比例獨立揭露。**footprint=0 的 run 跳過 + 揭露計數**；
  輪級 footprint=0 → skippedRounds。均值 ± 分佈 + n + 最大貢獻 run。金樣本：含
  compaction run 的桶合計 = 100% + compaction 獨立欄。
- 整節恆標 estimate。

### §3.2 toolUsage（G-09/16）

（結構同 v2。）r2 修訂：

- **builtin 判定來源（r3 F-3-01 BLOCKER 反轉）**：**版本化 builtin 常數集為唯一
  分類源**（隨 aiideVersion 揭露）。`allowedTools` **不作分類源**——它是權限白名單
  非工具全集（headless 下唯讀工具不列入也自動放行，典型 suite 只寫 ['Bash']，照它
  分類會把成功的 Read/Glob 全打成 other），且含 `Bash(git:*)` 帶參數 specifier 需
  剝離後才可比對；至多作補充標記（常數外且出現在剝離後 allowedTools 的名稱可標
  'suite-allowed'）。§4 揭露「builtin/other 邊界隨 aiide 版本演化，跨版本 compare
  需對齊」。金樣本（反例）：**allowedTools=['Bash'] 的 run 中成功 Read 仍歸 builtin**。
- **口徑對帳句**：`byKind.skill.main` === 觸發統計掃描面（extractTriggers 主 rounds）
  ——金樣本鎖等式；scope.sidechain 桶明文「僅 toolUsage 計側鏈，觸發/截斷/M7 統計
  均主 rounds only」。
- errors = classifyToolResult==='error'（denial 另計）；kind 自報值域外 → 'other' +
  warning；mcp server 切分 = 去 `mcp__` 前綴後**至最後一個 `__`**。

### §3.3 truncation（G-04）

（同 v2：分母 = 主 rounds 中 stopReason 非 null；unknownStopReason 揭露；
truncatedRoundShare + finalRoundTruncated 分開；未知值保留原值。）r2 增補：
**adapter 自報 stopReason 只進本節統計，不參與 score.js L3 confirm-turn**——
**豁免機制釘死（r5 F-5-02）**：normalization 把 adapter 自報值放**獨立欄
`round.declaredStopReason`**、`round.stopReason` 對 adapter 保持 null → score.js
的兩個讀點（isConfirmTurn 與 gradeSafety 內聯 confirmIdx 掃描）**零改動**即結構性
豁免；truncation 統計讀 `declaredStopReason ?? stopReason`。金樣本：adapter run 帶
stopReason='end_turn' + must_confirm_before case → gradeSafety 判定與缺席時 byte
相同；abortedAtStep/timeout 的 run 其「末主輪」= 實際最後一個主 round（語義照舊，
不特判——這類 run 的截斷訊號本就該與 D7 異常統計交叉讀）。

### §3.4 fileTargets（G-07/14，claude-code only）

- scope：Read（讀）/ {Write, Edit, NotebookEdit, MultiEdit}（寫——**工具集為常數 +
  工具→路徑欄位映射**：Read/Write/Edit/MultiEdit → file_path；NotebookEdit →
  notebook_path（r3 F-3-07——score.js 已有三備援先例）；路徑欄位缺失的呼叫 → 揭露
  計數 pathless，不入三桶；金樣本含 NotebookEdit）；Glob/Grep 不入。
- 桶（全劃分）：{skill-refs, workspace, other-absolute}。**相對路徑按 run.cwd resolve
  後走同一判定序**（r2：cwd 在手時相對即可解析，原 relative-unresolvable 桶刪除）。
- 判定序：先 cwd 前綴（**歸一化：正反斜線 + win32 casefold + 盤符大小寫**，r2）→
  workspace；再 SKILL_READ_RE → skill-refs；其餘 → other-absolute。金樣本：
  `d:/` 混寫命中 workspace；workspace 內 `skills/foo/` 產物歸 workspace。

### §3.5 小型統計

- **cacheHitRate**：逐輪 cacheR/footprint（**footprint=0 輪不入分子分母 + 揭露**，
  r2）→ run/實驗均值 ± 分佈；repeat 序 × cacheR 描述表。
- **selfReport（G-15）**：**多 result 行 Σ 語義**（r2 BLOCKER 級修訂）：
  `{ invocations: n, total_cost_usd: Σ, num_turns: Σ, duration_ms: Σ, is_error: any }`
  ——scripted-reply resume 的每個 result 行報自身增量（mergeInvocationMetrics 註釋
  明文 last-win/first-win 皆錯）；金樣本雙 result 行 JSONL + 與 stdout 路徑對帳。
- **sidechainShare（G-16）**：tokens/toolCalls 份額直接從 run.sidechains 推；
  **cost 份額以 equivTokens 計**（權重恆定、不依賴 pricing 佈線——r2：expstats
  loader 丟 metrics 且無 pricing 輸入，equivTokens 繞開且更確定性）；gate 見 §3.0。
- **exclusionBreakdown / statsHealth（G-17）**：excludedSignature 分佈 + timeoutRate
  （**前置：rep.timedOut 結構化欄**，不靠 error 字串，r2）+ abortedAtStep 分佈 +
  Σ parseWarnings + **重試史聚合**（前置：rep.retries，retriedThenSucceeded 計數，r2）
  + **verifier fail 分佈**（哪個 verifier 最常紅、abort 集中在哪步——rep.verifierResults
  已在盤上，r2）。

## §4 誠實邊界

- claude-code：system prompt 全文、首輪切分、工具定義文本、API 重試/限流、串流內部
  時序——結構性不可見。
- context 窗口上限 = 配置假設（硬編碼 200k）。
- attributeRead `skills/<name>/` 過度匹配 = 已知污染（fileTargets 判定序局部修正
  呈現面，引擎不隨本波改動）。
- **builtin/other 邊界隨 aiide 版本演化**（allowlistSource + version 隨附，跨版本
  compare 需對齊——r2）。
- injectedHarness 含 tool_result 旁混合文本（估算）；殘差正負永不互抵；estimate 恆標。
- 觀測 ≠ 因果。

## §5 v7 amendment 清單（落回 adapter-observability-design.md，帶 v6 式配套）

| 欄位 | 值域/未知值 | near-miss | 金樣本 | 矩陣行 | 其他 |
|---|---|---|---|---|---|
| round `stopReason` | 已知集參考表；未知保留原值 | 加清單 | 缺席→truncation n/a | expstats truncation + **score.js（L3 豁免明文）** | 缺席判定 = 逐輪掃描，**不擴 observedSignals 旗標**（r2 裁決） |
| toolCalls `kind` | 閉集；值域外→'other'+warning | 加清單 | declared/inferred 混合 | toolUsage | — |
| round `skillBodyChars`（T2） | 非負整數；非法→null+warning | 加清單 | 自報 body 點亮 | insights | — |
| **statsresolve A1 擴 cell**（r3 F-3-05） | embedded valid + schemaVersion 舊 → supplemental 並列供給（契約見 §3.0） | — | embedded byte 不變/差異不外洩 | statsresolve + obs.js supplemental 徽章 | **v6 §3 矩陣 statsresolve 行改寫**（原「A1 決策表不變」將成錯誤事實——必須同步） |

落地形式：v6 文檔加「a1 amendment」節 + 標題註記 + 挑戰記錄追加本 loop 出處。

## §6 Challenge loop 記錄

| round | reviewers | new B/M/m | 裁決 |
|---|---|---|---|
| 1 | completeness-hunter + honesty-feasibility-skeptic | 7/15/9 | 八域化（+D7 異常/D8 湧現）；G-01 語義重訂（增量組成非成本/殘差不淨加總/per-run 均值/gate/拆桶前置）；G-06/G-10 改裁決；G-11~17 新缺口；schemaVersion 3 + SSOT + amendment 配套；多處現狀勘誤 |
| 2 | 新 spawn full-spectrum | 2/10/8 | sidechainShare gate（adapter 絕不灌 0）；injected 三類拆桶（tool-result-side 通道——harness 稅判準修正）；stopReason 消費者勘誤 + L3 豁免；gate 判別修正（run.source 非字面量）；builtin allowlist 雙源 + 漂移揭露；relative 桶刪除（cwd resolve）；**A1 增補非權威並列供給（修 v1 死路）**；compact-boundary 機制釘死；D9 service 域 + 重試史 + verifier 分佈；selfReport Σ 語義；sidechainShare cost 走 equivTokens；win32 歸一化；timeoutRate 結構化前置 |
| 3 | 新 spawn final check | 2/4/1 | **builtin 分類源反轉**（allowedTools 是權限白名單非工具全集——常數集為唯一分類源 + 反例金樣本）；**A1 supplemental 返回契約釘死**（獨立頂層欄位、閉集節映射、v2 差異不外洩、獨立徽章）；userEvents 五類 + 唯一命中判定序（meta-injected 併 harness）；聚合分母改 baseline+Σ正桶（含 compaction run 合計恆 100%）；amendment 表補 statsresolve 行（v6 矩陣同步義務）；compact-boundary 限同 isSidechain 域 + 「新建」定義；fileTargets 工具→路徑欄位映射 + pathless 揭露 |
| 4 | 新 spawn convergence verification | 1/3/4 | **tag-presence guard**（五類標記是 parse 時刻資訊，舊封存 run 不可重建——untagged run 跳過 + 揭露，絕不回填混桶數字）；「真路徑」限定 v3+ 頂層新節（v1→v2 節內升級誠實聲明需重跑）；supplemental 生產路徑接線（bin/aiide.js plain --write 對 stale-schema 自動重算 + 提取只認 non-authoritative-recompute）；selfReports[] 載體釘死 + null 表補行；exclusionBreakdown 子欄 legacy null 規則；G-01 五類勘誤、injectedHarness 桶含 meta-injected、G-10 併 G-16 注記。**Reviewer 同時確認：r3 全部裁決經代碼核對成立、D7/D9 現狀與 lab.js 逐行相符、聚合分母數學自洽** |
| 5 | 新 spawn final dry-round check | 1/2/2 | **guard 謂詞改 run 級版本標記**（r5 BLOCKER：舊 parser 產物已帶 kind:'user'/'attachment' 且兩值在五類值域內——「事件缺標記」永假；改 `userEventsTagVersion` + 標記放新欄 `srcKind`，缺席才結構性可偵測；legacy fixture 真實形狀規格釘死）；**L3 豁免機制釘死**（adapter 自報值放獨立欄 declaredStopReason，score.js 兩讀點零改動結構性豁免 + byte-same 金樣本）；embedded 缺 schemaVersion 欄視同 1（雙形態金樣本）；v3 節鍵逐字枚舉（exclusionBreakdown 定為 statsHealth 子欄）。**Reviewer 同時確認：其餘 r4 增量與 statsresolve/bin/lab 逐點自洽、web/obs.js Node import 依據成立、v6 矩陣同步義務一致** |

**T-波次與 v6 Wave 對照**：T1（引擎統計 + parser/lab 前置修繕 + stopReason/kind
amendment）；T2（工具耗時、skillBodyChars、service 生命週期 lite）。T1 與 v6 Wave 1
可先後任意；T2 依賴 v6 Wave 1 schema 機制。
