# U6 · upgrade-u6-static-gates — Requirements (EARS)

> Design authority: `docs/onchainos-upgrade-pipeline-design.md` §1 (階段 0 靜態預檢)、§2.4 (跑前零 token)、
> §5 spec 表 U6。
> Depends on: [U0] (CANONICAL CONFIG `staticGates.descMaxUnicode`)。
> Consumed by: [U0] (preflight 呼叫靜態閘)、[U7] (報告呈現靜態預檢結果)。

## Constraints (鐵律)
- **零依賴零建置**：純字串/md5 檢查；**零 token**（不呼叫任何 LLM/CLI 產生內容）。
- **experiment 不可變**：靜態閘只讀 skill 檔，不改寫。
- **server read-only except annotations sidecar（既有 PUT /annotations）**：不新增 server 寫入。
- **治理中立 + generic**：閘為**通用**（不綁 onchainos）；只報問題，不自動改 skill。

## Requirements

R6.1 — desc 長度 lint（§2.4）
- R6.1.1 WHEN 某 skill 的 description **Unicode 字符數** > `descMaxUnicode`（1024，取自 [U0] CONFIG），
  SHALL 出 `error`（帶 skill 名 + 實際字符數）。
- R6.1.2（邊界）字符數**恰** 1024 → 通過；1025 → error（門為 `>`）。
- R6.1.3 THE 計數 SHALL 以 Unicode code point（非 UTF-8 位元組、非 UTF-16 code unit）為單位。

R6.2 — 觸發詞跨 skill 碰撞（§2.4）
- R6.2.1 WHEN 兩個以上 skill 宣告了相同/高度重疊的觸發詞，SHALL 出碰撞警告（列出碰撞詞 + 涉及 skill 名）。
- R6.2.2 THE 碰撞判定 SHALL 為確定性字串比對，SHALL NOT 用語義相似度。

R6.3 — `_shared` md5 漂移（§2.4）
- R6.3.1 WHEN 多個 skill 各自攜帶的 `_shared`（共用片段）內容 md5 不一致（本應同步卻漂移），SHALL 出
  漂移警告（列出不一致的 skill + 各自 md5）。

R6.4 — 固定稅表自動生成（§2.4）
- R6.4.1 THE 系統 SHALL 自動生成「固定稅表」：每 skill 的 desc 字符數、觸發詞數、_shared 引用等固定開銷的
  彙總表（generic 欄位，不綁 onchainos 專屬概念）。
- R6.4.2 THE 稅表 SHALL 為 [U7] 報告可消費的結構化物件。

R6.5 — 兩臂 CLI 版本斷言（靜態面，§2.4）
- R6.5.1 THE 靜態閘 SHALL 提供**宣告版本一致性**檢查（兩臂宣告版本不同、且非預期時報錯）；**運行期**
  `onchainos --version` 斷言在 [U0] R0.2.2（preflight），本 spec 只做靜態宣告面比對，不呼叫 CLI（守零 token）。

R6.6 — fail-fast（§1 階段 0）
- R6.6.1 WHEN 任一 `error` 級靜態閘未過，SHALL fail-fast 且**零 token**——在採集啟動前中止，不啟任何 session。
- R6.6.2 THE `warning` 級（碰撞/漂移）SHALL 不中止跑，但 SHALL 進報告（[U7] 呈現）。

## 反例／邊界 AC
- R6.EB1 desc 恰 1024 code point（含多位元組字元如中文）→ 通過（R6.1.2/R6.1.3）。
- R6.EB2 兩 skill 無共同觸發詞 → 無碰撞警告（不誤報）。
- R6.EB3 `_shared` 完全一致 → 無漂移警告。
- R6.EB4 一個 error 級 + 一個 warning 級同時存在 → fail-fast（error 主導），但 warning 仍記入報告。

## 非目標
- ❌ 不綁 onchainos 專屬規則（generic 靜態閘，可用於任意 skill bundle）。
- ❌ 不在靜態閘呼叫任何 CLI/LLM（守零 token；運行期版本斷言在 [U0]）。
