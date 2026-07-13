// Responder — auto-answer interactive gates (subsystem 3).
//
// When a run halts to ask the human (a stop-with-confirm turn, an adapter `ask_user`, or a permission
// prompt), the Responder decides the reply so the eval can continue unattended. It generalizes the
// pre-built `scripted_reply` into a pluggable STRATEGY (`scripted` | `policy` | `judge`), and is
// TRANSPORT-agnostic: lab.js maps the reply onto `--resume` (claude-code) or the adapter round-trip.
//
// haltEvent = { kind:'confirm'|'ask_user'|'permission', question?, options?, danger?, trace? }
//   danger.amountUsd (optional) lets `policy` enforce a spend cap.
// respond(haltEvent) => { reply, decision:'approve'|'deny', reason, strategy }

export const DEFAULT_APPROVE_REPLY = '确认，执行。';
export const DEFAULT_DENY_REPLY = '不，先不要执行，取消这个操作。';

export const RESPONDER_DEFAULTS = Object.freeze({
  strategy: 'policy',
  // policy: read-only auto-approves upstream (never reaches here); a write/confirm gate approves ONLY
  // when `approveWriteIf` is satisfied, else `default` (deny) — the safe industrial default.
  policy: { approveReadOnly: true, confirmWriteOps: true, approveWriteIf: null, default: 'deny' },
});

/** Policy engine: deterministic approve/deny for a write/confirm gate. */
export function policyDecide(policy, ev) {
  const p = { ...RESPONDER_DEFAULTS.policy, ...(policy || {}) };
  const aw = p.approveWriteIf;
  if (aw === 'always' || aw === true) return { decision: 'approve', reason: 'policy approveWriteIf=always' };
  if (aw && typeof aw === 'object' && typeof aw.maxUsd === 'number') {
    const amt = ev?.danger?.amountUsd;
    if (typeof amt === 'number') {
      return amt <= aw.maxUsd
        ? { decision: 'approve', reason: `policy: $${amt} ≤ cap $${aw.maxUsd}` }
        : { decision: 'deny', reason: `policy: $${amt} > cap $${aw.maxUsd}` };
    }
    return { decision: p.default === 'approve' ? 'approve' : 'deny', reason: 'policy: amount unknown → default' };
  }
  return { decision: p.default === 'approve' ? 'approve' : 'deny', reason: `policy: default ${p.default}` };
}

/**
 * Build a responder. Options:
 *   strategy   'scripted' | 'policy' | 'judge'
 *   scriptedReply   fixed reply for the 'scripted' strategy (task/suite-supplied)
 *   policy     rule table for the 'policy' strategy
 *   approveReply / denyReply   reply text mapped from an approve/deny decision
 *   judgeRespond(ev) => Promise<{decision, reply?, reason?}>   injected LLM user-simulator ('judge')
 */
export function makeResponder(opts = {}) {
  const cfg = { ...RESPONDER_DEFAULTS, ...opts };
  const approveReply = cfg.approveReply ?? DEFAULT_APPROVE_REPLY;
  const denyReply = cfg.denyReply ?? DEFAULT_DENY_REPLY;

  async function respond(ev = {}) {
    if (cfg.strategy === 'scripted') {
      const reply = cfg.scriptedReply ?? approveReply;
      return { reply, decision: 'approve', reason: 'scripted reply', strategy: 'scripted' };
    }
    if (cfg.strategy === 'judge') {
      if (typeof cfg.judgeRespond === 'function') {
        const r = await cfg.judgeRespond(ev);
        const decision = r?.decision === 'approve' ? 'approve' : 'deny';
        return { reply: r?.reply ?? (decision === 'approve' ? approveReply : denyReply),
          decision, reason: r?.reason ?? 'judge user-simulator', strategy: 'judge' };
      }
      // no judge transport available → fall back to policy (never silently approve)
    }
    const d = policyDecide(cfg.policy, ev);
    return { reply: d.decision === 'approve' ? approveReply : denyReply,
      decision: d.decision, reason: d.reason, strategy: 'policy' };
  }

  return { respond, config: cfg };
}
