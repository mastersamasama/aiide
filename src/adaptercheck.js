// `aiide adapter check <output.json>` — file-mode mechanical validator for the adapter stdout
// contract (docs/adapter-observability-design.md v6 §2 schema / §5.2 check). Pure functions, zero
// deps, deterministic output (byte-stable for identical input) so the CLI wrapper in bin/aiide.js
// stays a thin shell and the whole thing is testable without spawning.
//
// Honest scope (printed on EVERY invocation, machine field `scope`): a single-shot check can only
// validate schema and channel SHAPE. Trigger coverage, inventory/self-description drift are
// cross-repeat properties — only seal reconciliation (src/lab.js reconcileAdapterOutput) can verify
// those. This tool must never hand out a fake green light for them.
//
// Shared single-source constants: the known key sets, near-miss targets, editDistance and the
// denialKind closed set live HERE and are imported by lab.js (seal reconciliation) — the two
// validators can never drift apart (spec §5: check 的規則要與 seal 一致).

// ── §2 schema constants (single source, shared with lab.js seal reconciliation) ────────────────
export const KNOWN_TOP_KEYS = new Set(['result', 'total_cost_usd', 'runtime_version', 'session_id',
  'trace', 'observability', 'skills_inventory', 'runtime_info']);
export const KNOWN_ROUND_KEYS = new Set(['text', 'skill', 'durationMs', 'usage', 'toolCalls',
  'triggers', 'refReads', 'ts', 'model', 'stopReason']);
export const KNOWN_TOOLCALL_KEYS = new Set(['name', 'id', 'isError', 'skill', 'input', 'result', 'denialKind', 'kind']);
export const NEAR_MISS_TARGETS = ['triggers', 'refReads', 'skills_inventory', 'runtime_info',
  'observability', 'denialKind', 'stopReason', 'usage', 'trace', 'kind'];
// denialKind closed set (spec §2 D1 / F-5-01): display + lint value domain ONLY — unknown non-null
// values are preserved verbatim by normalization and stay a denial fact; check merely discloses.
export const DENIAL_KINDS = new Set(['user-rejected']);
// toolCall `kind` closed set (taxonomy a1 amendment / §5 v7a): the toolUsage classification
// domain. An out-of-domain declared value is a WARNING here and classifies as 'other' (+ stats
// warning) in expstats — never a fatal, never silently accepted into a named bucket.
export const TOOL_KINDS = new Set(['skill', 'agent', 'mcp', 'builtin', 'other']);
export const REF_READ_STATUSES = new Set(['ok', 'blocked']);

