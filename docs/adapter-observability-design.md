# Runtime 觀測性契約（adapter observability contract）— 設計稿 v6 + a1 amendment
（5 輪 challenge：r1 4B+12M+9m / r2 3B+16M+12m / r3 2B+6M+6m / r4 1B+5M+3m /
r5 1B+2M+4m，共 11 BLOCKER + 41 MAJOR + 34 MINOR 全數吸收；記錄見 §9）

> **誠實終局聲明（loop-20260711-251f2a52，verdict = max_iter）**：5 輪硬頂已到、未達
> 乾涸輪。BLOCKER 軌跡 4→3→2→1→1 逐輪衰減且逐輪換面（r5 為 denialKind 語義精度級）。
> r5 全部發現已吸收為本版，但**本版未經第六輪覆核**。緩解：(1) r5 reviewer 同時確認
> v5 增量無新矛盾、全文交叉引用一致；(2) §5.3 金樣本清單對每個歷輪 BLOCKER 都有機械
> 防線，實作期即可暴露殘餘錯誤；(3) 實作走 kirokb 流程時 spec 對抗輪天然覆核。

> 目標：標準化「一個 agent runtime 要提供什麼觀測訊號，才能完整接入 aiide 平台」——
> 訊號契約 + 開發者文檔 + 機械驗證器 + runtime 自述（system prompt / 工具清單）觀測。
> 鐵律：zero-dep、local-first、確定性可重現、null-not-zero、immutable experiments、
> 誠實揭露（不灌零/不假滿分/不因果捏造）、分母紀律。

## §0 Ground truth：現狀訊號→統計對照（同 v2，勘誤已入）

（表同 v2 §0——attributeRead 為 `skills/<name>/` 前綴任意檔；env-noise 不依賴 trace。）
核心矛盾：activation 認 adapter 的 round 級 `skill` 宣告，覆盖率统计全家只認 Claude Code
工具事實——同一「觸發」概念兩套口徑。

## §1 能力模型：觀察訊號旗標集合（非線性等級）

機器狀態 = `experiment.environment.observedSignals`：

```jsonc
{ "trace": 9, "usage": 9, "triggers": 9, "refReads": 9,   // 值 = valid run 數（見量詞表）
  "inventory": true, "runtimeInfo": true }
```

**量詞表（r2 F-2-02 / r3 F-3-02/05/06/12 修訂；讀取表面 = normalized run + rep 記錄）**：

| 旗標 | 分母 | claude-code 路徑 | adapter 路徑 |
|---|---|---|---|
| trace | run 級（valid bucket flatMap runs） | JSONL 解析成功（runId 非 null） | `trace` 欄非空 |
| usage | run 級（同上） | **先驗恆真：存字面量 `'a-priori'`（F-4-04 型別釘死——parser 零骨架使逐 run 計數無意義；F-3-06 裁決 b）** | 任一輪帶 `usage` 欄（normalization 保缺席） |
| triggers | run 級（同上） | 任一 Skill toolCall（**僅主 rounds，與 extractTriggers 同口徑**——F-4-09） | 任一輪出現**顯式 `triggers` 欄**（含空陣列——absent ≠ []；attributionSkill 折入不算通道證據，F-3-05） |
| refReads | run 級（同上） | 任一 skills/ 前綴 Read toolCall | 任一輪出現 `refReads` 欄（含空陣列） |
| inventory | **rep 級（任一非 excluded rep，不經 resolveReps bucket——F-3-02：completion-only 的 noSession rep 也攜此欄）** | snapshot 成功（恆真於正常 seal） | 任一非 excluded rep 攜非空 `skills_inventory` |
| runtimeInfo | rep 級（同上） | version 可得（部分：prompt/tools 恆 null） | 任一非 excluded rep 攜 `runtime_info` |

- run 級旗標的 valid 判定復用 `resolveReps` 的 valid bucket 並 **flatMap runs**（rep 級
  bucket → run 計數的展開明文，F-3-12；multi-step 金樣本：3 步僅 1 步帶 usage 驗計數）；
  resolveReps throw 或 runs 不可載 → 量詞記 **null（不可知）絕非 0**。與 stats 解耦僅指
  buildExpStats 內部拋錯不影響本欄。**封存型別（F-4-04）**：run 級旗標 =
  `number | null`，usage 額外允許字面量 `'a-priori'`（claude-code 恆用）；inventory/
  runtimeInfo = `boolean`。型別 union 入 §6.3 鍵映射表，金樣本鎖兩側封存 bit。
- **兩個分母正式命名**（F-3-11）：run 級 = 「coverage-valid runs」（resolveReps valid
  bucket flatMap）；rep 級 = 「non-excluded reps」（只排 excluded，含 noSession/
  completion-only）。§6.3 對照表收錄，全文交叉引用用正式名。
