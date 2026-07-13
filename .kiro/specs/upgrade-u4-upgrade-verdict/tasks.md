# U4 · upgrade-u4-upgrade-verdict — Tasks

Design: `docs/onchainos-upgrade-pipeline-design.md` §2.2/§5 表 U4/§6 F1/F2/F3. Files: `src/metrics.js`
（等效全價 token、bootstrap CI、複用 `score.js:237` wilson、BH、budget 定價）、`src/score.js`（四元組聚合、
非劣性門、belowFloor 沿用）、`src/meta.js`（版本自報 metadata、兩臂隔離斷言）、`test/metrics.test.js`、
`test/score.test.js`、`test/upgrade.test.js`。CANONICAL CONFIG 由 [U0] `src/upgradeConfig.js` 提供（[TL-B1]）。

## Tasks

- [x] T4.1 — **CONFIG 消費 + footer**（[TL-B1]，config 定義在 [U0] T0.0）：所有可調參數 import 自
  `src/upgradeConfig.js`、不重定義；聚合入口驗 frozen；verdict 報告 footer 印生效參數值。內聯測試：篡改
  import 的 config 物件 → 驗 frozen 攔下；footer 含 δ/MIN_PAIRS/種子。
  _Requirements: R4.0.1, R4.0.2, R4.0.3_
- [x] T4.2 — 四元組聚合：`src/score.js` `aggregateArm(repeats)` 質量三層 + 三連續量；成本/質量分母排除
  excluded、併帶 `excludedRepeats`；flow-incomplete 分母**含** excluded（分別維護兩分母）。內聯測試：同一
  repeats 陣列，成本分母 = 有效數、flow-incomplete 分母 = 全部嘗試（兩值不同）。
  _Requirements: R4.1.1, R4.1.2, R4.1.3_
- [x] T4.3 — `src/metrics.js` 統計基元：`equivTokens(usage, tokenWeights)`；`pairedBootstrapCI(deltas,
  {iters,seed,level})`（~30 行，PRNG **splitmix32** seed=0x9E3779B9，[TL-m3]）；比例量**複用**
  `score.js:237` `wilson`（`ciLevel`→z 換算，[TL-m1] 不新造）；`benjaminiHochberg(pvals)`。**金樣本測試
  （固定種子）**：同 deltas 同 seed → 位元一致 CI；splitmix32 前若干輸出對照已知序列；已知小資料集套用
  既有 wilson 對照手算；BH 對已知 p 值序列的 reject 集對照。
  _Requirements: R4.2.1, R4.2.2, R4.2.3, R4.6.4_
- [x] T4.4 — 非劣性門 + belowFloor：`nonInferiorityPass(ciLow, deltaPp)` = `ciLow > -deltaPp`（嚴格）。
  **金樣本測試（邊界）**：ciLow = −5.0 → false（R4.EB3）；ciLow = −4.99 → true；δ 印入 report 物件。
  _Requirements: R4.3.1, R4.3.2, R4.3.3_
- [x] T4.5 — intent verdict + 絆線：`decideVerdict({quality, cost, flowIncomplete, pairs, exclusionPct,
  intent})` → cost-opt/quality-fix/neutral-refactor/insufficient-data/inconclusive。**金樣本測試（verdict
  規則）**：pairs=7 → insufficient-data（R4.EB1）；exclusionPct=12.0 → 不 inconclusive、12.5 → inconclusive
  （R4.EB2）；單臂缺失 → insufficient-data（R4.EB4）；三個 intent 各一組通過/不通過金樣本；flow-incomplete
  顯著升 → 即使成本降也不判 cost-opt 成立。**[PM-N1]** 輸出整案排除的 case-id 清單（每筆帶原因 env-noise/
  harness-halt），供 [U7] inconclusive 指引枚舉。內聯測試補：inconclusive 輸出含被排除 case-id + 原因（非
  僅計數）。
  _Requirements: R4.4.1, R4.4.2, R4.4.3, R4.5.1, R4.5.2, R4.5.2a, R4.5.3, R4.5.4_
- [x] T4.6 — per-skill cluster bootstrap + BH 徽章：`perSkillDiagnostics(units)` case-cluster 重抽樣；
  <5 → insufficient-data 徽章、5-7 → 「僅供參考」、BH 校正徽章；標「非採用證書」+ 混合 bundle 確認 smoke 提示。
  內聯測試：4 case → insufficient-data；5 case → 僅供參考旗標；BH 降低顯著徽章數對照。
  _Requirements: R4.6.1, R4.6.2, R4.6.3, R4.6.4, R4.6.5, R4.EB5_
- [x] T4.7 — **F3 兩臂隔離斷言**：`src/meta.js` `assertArmIsolation(expA, expB)` 斷言臂身份/resumeKey 互異；
  同源 → throw 拒產 verdict。內聯測試：串臂（同 resumeKey）→ throw；正常兩臂 → 通過。
  _Requirements: R4.7.1_
- [x] T4.8 — 版本自報 metadata：`src/meta.js` `buildVersionQuad(armA, armB)`（version/skill sha256/model/
  harness/isolation）；footer 呈現 + 檢定總數與策略揭露。內聯測試：metadata 四元組齊全；版本斷言結果落 meta。
  _Requirements: R4.8.1_
- [x] T4.9 — **[PM-B3c]** regressed 聚類介面：`src/metrics.js` `clusterRegressed(pairedCases)` →
  `{ [skill×category]: caseId[] }`（skill 取 [U2] 主歸因、category 取 [U1]）。內聯測試：混合 regressed/未退步
  case → 只聚 regressed、鍵為 skill×category、caseId 歸組正確。
  _Requirements: R4.9.1_

