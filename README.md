# pi-fusion

[pi](https://github.com/earendil-works/pi-coding-agent) extension implementing
Fusion mode (the Cognition lead + cheap workers split): the main session — the
**lead** — keeps one tool, `fusion_delegate`, and does only reading, planning
and reviewing; the actual doing is fanned out to ephemeral fresh-context
worker agents (a pool of cheap models) through the
[pi-subagents](https://www.npmjs.com/package/pi-subagents) delegation seam.

Spec source of truth: `.ai/sdd/` (spec `001-fanout-engine`, requirements +
design rev.5.2; plan `.ai/sdd/PLAN.md`).

## Install

```sh
pi install https://github.com/fan92rus/pi-fusion
# one-off without touching settings:
pi -e https://github.com/fan92rus/pi-fusion "…"
```

Requires node ≥ 22 (TypeBox sources load via jiti; no build step). CI runs
the four gates (test / typecheck / lint / build) on ubuntu + windows, node 22.

## Configuration — `~/.pi/agent/fusion.json`

```json
{
  "enabled": true,
  "workers": 3,
  "maxParallel": 3,
  "taskTimeoutMs": 600000,
  "workerModels": ["vendor/cheap-model", "vendor/other-model"],
  "maxSteps": 60,
  "requireApproval": true,
  "blockedTools": ["fusion_delegate", "subagent", "codemode"],
  "leadBlockedTools": ["write", "edit", "bash"]
}
```

| Field | Meaning |
|---|---|
| `enabled` | Feature flag: the tool is declared to the model only while true. |
| `workers` / `maxParallel` | Requested width and the hard concurrency ceiling. |
| `taskTimeoutMs` | Per-task wall-time budget (30 000 … 3 600 000). |
| `workerModels` | The rotation; **empty → every call is refused up front.** |
| `maxSteps` | Worker step budget. |
| `requireApproval` | Reserved for phase-2 approvals (not yet consumed). |
| `blockedTools` | Removed from every worker's toolset. |
| `leadBlockedTools` | Removed from the lead while fusion is on (F19). |

Every field is re-read per call; the operator's edits apply without a reload.

## The `/fusion` command

`/fusion on` (persists `enabled`, activates `fusion_delegate`, installs the
missing worker agent), `/fusion off`, `/fusion status`, `/fusion workers 4`,
`/fusion model vendor/a, vendor/b`, `/fusion timeout 300000`, `/fusion help`.
Model ids keep their case; numbers are validated against the same bounds the
config loader enforces.

## `fusion_delegate` — the contract

Input: 1..16 tasks (`id`, `title`, `instructions`, `deliverable?`, `files?`,
`inputs?`), validated by the ported atomic-agent rules (unknown fields
refused, render > 8 000 chars = refusal, `no_changes` requires empty
`filesChanged`).

Output (`structuredContent` + text table): one row per task, in task order —
`status` (`done` / `failed` / `cancelled` / `needs_orchestrator` /
`structured_output_failed` …), `summary`, `filesChanged`, `evidence`,
`residualRisks`, `attempts`. Exactly one corrective retry for a malformed
report (same model, slot held). Usage is summed from terminal responses only;
absent numbers stay unknown (`usagePartial`), never faked as zero.

Sizing: `width = min(requested, tasks, maxParallel, 2 × |workerModels|)`;
per-model cap 2, round-robin rotation; a model with 5 consecutive
window-class errors is excluded from NEW launches only (no cancels, no
restarts).

## Workers

`fusion-worker.md` (shipped, auto-installed by `/fusion on`) runs with a
tool allowlist (`read, grep, find, ls, bash, edit, write` — no delegation,
no codemode), fresh context, and must answer with the structured
`WorkerReport`. Workers never touch git or the issue tracker.

## The lead's restrictions (F19)

While fusion is enabled the lead cannot call `write`, `edit` or `bash` —
the doing belongs to the workers. After a fan-out the gate tells the lead to
review and re-dispatch; two consecutive zero-work fan-outs raise the barren
escalation. `/fusion off` frees the lead immediately. The gate is inert in
worker child processes (`PI_SUBAGENT_CHILD=1`).

## Honest degradation

Seam unavailable before the fan-out → the whole call is refused with the
single explicit order «fusion недоступен — делай работу сам» (FR-009). A
mid-run `unavailable_context` fails just that task (`seam-unavailable`); the
call continues with a partial result. Empty `workerModels` → the call fails
with per-task `no-available-model` rows; nothing launches, nothing is hidden.

## Live smoke

```sh
node --experimental-strip-types scripts/smoke/live-smoke.mts
```

Spawns real headless `pi --mode json` processes with this extension: checks
tool exposure (off/on), runs a 2-task fan-out with real workers on a
generated `smoke-repo/`, asserts the lead stays hands-off, usage is summed
and worker files are byte-exact, then checks the empty-rotation degradation.
Backs up and restores `~/.pi/agent/fusion.json` (and the worker agent file)
around the run. Exit 0 = all phases pass.

## Tests

```sh
npm test && npm run typecheck && npm run lint && npm run build
```

vitest suites cover the contract, the report schema/validate/retry, the seam
client (11-status table, mutation-checked), the pool (clamps, window,
drain), briefs, guidance, config, command, restrictions and the worker
installer — 350+ tests.