- claude-code 側量詞計**觀察到的事件**（能力先驗已知）；adapter 側計**通道存在性**。
  「usage 全 0 vs 缺席」金樣本只適用 adapter 路徑（claude-code parser 保零骨架，兩者
  封存 bit 相同——已知限制，§6.3 記錄）。
- 文檔敘事保留四步升級路徑（completion → +trace(+cost) → +semantics → +self-descriptor），
  僅作章節導航，無機器狀態、無累積約束。
- claude-code 參考實現：inventory=snapshot；runtimeInfo 部分（version ✅，
  systemPrompt/tools 不可見 → null；不從 tool_use 用量反推工具庫存）。

## §2 Adapter 輸出 schema 擴展（全部選填、加法式、無版本欄）

```jsonc
{
  "result": "...",                          // 既有，必填
  "total_cost_usd": 0.012, "runtime_version": "2.1.0",   // 既有
  "observability": ["trace","usage","triggers","refReads","skills_inventory","runtime_info"],
                                            // 自聲明：值 = schema 欄位原拼寫（F-2-29）；僅用於對帳警告
  "skills_inventory": { "my-skill": { "versionSha": "…", "refs": ["my-skill/references/api.md"] } },
  "runtime_info": { … },                    // §4
  "trace": [
    { "text": "…", "skill": "…", "durationMs": 1200, "usage": { … },
      "toolCalls": [ { "name": "…", "input": {…}, "result": "…", "isError": false,
                       "denialKind": null } ],
      "triggers": ["my-skill"],
      "refReads": [ { "skill": "my-skill", "ref": "my-skill/references/api.md",
                      "status": "ok" } ] }   // status: 'ok'（預設）| 'blocked'
  ]
}
```

### D1 normalization（buildRunFromTrace）

- `triggers`/`refReads` → Run model 第一類通道 `round.declaredTriggers` /
  `round.declaredRefReads`（不採 pseudo-toolCall；**只在顯式欄位出現時設值**）。