## 交叉一致性註記
- **CANONICAL CONFIG 唯一定義源在 [U0]（T0.0 `src/upgradeConfig.js`）**；本 spec 只消費（R4.0）、不定義。
- F1 落 R4.1.3+R4.5.2（分母不同 + >12% 絆線），與 [U3] R3.5 合成；F2 落 R4.3（非劣性 δ）；F3 落 R4.7，與
  [U0] R0.3 合成；MIN_PAIRS/MIN_PAIRS_SKILL/BH 全落本 spec。

## Rollup（實作完成 2026-07-10）
所有 T4.1–T4.9 完成，全綠。**裁決記錄（小衝突）**：team-lead 指示「bootstrap/BH/非劣性/intent verdict
放新檔」優先於 tasks.md 的 metrics.js/score.js 檔案指引——verdict 引擎與統計基元集中落新檔
`src/upgradeVerdict.js`（含 `clusterRegressed`，tasks 原標 metrics.js，改置此處保 verdict 分析內聚），
降低對 score.js 的衝突面；`equivTokens` 仍落 `src/metrics.js`（token/成本基元，與 pricing 同宗）。
- **CONFIG 消費 + footer**（upgradeVerdict.js）：`assertConfigFrozen`（R4.0.3 攔篡改）+ `buildVerdictFooter`
  印生效 δ/MIN_PAIRS/種子 + 檢定策略揭露（全域 3 軸不校正、per-skill BH，R4.0.2/R4.6.4）。
- **四元組聚合 `aggregateArm`**（upgradeVerdict.js）：質量三層 + 三連續量；成本/質量分母排除 excluded、
  flow-incomplete 分母含 excluded——同一 repeats 兩分母不同值（金樣本 n=8 vs denom=10，R4.1.2/R4.1.3）。
- **統計基元**：`splitmix32`（seed 0x9E3779B9，金樣本序列鎖定）+ `pairedBootstrapCI`（位元可重現）+
  `clusterBootstrapCI`（case 為 cluster）+ `benjaminiHochberg`（step-up）於 upgradeVerdict.js；
  `equivTokens` 於 metrics.js；比例量**複用** `score.js` `wilson`（不新造，R4.2.3）。
- **非劣性門 `nonInferiorityPass`**：`ciLow > -deltaPp` 嚴格；邊界 −5.0 不放行、−4.99 放行（R4.3.2/R4.EB3）。
- **intent verdict `decideVerdict`**：cost-opt/quality-fix/neutral-refactor + insufficient-data(<8) +
  inconclusive(排除率 >12% 嚴格；12.0 不觸發、12.5 觸發)；flow-incomplete 納入**所有** intent 質量判準
  （顯著升 → 即使成本降也不判 cost-opt 成立）；**[PM-N1]** inconclusive 輸出 `excludedCases`
  每筆帶 env-noise/harness-halt 原因清單（R4.4/R4.5/R4.5.2a/R4.EB1-EB4）。
- **per-skill `perSkillDiagnostics`**：cluster bootstrap + <5 insufficient-data 徽章 + 5-7 reference-only
  旗標 + BH 校正（只能撤銷 naive 顯著、不無中生有）+ 明標「非採用證書」+ 混合 bundle smoke 提示（R4.6）。
- **F3 隔離 `assertArmIsolation`** + **版本自報 `buildVersionQuad`**（`src/meta.js`）：串臂同 resumeKey/
  同臂身份 → throw 拒產 verdict；版本四元組 version/skill sha256/model/harness/isolation（R4.7/R4.8）。
- **regressed 聚類 `clusterRegressed`**（upgradeVerdict.js）：`{ skill×category: caseId[] }`，只聚 regressed，
  供 [U7] R7.7.3 呈現（R4.9）。

### 給 [U7] 的 verdict/report 資料結構（消費契約）
- `aggregateArm(repeats)` → `{ n, attempted, excludedRepeats, degraded, quality:{l1PassRate,l2PassRate,
  l3PassRate}, cost:{meanTurns,meanEquivTokens,meanSeconds}, flowIncomplete:{numerator,denom,rate} }`。
- `decideVerdict(...)` → `{ verdict:'cost-opt'|'quality-fix'|'neutral-refactor'|'insufficient-data'|
  'inconclusive', established:bool, pairs, exclusionPct, excludedCases:[{caseId,reason}], gates, reasons:[] }`
  （bundle 級唯一採用證書；`excludedCases` 供 R7.4.3 inconclusive 指引枚舉）。
- `perSkillDiagnostics(units)` → `{ skills:[{skill,nCases,badge,referenceOnly,ci,mean,pValue,significant,
  significantBadge}], note, fdr }`（**非採用證書**）。
- `buildVerdictFooter(config,{versionQuad,testCount,fdrStrategy})` → `{ config:{...生效參數}, versionQuad,
  tests:{count,globalCorrection:'none',perSkillCorrection} }`（footer 逐字呈現）。
- `clusterRegressed(pairedCases)` → `{ [skill×category]: caseId[] }`（[U7] 只呈現不重算）。

證據：`test/upgrade-verdict.test.js`（24 條全綠，含 AC↔證據 標註 + 金樣本鎖定）；全套 `node --test`
245 綠（基線 198 + U3 23 + U4 24），既有測試零回歸。
