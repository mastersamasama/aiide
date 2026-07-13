# S15 obs-skill-causal-compare — Requirements (EARS)

viewCompare top causal row `skill: hashA→hashB ⇒ ΔSkillScore`, reading `environment.skills[]`.
See docs §2.5b (~199-208), spec table S15.

## Acceptance criteria (hard)

- **R15.1** THE "⇒" causal arrow SHALL be used ONLY WHEN the two experiments share
  `suite.sha256` + model + runtime (comparability gate); OTHERWISE the row SHALL degrade to
  "correlational" and the existing cross-runtime warning SHALL fire. The prior warning (which
  only checked runtime + endpointHost, `web:615-616`) SHALL be extended to also compare
  `suite.sha256` + model. (AC 15a)
- **R15.2** THE row SHALL normally print only the delta; the `[within noise — CIs overlap]`
  caveat SHALL appear ONLY when every shared task's Wilson CIs overlap (not significant). (AC 15b)
- **R15.3** WHEN no skill hash changed, NO causal row SHALL be shown. (AC 15c)
- **R15.4** THE feature SHALL be read-only; nothing written back to any skill/suite. (AC 15d)

## Non-goals
- No decomposition of composite into per-skill contribution (fake precision). When >1 skill hash
  changed, the row degrades to correlational (the single-skill variable no longer holds).
