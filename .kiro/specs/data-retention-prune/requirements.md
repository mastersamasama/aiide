# S11 · data-retention-prune (CLI part) — Requirements (EARS)

> Design authority: `docs/aiide-update-solution.md` §4.2 + spec table S11.
> Iron rule (hard): server stays READ-ONLY — retention is CLI-only, NO DELETE endpoint. The dashboard
> read-only "what would be deleted" hint is Phase 2b (web) — NOT in this scope.

## Requirements

R1 — `aiide prune`
- R1.1 `aiide prune --older-than <dur>` and/or `--max <N>` SHALL select stale runs + experiments.
  `--older-than` deletes items older than the duration (s/m/h/d/w); `--max N` keeps the newest N per
  collection. At least one selector is required (never prune everything by accident).
- R1.2 Item age SHALL come from `run.startedAt` / `experiment.createdAt`, falling back to file mtime.

R2 — Preview then confirm (AC)
- R2.1 The system SHALL print a preview (counts + sample ids + reclaimed bytes) and delete NOTHING
  unless `--yes` is passed.
- R2.2 WITH `--yes`, the system SHALL delete the selected run/experiment files AND each deleted
  sealed experiment's annotations sidecar (`annotations/<id>.json`).

R3 — Safety (AC)
- R3.1 Prune SHALL touch ONLY `runs/*.json`, `experiments/*.json`, `annotations/*.json`. It SHALL NEVER
  touch `settings.json`, `pricing.json`, `service.env`, or in-progress journals
  (`experiments/.inprogress/*.jsonl`) — those are excluded structurally (non-recursive readdir +
  `endsWith('.json')`).
- R3.2 NO server DELETE endpoint is added (server.js untouched).
</content>