- **round 級 `skill` 欄折入宣告口徑——在消費端做，不在 normalization 做**（r3 F-3-04/05
  改裁決）：`s.skill` 照舊只映射 attributionSkill；`collectSessionEvents` 對
  `run.source === 'adapter-trace'` 的 run 把 `round.attributionSkill` 視同該輪宣告
  trigger（集合去重由 first-occurrence 處理）。理由：舊 run 檔（runs/*.json 已封存）只有
  attributionSkill，消費端折入使**回填舊 adapter 實驗與新跑口徑天然一致**（normalization
  折入會讓回填恆 0、新跑全亮的分裂）；且 declaredTriggers 通道維持「顯式欄位」純度，
  observedSignals.triggers 不被折入捏造能力證據。既有 adapter 零改動即點亮覆蓋率。
  **primary/aux 重算點（F-4-02 釘死）**：折入事件進 first-occurrence 合併流後，
  `collectSessionEvents` **內部重算 primarySkill/auxiliarySkills 並覆蓋回 record**；
  `extractTriggers` 維持純顯式通道（Skill toolCalls + declaredTriggers 合併序），不做
  source 分流。金樣本：僅 attributionSkill 的回填 run，primarySkill === triggerSet[0]。
- **usage 缺席保真**（F-2-03 / r3 F-3-01/03）：adapter round 無 `usage` 欄 →
  `round.usage = null`、contextFootprint = null。**消費端 null-guard 全鏈入消費者矩陣**：
  metrics.js（totals/perSkill 跳過 null usage；contextSeries 保 null；peakContext 全
  null → null，**不許 Math.max(0,…) 把 null 強轉 0**）、equivTokens null 入口。
  **H gate = 「任一輪 usage 非 null 且 peakContext > 0」**（F-3-01：只判非 null 會對
  全零 usage 產出 margin=1 的假滿分——比現狀更糟的形態）。金樣本：「usage 全 0（非
  null）→ H 仍為 null」、「usage 缺席輪的 adapter rep 不得變 error rep」、「全 0 vs
  缺席不同封存」（adapter 路徑）。
- `denialKind`（**r5 F-5-01 BLOCKER 改裁決**）：**非空字串一律保留原值，絕不降 null**
  ——classifyToolResult 的語義本就是「非 null 即 denial」；降 null 會把外部 runtime 的
  拒絕事實反轉成成功讀取（灌覆蓋率分子、blocked 豁免與 permissionEvents 消失、safety
  語境誤判 executed-without-ask）。閉集（'user-rejected' 等現值，存單一常數）**僅供
  §6.3 顯示與 near-miss lint**；check 對未知值 = warning、fatal 只留結構性錯誤（非
  null 非字串）。文檔建議 denial 事件同時帶 isError:true 作縱深。金樣本：未知
  denialKind 的 Read 不入 readSet、入 artifactReads 豁免、permissionEvents 含該事件。

### 順序 / 時序語義

- `triggers`/`refReads` 順序有效、必須報在實際發生的那一輪（批次塞首輪 = 違約，歸
  §5 誠實條款）。
- 合併排序（餵 triggerSet/readSet/primary/caseJoin/misroute）：**輪序 → 同輪內工具
  事實先於宣告 → 宣告內部 declaredTriggers 陣列序先、折入 attributionSkill 殿後
  （F-5-03：顯式宣告優先於 round 級歸因欄）**。primary = 合併排序後的**首個 trigger
  事件**（F-2-16——不論來源）。金樣本：同輪混合、跨輪混合、同輪 declaredTriggers +
  attributionSkill 值不同（primary 取 declaredTriggers[0]）三個 case。
- **collectSessionEvents 輸出形狀（F-2-04 釘死）**：
  - `triggerSet`/`readSet`：合併工具事實 + 宣告（集合語義，first-occurrence 按合併序）。
  - `triggerEvents`/`readEvents`（ordinal 軸）：**維持純工具事實**——宣告事件永不出現
    在任何 ordinal 列表（金樣本鎖定）；平行不變量放寬為 triggerSet ⊇ triggerEvents.ids
    並在註釋/測試中明文。
  - 新增 `declaredEvents: [{kind:'trigger'|'read', skill, ref?, status?, round}]`（無
    ordinal）——timeline 顯示（「自报」徽章、掛輪邊界）與 declaredBlockedRefs 的載體。
  - blocked 宣告 read 不入 readSet，經 `declaredEvents(kind:'read',status:'blocked')`
    → buildExpStats 併入 artifactReads 豁免（F-2-31 接線點）。
- **M7 proximity：宣告事件不進事件軸**（合成 ordinal = fabricated precision）。
  proximity 消費點只吃三個既有 ordinal 陣列；`stats.proximity` 增
  `axesOmitted: [{axis:'skill'|'ref', reason:'declared-events-have-no-ordinal'}]`
  作 n/a 的機械槽位。

### provenance（r2 F-2-01 重構：按 run 來源判，不按通道形狀判）

- **整條 adapter trace 都是自報**——trace 內嵌 name:'Skill'/'Read' 的 toolCall 與宣告
  欄同一信任級。provenance = f(run.source)：
  `'harness-observed'`（claude-code session JSONL）| `'adapter-reported'`（一切經
  adapter stdout 進來的訊號）。**信任論證的準確措辭**（F-3-14）：JSONL 由「與 skill/
  adapter 作者無關的參考 runtime」序列化、harness 獨立解析——**不是**「harness 掌握
  日誌」（日誌生產者是 claude 進程本身）；已知限制：upgrade 場景測新版 CLI 時日誌
  生產者恰是受測物，§6.3 誠實揭露此弱化。
- 一個實驗一個 runtime → **實驗級單值** `experiment.stats.provenance`，無 mixed
  （F-2-09 尺度問題隨之消解）。讀取端對 legacy stats（無此欄）按 exp.runtime 推導
  （claude-code → harness-observed）。
- **可比性規則（F-2-21 修訂）**：compare/upgrade 的覆蓋率家族 delta 標「口径不同
  不可比」**當且僅當恰一側為 adapter-reported**；null/缺欄與 harness-observed 同口徑
  （legacy claude-code 實驗不受誤傷）。金樣本：legacy-vs-new claude-code 對照可比。
- 徽章：adapter-reported 下，覆盖率面板 + depgraph 治理級建議卡（merge/split 候選）
  渲染「基于 runtime 自报信号（adapter-reported）」。**機械接線點（F-3-07 / F-5-05
  修訂）**：provenance 由 `collectSessionEvents` **自身**依 run.source 計算（單一事實
  點——它本就持有 run；「呼叫端標」會漏 expstats 三個呼叫點之一）；`depgraphReport`
  輸出 `provenanceMix: {harness: n1, adapter: n2, unknown: n3}`（缺欄 record 入
  unknown，不混入任一信任桶），任一 adapter session 存在 → 治理卡渲染徽章。upgrade
  混合池金樣本鎖定 provenanceMix 呈現（含 unknown 桶）。
- **反作弊誠實條款**：自報訊號不可防偽，契約以揭露應對。合理性 lint（seal warning）：
  宣告 trigger ∉ skills_inventory 鍵集；refReads.skill 與 ref 前綴不一致；單輪宣告
  trigger 數 > skills_inventory 鍵數——**三條均以 inventory 為分母，inventory 缺席 →
  整組跳過（不 warning 不 info，F-2-08/25：不可知不當 0 用）**。
- dissent 記錄：若未來出現 harness 可驗證子集的混合 runtime，再引入細粒度 provenance。

### ref 命名空間

`refReads[].ref` 必須 `<skill>/references/<relpath>` 且 skill 欄與前綴一致；inventory
refs 必須以 `<該鍵 skill>/references/` 開頭（check = fatal；seal = warning）。清單外
read 照收（分子可超集）。宣告制無 _shared 語義：**adapter-declared 清單中含 _shared/
的 ref 行不套 'shared-hash-namespace' 理由**（F-2-13；bytes 本就 null，行級 reason 見
§3）。SKILL.md/_shared 是兩口徑已知差異（宣告側只有 references/ 命名空間），記 §6.3。

## §3 清單與持久化鏈路

**rep 級持久化 + seal hoist（F-2-14/18/19 定點）**：
- `buildRepeat` 凡 `res.output` 存在即把 `rep.skillsInventory` / `rep.runtimeInfo`
  （runtime_info 掛指紋形式）照掛——**含 completion-only / failedRepeat 分支**（no-trace
  + self-descriptor 是合法組合）。
- `runMultiStep` 聚合：兩欄各取 `stepReps.map(...).find(Boolean)`（仿 runtimeVersion
  既有模式，F-2-06/20）。
- journal 行天然攜帶 → resume 的 cached rep 不丟訊號。
- **seal hoist——執行點釘死（F-3-08 / r5 F-5-02）**：hoist、**observedSignals 的
  rep 級旗標、driftDigest 三者在同一點、剝除之前**計算，全部在 `scoreTask` 呼叫
  （lab.js:951）**之前**對 `repsByTask` 做（journal 已於 line 929 寫入原樣，不受影響）
  ——旗標讀的正是將被剝除的欄位，時點錯置會恆得 false 的錯誤封存。hoist 迭代序**限定
  non-excluded reps**（僅 excluded rep 攜 inventory → 不 hoist + warning，維持不可知
  不灌值）；按 task×repeat 固定迭代序取首個非空 →
  **`experiment.environment.skillsInventory`（唯一封存副本）** 與
  `experiment.environment.runtimeInfo`；剝除採 **map 出新 rep 物件替換陣列元素**
  （不就地 delete——rep 引用被 tasksForStats 共享）。金樣本：封存檔內不出現 per-rep
  副本、experiment 與 journal 行的欄位差異對照；「中斷後 resume 全 cached」封存等價；
  「僅 excluded rep 攜 inventory → environment 缺席 + observedSignals.inventory=false」。
- 漂移偵測：比對**全部攜帶該欄的非 excluded reps（rep 級，不經 resolveReps bucket
  ——F-3-11 正式名 non-excluded reps）**；excluded rep 的差異降 info。**drift 的載體
  與可重現性（F-3-09）**：warning 進 experiment.warnings（封存時一次性計算）；同時在
  environment.skillsInventory 旁存 `driftDigest`（各 non-excluded rep 該欄的 sha 清單）
  ——回填/審計可機械重驗，不依賴已刪的 journal。
- 大清單場景（>50 refs）優化（rep 掛 sha、首見落 header）記為未來項，本輪不做。

**inventoryStatus 閉集**：`'snapshot' | 'adapter-declared' | 'external-runtime' |
'none-backfill'`；權威階 snapshot > adapter-declared > 不可知。

**消費者矩陣（每行機械改動點 + 金樣本）**：

| 消費者 | 改動 |
|---|---|
| expstats refCoverage | 顯式 `adapter-declared` 分支：有分母（同 snapshot 的 bySkill 構造）、**頂級 refMeta:null、每 ref 行 bytes:null、行級 reason:'adapter-declared'**（F-2-22：絕不落 `{}` 假可知）；不許 fall-through；reason 值域擴張記入 §6.3 |
| expstats artifactReads | 併入 declaredEvents 的 blocked read（F-2-31）；宣告口徑下未读清單措辭「未见读取（自报口径，无法区分被拦/未尝试）」，不用「死重候选」定性 |
| **metrics.js / score.js**（F-3-03/F-4-01/F-5-04/06） | **僅 token/cost 累加跳過 null usage；toolCalls/toolErrors/durationMs 照計**（F-5-04：整輪 continue 會錯改 toolErrRate→P）；contextSeries 保 null；peakContext **無任何非 null footprint（含空序列）→ null**（F-5-06；不許 Math.max(0,…) 強轉）；equivTokens null 入口 guard；H gate = peakContext(null-guarded) > 0（F-4-08 防禦性冗餘註記；claude-code 行為恆等）；**detectActivation 增讀 round.declaredTriggers**（F-4-01：activation 事實源必須 ⊇ 覆蓋率 triggerSet）；金樣本「usage 缺席輪 rep 不得變 error rep」+「usage 缺席輪帶 isError toolCall → toolErrRate 仍計」+「triggers-only adapter → activated=true 且 triggerSet 亮」+「零輪 run peakContext=null」 |
| **expstats proximity**（F-4-09） | stats.proximity 增 axesOmitted 槽位（§2）；金樣本：含宣告事件的 run 其 proximity 輸出帶 axesOmitted 且宣告事件不在任何軸 |
| **web/index.html run 詳情視圖**（F-4-06） | context sparkline 與峰值卡對 null footprint/peakContext 容錯（null 輪跳點或「未上报」占位）；§8 playwright 冒煙納入此斷言 |
| **depgraph 治理卡**（F-3-07） | collectSessionEvents 輸出 provenance 欄；depgraphReport 輸出 provenanceMix；任一 adapter session → 徽章；混合池金樣本 |
| buildExpStats 輸入 | seal 傳 `refInventory` 來源：snapshot 或 environment.skillsInventory（轉換函數同構） |
| web/obs.js | **三個機械點**（F-2-23）：(1) shippedKnown 判定 status ∈ {snapshot, adapter-declared}；(2) sharedReads/nonSnapshot 分支同步——adapter-declared 走可知分母，清單外自報讀取以獨立計數暴露（「另有 k 笔清单外读取（自报）」）；(3) expSkillDetailRows.refsNote 分支補 adapter-declared 解釋文案 |
| web/index.html | **獨立矩陣行**（F-2-23）：覆盖率面板徽章「清单由 adapter 自报（未经 harness 快照核验）」、分母三態文案擴 adapter-declared、timeline 宣告事件「自报」徽章；（wave 2）環境卡 runtimeInfo |
| bin/aiide.js stats 回填 | 三段判定：`exp.environment.skillsInventory` 非空 → 'adapter-declared'（清單即從此欄取，轉 refInventory 傳 buildExpStats——F-2-18 唯一讀取源）；exp.runtime !== 'claude-code' → 'external-runtime'；否則 'none-backfill' |
| statsresolve | **A1 決策表擴一 cell（T1-S5 已落地，taxonomy r3 F-3-05——原「決策表不變」自此改寫）**：embedded 有效但 schemaVersion 舊（缺欄 ≡ 1）+ sidecar wrapper authority='non-authoritative-recompute' 且其 stats.schemaVersion 更高 → 返回值增獨立頂層欄 `supplemental: { sections, authority, schemaVersionFrom, schemaVersionTo }`（sections 只收 SCHEMA_SECTIONS 閉集中高於 embedded 版本的節；v2 既有節重算差異不外洩）；`stats`/`statsAuthority` 完全不動，`sidecarIgnored` 窄化為「權威數字未採用 sidecar」（與 supplemental 並存）。provenance/observedSignals 仍是 stats/environment 內容，非 wrapper 層 |
| report.js | 覆蓋節 footer 顯示 provenance；不可比規則（§2）；（wave 2）runtime_info diff 節——**明列工作項：動態節編號重排 + RENDER/md 三處同步 + upgrade-report 金樣本重錄**（F-2-30） |
| otel.js export | 宣告事件本波不導出（span=真實呼叫），代碼 TODO + 文檔記錄 |
| Run 方言契約測試 | golden：JSONL 與 trace 等價輸入經 collectSessionEvents 產出同構事件記錄，**範圍限定 references/ 命名空間**（F-2-31b：SKILL.md/_shared 為已知口徑差，§6.3 記錄） |

## §4 Runtime 自述（`runtime_info`）

（schema 同 v2。）語義釘死：

- 指紋優先；`systemPromptText` 給了 → aiide 重算 sha256/bytes/tokensEst 覆蓋自報值
  （可驗），未給 → 指紋標 `self-reported`。tokensEst 恆標 estimate（tokensEstCJK，
  非中文偏差大——文檔明示）。
- **全文內容尋址落盤（F-2-07 / r3 F-3-10 封邊）**：`logs/runtime-info/system-prompt-
  <sha256 前 12>.txt`——同內容冪等（併發池安全、跨 repeat/invocation 去重、resume 不丟）、
  漂移各版本並存、無改名無競態。**experiment 存 sha256 全值**（檔名前 12 僅路徑）；
  寫入時檔已存在 → 比對全 sha，不一致（前綴碰撞）→ 落 `-<sha 前 16>` 加長名 + warning；
  讀取缺檔（手動清理）→ 渲染「文本已不可得（sha 保留）」降級文案。`textCaptured: true`。
  隱私語義入 §6 self-descriptor 節：logs/runtime-info/ 為跨實驗共享內容尋址池，刪單一
  實驗不刪檔、prompt 明文留存本機（prune 工具未來納管）。
- 漂移：**non-excluded reps**（F-4-05：與 §3/driftDigest 同分母——completion-only 的
  noSession rep 也參與）間 sha 群不一致 → warning；封存取固定迭代序首個非空。金樣本：
  completion-only rep 的 runtime_info 參與漂移偵測。
- 落點 `experiment.environment.runtimeInfo`。
- 「看效果」誠實框架：compare/upgrade 兩側都有 → 描述符 diff 表（prompt sha 變否、
  bytes Δ、工具增刪、version Δ）與指標 delta 並排，定調「同期变更的环境因素
  （concurrent factors）」，絕不因果句；一側缺 → 「无 runtime 自述」佔位。

## §5 核驗：seal 對帳 + `aiide adapter check`（file 模式）

1. **seal 對帳**：declared-but-silent（triggers/refReads 族僅在 suite 有 expected_skill
   目標時 warning，否則 info；聲明 token = schema 欄位原拼寫，observedSignals 內部鍵
   映射表在 §6.3——F-2-29）；near-miss 鍵偵測（edit distance ≤2 → warning）；合理性
   lint（§2，inventory 缺席整組跳過）；inventory 前綴 lint（warning）。
2. **`aiide adapter check <output.json>`**（file 模式；live 驗證第二波走 suite 機器）：
   - fatal：JSON 不可解析、result 缺失、ref 前綴/inventory 一致性違規、denialKind
     非字串非 null。
   - warning：near-miss 鍵（**`x_` 前綴命名空間豁免**，F-2-12：adapter 自定欄位的
     正規出口，永不參與 near-miss 比對；文檔明示）、未知 denialKind 值、純未知鍵。
   - 輸出通道存在性報告（本檔出現哪些通道 → 點亮哪些統計 → 缺哪通道少什麼）+ 明文
     範圍聲明：單發 check 驗 schema 與通道形狀；覆蓋/漂移是跨 repeat 性質只有 seal
     對帳能驗。
3. 金樣本：訊號組合判定 byte-stable；同輪/跨輪混合排序；resume 封存等價；usage 缺席
   vs 全 0（adapter 路徑）；**usage 全 0（非 null）→ H 仍 null**；**usage 缺席輪 rep
   不得變 error rep**；multi-step 與 completion-only 持久化；**completion-only +
   skills_inventory 的 observedSignals/inventoryStatus 聯合判定**；**回填舊 adapter
   run 檔（僅 attributionSkill）與新跑同口徑**；漂移警告（non-excluded/excluded 分流）；
   宣告事件不出現在任何 ordinal 列表；blocked 宣告豁免；refMeta===null；封存檔無
   per-rep 副本；legacy-vs-new 可比；provenanceMix 混合池；**prompt 檔缺失降級渲染**；
   multi-step 量詞計數（3 步僅 1 步帶 usage）；consumer 矩陣每行至少一例；契約測試
   （範圍限定 references/）。

## §6 文檔（重構 docs/adapters.md：三段 + 保留段）

1. **快速開始**：最小骨架（completion-only，约 10 行）+ 誠實標注真實 HTTP/SSE driver
   約 100-200 行（指向 okx 實例）；四步升級路徑圖 + 訊號→統計對照表。
2. **逐訊號指南**：trace / usage / semantics / self-descriptor 四節。semantics 節開頭
   適用性判定框（「你的 runtime 有按需啟用的 prompt 模組 + 隨附參考文檔嗎？沒有 →
   跳過本節，誠實上限 = trace + cost + self-descriptor」）+ 反模式清單（工具選擇 ≠
   trigger；RAG 檢索 ≠ refRead 除非有穩定 ref 命名空間）。self-descriptor 節含隱私
   說明。每節配 check 工作流。
3. **參考**：完整 schema 表、誠實降級規則表、順序/ordinal 語義、provenance 與不可比
   規則、denialKind 值域、observedSignals 鍵映射（含型別 union）、claude-code 對照、
   已知口徑差清單——SKILL.md/_shared、usage 全 0 vs 缺席（claude-code 側不可分）、
   **claude-code activation 口徑 ⊃ 覆蓋率 trigger 口徑（attributionSkill/sidechain
   ——既有行為，不隨本波改動，F-4-07）**、**L1 routing verdict（gradeRouting）只認
   工具事實 Skill 呼叫、不隨本波擴宣告口徑（adapter arm 進 upgrade verdict 前需另行
   裁決，F-5-07）**、upgrade 場景日誌生產者=受測物——反作弊誠實條款全文。
4. **保留段（F-2-28：既有內容整體平移，零淨損）**：runtime.service 生命週期、BYOK、
   provider 切換、okx demo 踩坑、Playwright driver、S1/S2/S3/S12 評測可靠性欄位、
   compare 不可比聲明——附舊節→新節遷移表，交付驗收含 diff 核對無內容淨損。

文案紀律：dual-layer（zh-hans 主句 + canonical term 括號）；交付前 fresh-eyes 一輪。

## §7 非目標

同 v2（OTLP 輸入 ❌ / 宣告制 refMeta bytes ❌ / streaming ❌ / 因果推斷 ❌ / schema 版本欄
❌ / check --exec ❌ / 防偽機制 ❌——以揭露應對），另加：
- ❌ 大清單 rep 級去重優化（記未來項）。
- ❌ 細粒度（run 級/通道級）provenance——實驗級單值足夠，dissent 記錄在案。

## §8 實作切分（兩波）與驗證

**Wave 1（語義鏈）**：§2 schema + D1 normalization（usage 缺席保真、denialKind 降級
——**折入不在此**，F-4-03）+ collectSessionEvents（declaredEvents 通道 + adapter-trace
attributionSkill 消費端折入 + primary/aux 重算）+ extractTriggers 合併序 + §3 持久化
（buildRepeat/runMultiStep/seal hoist/剝除）+ inventory 四態 + 消費者矩陣全行（wave 1
列）+ provenance + observedSignals + seal 對帳 + `adapter check`（file 模式）+ 文檔
§6.1/6.2(semantics)/6.3/6.4 + synthetic semantics fixture e2e + playwright 冒煙。
**Wave 2（自述鏈）**：§4 runtime_info 全鏈（rep→environment→環境卡→compare/upgrade
diff 表，含 report.js 節編號重排工作項）+ 文檔 self-descriptor 節 + okx demo 升級為
trace+cost+self-descriptor 實例（demo 側 runtime_info 來源 = 跨 repo 工作項）+ check
live 模式（若仍需要）。

驗證：全套既有測試綠（419 基線）+ §5.3 金樣本 + playwright（synthetic adapter 實驗 →
覆盖率面板亮 + provenance 徽章 + 清单自报文案）+ 文檔範例 JSON 全過 check。

## §9 Challenge loop 記錄

| round | reviewers | new B/M/m | 裁決 |
|---|---|---|---|
| 1 | contract-skeptic + adapter-dev-pragmatist | 4/12/9 | 砍線性等級改旗標集合；宣告事件不進 proximity；rep 級持久化；消費者矩陣；provenance+反作弊條款；check 砍 --exec；demo 改自述實例；切兩波；全部 MINOR 修 |
| 2 | 新 spawn contract-skeptic + implementation-skeptic | 3/16/12 | **provenance 重構為 run 來源制**（adapter trace 全屬自報；mixed 消解；legacy 可比性修復）；observedSignals 兩路徑量詞表 + 復用 resolveReps；usage 缺席保真；declaredEvents 獨立通道（ordinal 列表純工具事實）；seal hoist 到 environment.skillsInventory 唯一副本 + rep 剝除（回填讀取源）；multi-step/completion-only 持久化補齊；system prompt 內容尋址落盤；denialKind 統一 warning；docs 加保留段遷移表；lint 分母不可知即跳過；x_ 命名空間；全部 MINOR 修 |
| 3 | 新 spawn full-spectrum skeptic | 2/6/6 | **H gate 補 peakContext>0**（防全零 usage 假滿分）；**inventory/runtimeInfo 量詞改 rep 級 non-excluded**（completion-only 不被 valid bucket 排除）；**skill 欄折入移到消費端**（collectSessionEvents 按 run.source 讀 attributionSkill——新舊 run 檔口徑一致 + 通道證據純度）；metrics.js/equivTokens null-guard 全鏈入矩陣；claude-code usage 旗標改先驗恆真（不假裝機械量詞）；depgraph provenanceMix 接線；seal hoist 執行點釘死（scoreTask 前、map 替換）；driftDigest；內容尋址封邊（全 sha/碰撞/缺檔降級/隱私）；valid 兩分母正式命名；金樣本四例補齊；信任論證措辭修正 |
| 4 | 新 spawn final skeptic | 1/5/3 | **detectActivation 增讀 declaredTriggers**（triggers-only adapter 否則被罰 P/R——activation 事實源 ⊇ 覆蓋率 triggerSet）；primary/aux 重算點釘死（collectSessionEvents 折入後重算覆蓋，extractTriggers 保純顯式）；§8 與 D1 折入矛盾句修正；observedSignals 型別 union 釘死（含 'a-priori' 字面量）；§4 漂移分母改 non-excluded reps；index.html run 詳情 sparkline/峰值卡 null 容錯入矩陣；§6.3 已知口徑差補 activation ⊃ coverage（sidechain）；H gate 冗餘連詞加註；expstats proximity axesOmitted 入矩陣 + triggers 量詞限主 rounds |
| 5 | 新 spawn final convergence check | 1/2/4 | **denialKind 未知值改保留原值絕不降 null**（降 null 把拒絕反轉成成功讀取——灌覆蓋率分子/豁免消失/safety 誤判；閉集僅供顯示與 lint）；observedSignals+driftDigest 計算時點釘在剝除前同點、hoist 限 non-excluded；同輪宣告內部序釘死（declaredTriggers 先、折入 attributionSkill 殿後）；metrics 跳過粒度明文（僅 token/cost，toolErr 照計）；provenance 由 collectSessionEvents 自算 + provenanceMix unknown 桶；peakContext 空序列→null；§6.3 補 gradeRouting 口徑差。**Reviewer 同時確認：v5 增量無新矛盾、§1↔§2↔§3↔§5↔§8 交叉引用一致、H gate 與現狀恆等、回填口徑一致主張成立** |
| a1 | observability-taxonomy loop-20260712-13a1f965（5 輪，verdict = diverged @ max_iter，見該文檔 §6） | — | schema 追加 round `stopReason` 與 toolCall `kind` 兩選填欄（見下方 a1 amendment 節）；statsresolve A1 supplemental 機制預告 |

## a1 amendment（taxonomy T1 落地，出處：observability-taxonomy.md §5 / challenge loop-20260712-13a1f965）

本節把 taxonomy §5 的 v7 amendment 表落回本 SSOT。兩欄均**選填、加法式**，歸 §2 schema；
未提供時對應統計節按 §3.0 null 表誠實降級（truncation 'no-stop-reason'、toolUsage 走 inferred）。

- **round `stopReason`**（餵 expstats `truncation` §3.3）：
  - 值域參考（非閉集）：`end_turn` | `max_tokens` | `tool_use` | `stop_sequence`——**未知值
    保留原值**，進 truncation 的 `byReason` 值分佈表，絕不折 null、絕不歸併。
  - **L3 豁免機制（r5 F-5-02，結構性）**：normalization（buildRunFromTrace）把自報值放
    **獨立欄 `round.declaredStopReason`**，`round.stopReason` 對 adapter 恆 null——score.js
    的兩個 stopReason 讀點（isConfirmTurn 與 gradeSafety 內聯 confirmIdx 掃描）**零改動**
    即豁免（adapter 自報 stopReason 不參與 L3 confirm-turn 判定；要參與需另行裁決 + 金樣本）。
    truncation 統計讀 `declaredStopReason ?? stopReason`。金樣本：adapter run 帶
    stopReason='end_turn' + must_confirm_before case → gradeSafety 判定與缺席時 byte 相同。
  - 缺席判定 = 逐輪掃描（**不擴 observedSignals 旗標**——r2 裁決）；near-miss 清單已含。
- **toolCall `kind`**（餵 expstats `toolUsage` §3.2）：
  - 閉集 `skill | agent | mcp | builtin | other`（單一常數 `src/adaptercheck.js` 的
    `TOOL_KINDS`，check 與統計層共用）；normalization 原樣透傳到獨立欄
    `toolCall.declaredKind`（避免與未來 claude-code 原生欄相撞）。
  - 統計層：自報值優先；**值域外 → 'other' + stats warning**（check 同步 warning，絕非
    fatal）；缺席 → 按名字推斷（inferred；builtin 判定源 = 版本化 allowlist 常數，
    `allowedTools` 絕不作分類源——taxonomy r3 F-3-01）。`kindSource` 揭露 declared/inferred
    計數。near-miss 清單已含 `kind`。
- **statsresolve A1 supplemental（T1-S5 已落地）**：embedded stats 有效但 schemaVersion
  舊時，`resolveExpStats` 增獨立頂層欄 `supplemental: { sections, authority:
  'non-authoritative-recompute', schemaVersionFrom, schemaVersionTo }`——只載 v3+ 頂層新節
  （閉集：contextComposition, toolUsage, truncation, fileTargets, cacheHitRate, selfReport,
  sidechainShare, statsHealth），embedded 權威數字 byte 不變。契約細節見
  observability-taxonomy.md §3.0；本文檔 §3 消費者矩陣的「statsresolve A1 決策表不變」行
  自 T1-S5 起改寫為本機制（v6 矩陣同步義務，taxonomy r3 F-3-05）。