/** Bounded Levenshtein distance (returns max+1 early when the length gap already exceeds max). */
export function editDistance(a, b, max = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Raw adapter-output shape evidence (key sets, declarations) — shared by seal + check. Deterministic (sorted key sets). */
export function collectAdapterMeta(out) {
  const meta = { topKeys: Object.keys(out).sort() };
  if (Array.isArray(out.observability)) {
    meta.observability = out.observability.filter((x) => typeof x === 'string');
  }
  const roundKeys = new Set();
  const toolCallKeys = new Set();
  const declaredTriggersByRound = [];
  const declaredRefReads = [];
  if (Array.isArray(out.trace)) {
    for (const s of out.trace) {
      if (!s || typeof s !== 'object') continue;
      for (const k of Object.keys(s)) roundKeys.add(k);
      if (Array.isArray(s.toolCalls)) {
        for (const tc of s.toolCalls) {
          if (tc && typeof tc === 'object') for (const k of Object.keys(tc)) toolCallKeys.add(k);
        }
      }
      if (Array.isArray(s.triggers)) declaredTriggersByRound.push(s.triggers.filter((t) => typeof t === 'string'));
      if (Array.isArray(s.refReads)) {
        for (const r of s.refReads) {
          if (r && typeof r === 'object') declaredRefReads.push({ skill: r.skill ?? null, ref: r.ref ?? null });
        }
      }
    }
  }
  meta.roundKeys = [...roundKeys].sort();
  meta.toolCallKeys = [...toolCallKeys].sort();
  meta.declaredTriggersByRound = declaredTriggersByRound;
  meta.declaredRefReads = declaredRefReads;
  return meta;
}

/**
 * Near-miss key warnings over the three key surfaces — the ONE implementation both seal
 * reconciliation and `adapter check` call (identical wording, identical x_ exemption).
 * Purely unknown keys stay silent (forward compatibility); `x_` prefix is the sanctioned
 * custom-field namespace and never enters the comparison.
 */
export function nearMissKeyWarnings({ topKeys, roundKeys, toolCallKeys } = {}) {
  const out = [];
  for (const [keys, surface, known] of [
    [topKeys, 'top-level', KNOWN_TOP_KEYS],
    [roundKeys, 'trace round', KNOWN_ROUND_KEYS],
    [toolCallKeys, 'toolCall', KNOWN_TOOLCALL_KEYS],
  ]) {
    for (const k of keys ?? []) {
      if (known.has(k) || k.startsWith('x_')) continue;
      const near = NEAR_MISS_TARGETS.find((t) => editDistance(k, t) <= 2);
      if (near) out.push(`adapter ${surface} key '${k}' looks like '${near}' (near-miss; x_ prefix exempts custom fields)`);
    }
  }
  return out;
}

// ── §5.2 channel presence catalogue (fixed order → deterministic report) ───────────────────────
// Each channel: how presence is detected on ONE output file (same predicate family the seal
// quantifiers use per run/rep), which stats it lights up, and what shows n/a when it is missing.
export const CHANNELS = [
  {
    key: 'trace',
    lit: 'P/R 维度、逐轮 timeline、工具调用统计（tool facts）、toolUsage 工具分类、truncation 截断统计（轮带 stopReason 时）',
    missing: '缺 trace → P/R 与 timeline 显示 n/a（completion-only：只有 C）',
  },
  {
    key: 'usage',
    lit: 'H（context 健康度）、token/成本统计、context 曲线（sparkline）',
    missing: '缺 usage → H 显示 n/a（复合分按可用维度重归一化，标 partial dims）',
  },
  {
    key: 'triggers',
    lit: 'activation、触发覆盖（trigger coverage）、primary skill 归因',
    missing: '缺 triggers → activation 与触发覆盖显示 n/a（不惩罚 P/R）',
  },
  {
    key: 'refReads',
    lit: '引用读取覆盖分子（refCoverage reads）、blocked 豁免（artifactReads exemption）',
    missing: '缺 refReads → 引用读取覆盖显示 n/a',
  },
  {
    key: 'skills_inventory',
    lit: '引用覆盖分母（inventoryStatus=adapter-declared）、seal 对帐合理性 lint 的分母',
    missing: '缺 skills_inventory → 引用覆盖分母不可知（external-runtime），覆盖率显示 n/a',
  },
  {
    key: 'runtime_info',
    lit: '运行时自述指纹（self-descriptor）——环境卡（system prompt 指纹/工具清单）+ 两版对比 diff 表',
    missing: '缺 runtime_info → 运行时自述（self-descriptor）显示 n/a',
  },
  {
    key: 'observability',
    lit: 'seal 对帐 declared-but-silent 检查的声明基线（declaration baseline）',
    missing: '缺 observability 声明 → seal 对帐跳过 declared-but-silent 检查（选填，不影响统计）',
  },
];

// The honest-scope sentence — printed on EVERY invocation (human AND --json), including fatal ones.
export const CHECK_SCOPE =
  '单发检查只验 schema 与通道形状；触发覆盖、清单/自述漂移是跨 repeat 性质，只有实验封存对帐（seal reconciliation）能验';

const REF_FORM_RE = /^[^/]+\/references\/.+$/;

/**
 * File-mode `adapter check` core: takes the raw stdout text of ONE adapter invocation and returns
 * a deterministic result object:
 *   { ok, fatals: [..], warnings: [..], channels: {key:bool}|null, lit: [{channel,stats}],
 *     missing: [{channel,effect}], scope }
 * ok === fatals.length === 0. `channels` is null when the JSON never parsed (presence unknowable —
 * never reported as "all absent", null-not-zero discipline).
 *
 * fatal (exit 1 at the CLI): unparseable JSON; result missing/non-string; malformed
 * refReads[].ref namespace or skill/prefix mismatch; skills_inventory ref prefix violation;
 * denialKind neither null nor string.
 * warning (exit 0, listed): near-miss keys (x_ exempt); unknown denialKind value (closed set
 * shared with seal); unknown refReads[].status. Purely unknown keys stay silent (forward compat).
 */
export function checkAdapterOutput(text) {
  const fatals = [];
  const warnSet = new Set(); // insertion-ordered dedupe, same discipline as seal reconciliation

  let out = null;
  try {
    out = JSON.parse(text);
  } catch (e) {
    fatals.push(`JSON 不可解析（parse error）：${e.message}`);
    return finish({ fatals, warnSet, out: null });
  }
  if (out == null || typeof out !== 'object' || Array.isArray(out)) {
    fatals.push('顶层不是 JSON 对象（top-level value is not an object）——契约要求 stdout 打印一个 JSON 物件');
    return finish({ fatals, warnSet, out: null });
  }

  // fatal: result missing / non-string — verifiers cannot score without it
  if (typeof out.result !== 'string') {
    fatals.push("'result' 缺失或非字符串（missing/non-string）——必填字段，verifiers 跑在它上面");
  }

  const rounds = Array.isArray(out.trace) ? out.trace.filter((s) => s && typeof s === 'object') : [];

  // fatal: refReads namespace + skill/prefix consistency; warning: unknown status
  for (const s of rounds) {
    if (!Array.isArray(s.refReads)) continue;
    for (const r of s.refReads) {
      if (!r || typeof r !== 'object') {
        fatals.push(`refReads[] 含非对象项（non-object entry）：${JSON.stringify(r)}`);
        continue;
      }
      if (typeof r.ref !== 'string' || !REF_FORM_RE.test(r.ref)) {
        fatals.push(`refReads[].ref ${JSON.stringify(r.ref ?? null)} 不符 <skill>/references/<relpath> 形（malformed ref namespace）`);
      } else if (typeof r.skill === 'string' && !r.ref.startsWith(`${r.skill}/references/`)) {
        fatals.push(`refReads[].skill '${r.skill}' 与 ref '${r.ref}' 前缀不一致（skill/prefix mismatch）`);
      }
      if (r.status != null && !REF_READ_STATUSES.has(r.status)) {
        warnSet.add(`refReads[].status ${JSON.stringify(r.status)} 未知（known: ok | blocked）——normalization 会按 'ok' 处理（unknown status）`);
      }
    }
  }

  // fatal: skills_inventory refs must live under <that skill>/references/
  if (out.skills_inventory != null && typeof out.skills_inventory === 'object' && !Array.isArray(out.skills_inventory)) {
    for (const [skill, entry] of Object.entries(out.skills_inventory)) {
      for (const ref of entry?.refs ?? []) {
        if (typeof ref !== 'string' || !ref.startsWith(`${skill}/references/`)) {
          fatals.push(`skills_inventory['${skill}'] 的 ref ${JSON.stringify(ref ?? null)} 未以 '${skill}/references/' 开头（inventory prefix violation）`);
        }
      }
    }
  }

  // fatal: denialKind must be null or string (structural); warning: unknown value in the closed set
  for (const s of rounds) {
    if (!Array.isArray(s.toolCalls)) continue;
    for (const tc of s.toolCalls) {
      if (!tc || typeof tc !== 'object' || !('denialKind' in tc)) continue;
      const v = tc.denialKind;
      if (v !== null && typeof v !== 'string') {
        fatals.push(`toolCall.denialKind ${JSON.stringify(v)} 非 null 非字符串（structural error）——非 null 即 denial 事实，类型必须可判`);
      } else if (typeof v === 'string' && !DENIAL_KINDS.has(v)) {
        warnSet.add(`denialKind '${v}' 不在已知值域（known: ${[...DENIAL_KINDS].join(', ')}）——原值保留照算 denial，仅揭露（unknown value, disclosed not rejected）`);
      }
    }
  }

  // warning: toolCall.kind outside the closed set (a1 amendment) — toolUsage classifies such a
  // call as 'other' + stats warning; check discloses the same fact ahead of time, never a fatal.
  for (const s of rounds) {
    if (!Array.isArray(s.toolCalls)) continue;
    for (const tc of s.toolCalls) {
      if (!tc || typeof tc !== 'object' || tc.kind == null) continue;
      if (typeof tc.kind !== 'string' || !TOOL_KINDS.has(tc.kind)) {
        warnSet.add(`toolCall.kind ${JSON.stringify(tc.kind)} 不在闭集（known: ${[...TOOL_KINDS].join(', ')}）——统计层归 'other' 并警告（out-of-domain kind）`);
      }
    }
  }

  // warning: near-miss keys — the same shared implementation seal reconciliation uses
  for (const w of nearMissKeyWarnings(collectAdapterMeta(out))) warnSet.add(w);

  return finish({ fatals, warnSet, out });
}

function finish({ fatals, warnSet, out }) {
  const channels = out == null ? null : {
    trace: Array.isArray(out.trace) && out.trace.length > 0,
    usage: Array.isArray(out.trace) && out.trace.some((s) => s && typeof s === 'object' && s.usage != null),
    triggers: Array.isArray(out.trace) && out.trace.some((s) => s && typeof s === 'object' && Array.isArray(s.triggers)),
    refReads: Array.isArray(out.trace) && out.trace.some((s) => s && typeof s === 'object' && Array.isArray(s.refReads)),
    skills_inventory: out.skills_inventory != null && typeof out.skills_inventory === 'object'
      && !Array.isArray(out.skills_inventory) && Object.keys(out.skills_inventory).length > 0,
    runtime_info: out.runtime_info != null && typeof out.runtime_info === 'object' && !Array.isArray(out.runtime_info),
    observability: Array.isArray(out.observability),
  };
  const lit = [];
  const missing = [];
  if (channels) {
    for (const c of CHANNELS) {
      if (channels[c.key]) lit.push({ channel: c.key, stats: c.lit });
      else missing.push({ channel: c.key, effect: c.missing });
    }
  }
  return {
    ok: fatals.length === 0,
    fatals,
    warnings: [...warnSet],
    channels,
    lit,
    missing,
    scope: CHECK_SCOPE,
  };
}

/** Human-readable report — deterministic/byte-stable for identical results (fixed channel order, trailing \n). */
export function formatCheckReport(res, { file = null, live = false } = {}) {
  const lines = [];
  lines.push(`┌─ adapter check${live ? '（live）' : ''}${file ? ` · ${file}` : ''}`);
  for (const f of res.fatals) lines.push(`│ ✗ fatal: ${f}`);
  for (const w of res.warnings) lines.push(`│ ⚠ ${w}`);
  if (res.channels == null) {
    lines.push('│ 通道存在性（channel presence）：不可知（JSON 未解析成功）');
  } else {
    lines.push('│ 通道存在性（channel presence）：');
    for (const c of CHANNELS) {
      if (res.channels[c.key]) lines.push(`│   ✓ ${c.key} — 将点亮：${c.lit}`);
      else lines.push(`│   ✗ ${c.missing}`);
    }
  }
  lines.push(`│ 范围声明：${res.scope}`);
  const tail = res.fatals.length
    ? `✗ ${res.fatals.length} 项 fatal（exit 1）`
    : res.warnings.length
      ? `⚠ 通过，但有 ${res.warnings.length} 项 warning（exit 0）`
      : '✓ 通过（schema 与通道形状有效）';
  lines.push(`└─ ${tail}`);
  return lines.join('\n') + '\n';
}
