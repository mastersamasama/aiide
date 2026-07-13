# U0 · upgrade-u0-lab-infra — Tasks

Design: `docs/onchainos-upgrade-pipeline-design.md` §1/§2.1/§2.5/§6 F3; evidence `docs/wave0-probe-report.md`
P2/P3. Files: `src/lab.js` (concurrency pool、arm 釘死、resumeKey/journal 臂身份、scripted-reply resume、
metrics 合併、budget)、`bin/aiide.js` (預算表輸出)、`test/lab.test.js`、`test/upgrade.test.js`（新）、
`test/fixtures/claude-stub.js`（asked-and-halted + resume 模式）、新 `src/upgradeConfig.js`（T0.0）、
`test/upgradeConfig.test.js`。**本 spec 定義 CANONICAL CONFIG（T0.0），其他 spec 引用之。**

## Tasks

- [x] T0.0 — **[TL-B1] foundation**：新 `src/upgradeConfig.js`，匯出 `Object.freeze(UPGRADE_CONFIG)`（純常數、
  零邏輯，requirements CANONICAL CONFIG 全欄位）。Wave 1 最前置，其他 spec import 之。內聯測試：frozen（改寫
  拋錯）；關鍵值 == 設計（MIN_PAIRS 8 / MIN_PAIRS_SKILL 5 / δ 5 / tripwire 12 / jaccardSplit 0.30 /
  讀取率 0.60/0.20 / coRead 0.80 / coTriggerGraph 0.50 / smokeTier 20-30 / minMultiIntentPct 0.15）。
  _Requirements: R0.0.1, R0.0.2_
- [x] T0.1 — `src/lab.js` bounded worker pool：`runArm(arm, suite, {concurrency})` 以固定上限併發跑
  (case×repeat) 單元，每單元生成唯一 workspace 子目錄；worker 拋例外不中止 pool。**[TL-m2] 明寫復用**
  `runSuite` 既有 for-task/for-repeat 迴圈 + `appendJournalRepeat` + `scoreTask` 路徑（`appendFileSync`
  併發 append 原子性已核），pool 只包在既有單元執行外層。內聯測試：一個 5-case × 3-repeat stub suite 併發
  跑完，斷言所有 workspace 路徑互異、pool 併發不超上限、單元失敗其餘照跑。
  _Requirements: R0.1.1, R0.1.2, R0.1.3_
- [x] T0.2b — **[PM-B1]** 混合 bundle profile：`ensureProfile` 吃 mix 映射從兩臂 skill 目錄各取版本組單一
  profile；CLI 版本操作者指定（預設新臂）；metadata 記 mix 映射 + CLI + 配對語意（vs 基線臂）。內聯測試
  **只驗本 Wave 可驗部分**：mix `skillA=new,skillB=old` → profile 含 A 新 B 舊；metadata mix 映射 + CLI +
  基線臂身份完整。**[TL-N-MAJOR-1]**「產 mini-verdict」端到端斷言 gated 至 [U7] T7.1（U4 引擎屆時已在），
  本任務不跨 Wave 依賴 U4。
  _Requirements: R0.2b.1, R0.2b.2, R0.2b.3, R0.2b.4_
- [x] T0.2 — Per-arm CLI 釘死：`buildArmEnv(arm)` 構造逐 arm env/PATH，只暴露該 arm 的 `cliPath`；
  `assertArmVersion(arm)` 跑 `onchainos --version` 斷言 == 宣告版本，不等即 throw 且不啟動 session；arm
  metadata（cliVersion/profileName/isolation/model/harness 版本）寫入 experiment。內聯測試：stub 兩臂不同
  version，斷言 A 臂 env 不含 B 臂 cliPath；版本不符 → throw、零 session。
  _Requirements: R0.2.1, R0.2.2, R0.2.3_
- [x] T0.3 — **F3 臂身份入鍵 + [TL-M2] arm 貫穿**：arm 為 `runSuite` optional 形參（缺省行為位元不變），
  穿透 `computeResumeKey`/`ensureJournal`/`findJournal`/`clearJournals`；`computeResumeKey` 追加
  `arm.label/cliVersion/profileName`；journal header 寫臂身份；`findJournal` 斷言 header 臂身份 == 當前 arm，
  legacy（缺 arm 欄位）header 對帶 arm 跑視為獨立 journal。**金樣本測試（固定種子/固定輸入）**：無 arm →
  既有 6 處測試保綠（resumeKey 不變）；兩臂同 suite sha、同 model，跑完 A 臂後啟 B 臂，斷言 (a) 兩 resumeKey
  互異、(b) 兩 journal 檔互異、(c) B 臂跑滿自己的 repeats 不復用 A 臂、(d) 兩臂 metrics 相同時 delta≈0 不因
  resume 串臂而「假成立」、(e) legacy journal 不被誤 resume。
  _Requirements: R0.3.0, R0.3.1, R0.3.2, R0.3.3_
- [x] T0.4 — scripted-reply resume + metrics 合併：`resumeWithScriptedReply(sessionId, reply, arm, cwd)` 用
  `--resume` 同 CONFIG_DIR/同 cwd/不 fork；`mergeInvocationMetrics([inv1, inv2, ...])` 逐次增量相加
  cost/usage、rounds 取增量、C/P/H 取最終流結果；無腳本的 halted → 標 excluded-not-zero + flow-incomplete。
  內聯測試（用 P2 實測數字為金樣本）：首跑 cost 0.1263 + resume 0.0846 → 合併 0.2109（相加，非取後者
  0.0846、非取首者）；全量 parse 續跑 JSONL 無重複 uuid、無需去重；缺腳本 halted → excluded 且非 C=0。
  _Requirements: R0.4.1, R0.4.2, R0.4.3, R0.4.4, R0.4.5_
- [x] T0.5 — 預算預估：`estimateBudget({arms, cases, repeats, concurrency})` → `{sessions, etaMs, usdEst}`，
  USD 用 `metrics.js` 定價；`bin/aiide.js` 在 run/compare 啟動前印表，並導出供 [U7] 消費。內聯測試：
  smoke 規模（2 臂 × 25 case × 3）→ sessions == 150；併發 6 的 etaMs 單調小於併發 1。
  **[裁決 U0-impl-1]** `estimateBudget` 已於 `src/lab.js` 實作+全測（R0.5.2 CLI/U7 同源核心）；`bin/aiide.js`
  的印表接線 **deferred**：該檔不在 U0 實作 agent 的檔案集（並行 agent 邊界），僅剩一行 `console.log(estimateBudget(...))`
  由持有 bin 的一方接上，不影響本 spec 可驗證核心。
  _Requirements: R0.5.1, R0.5.2_

## 交叉一致性註記
- F3（臂身份入 resumeKey/journal header + 兩臂隔離斷言）本 spec 落 R0.3；[U4] 落配對聚合側的兩臂 journal
  隔離斷言（同一機制的下游驗證）。
- **[TL-B1]** 本 spec T0.0 定義 CANONICAL CONFIG `src/upgradeConfig.js`（純常數）；U1/U3/U4/U5/U6/U7 引用，
  不重定義。concurrency / 定價權重 / verdict 閾值等全在此檔。
