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
  "workers": 3,
  "maxParallel": 3,
  "taskTimeoutMs": 600000,
  "modelCooldownMs": 300000,
  "workerModels": ["vendor/cheap-model", "vendor/other-model"],
  "maxSteps": 60,
  "requireApproval": true,
  "blockedTools": ["fusion_delegate", "subagent", "codemode"],
  "leadBlockedTools": ["write", "edit", "bash"]
}
```

| Field | Meaning |
|---|---|
| `workers` / `maxParallel` | Requested width and the hard concurrency ceiling. |
| `taskTimeoutMs` | Per-task wall-time budget (30 000 … 3 600 000). |
| `modelCooldownMs` | Fallback model-cooldown length: default 300 000 (5 min), bounds 30 000 … 3 600 000 ms. Used when an error carries no retry-after time and for every timeout — see the cooldown section below. |
| `workerModels` | The rotation; **empty → every call is refused up front.** |
| `maxSteps` | Worker step budget. |
| `requireApproval` | Reserved for phase-2 approvals (not yet consumed). |
| `blockedTools` | Removed from every worker's toolset. |
| `leadBlockedTools` | Removed from the lead while fusion is on (F19). The default includes `subagent` (the native subagent is blocked for the lead); an explicit list replaces the default, so add `"subagent"` back to keep that block. |

Every field is re-read per call; the operator's edits apply without a reload.

### Project configuration — `.pi/fusion.json`

A project can override the global file per field with `<cwd>/.pi/fusion.json`
(the directory pi was started in). It takes the same fields as the global file.

- **Per-field overlay, replace not merge.** A field present and valid in the
  project file replaces the global value; the rest is inherited. Lists
  (`workerModels`, `blockedTools`, `leadBlockedTools`) are replaced whole — a
  local list does not extend the global one. An explicit `[]` is a valid
  override (e.g. `"leadBlockedTools": []` lifts the lead's blocks in this
  project only).
- **Invalid field = inherit + warn.** A bad value for one field is ignored
  with a warning; the field falls back to the lower layer.
- **Broken file = ignored on read, refused on write.** A project file that is
  not valid JSON or not a JSON object is ignored as a whole on read (one
  warning). Writes to it (menu edits, resets, shortcuts) are refused with the
  path and the reason; the file is never overwritten silently.
- **`/fusion config` switcher.** The first screen picks the layer: Global
  (`~/.pi/agent/fusion.json`) or Local (`.pi/fusion.json`); the Local label says
  whether the project file exists. Switching writes nothing. In the Local
  layer every field shows its effective value with its source: `[local]`,
  `[global]` or `[default]`. Editing a `[local]` field saves at once. Editing an
  inherited field asks for confirmation first ("override here?"), and that
  confirm is what creates the override. A `[local]` field also offers
  "Reset to inherited", which removes the key; when the last key goes, the
  project file is deleted. `↩️ Слой / Layer` returns to the switcher.
- **Shortcuts follow the file.** `/fusion workers|model|timeout` write to
  `.pi/fusion.json` when it exists, otherwise to the global file. They never
  create the project file.
- **Status.** `/fusion status` shows the source of each field: `[local]`,
  `[global]` or `[default]`.
- **Lead gate reads fresh.** The lead's `leadBlockedTools` is read on every
  check, so a local change applies without restarting pi.
- **Trust.** pi's project trust does not gate `.pi/fusion.json`: fusion reads
  it itself as soon as pi runs in the directory. Cloning a repo that ships
  `.pi/fusion.json` changes this project's fusion configuration (not the global
  one, and no code runs from it). Do not commit a file you do not trust, and
  review it when you clone someone else's repository.

## Activation (session-only)

Fusion activation lives in the **current session only** — there is no global
flag. State is held in memory for the session and restored from the session
history on `resume`/`reload`; `/fusion on` and `/fusion off` affect only the
current session. New sessions and forks start **off**.

Migration: an `enabled` field left in `fusion.json` is ignored (a single warn
per process) and the file is **not** rewritten — remove the field by hand if
desired. Headless: set `PI_FUSION_ON` to one of `1`, `true`, `yes` to enable
fusion on launch for that session; the variable never overrides an explicit
session decision, an empty value means "not set", and any other non-empty value
produces a warning.

## The `/fusion` command

`/fusion on` (activates `fusion_delegate` for the current session only, installs the
missing worker agent), `/fusion off`, `/fusion status`, `/fusion workers 4`,
`/fusion model vendor/a, vendor/b`, `/fusion timeout 300000`, `/fusion help`.
Model ids keep their case; numbers are validated against the same bounds the
config loader enforces.

## `fusion_delegate` — the contract

Input: 1..16 tasks (`id`, `title`, `instructions`, `deliverable?`, `files?`,
`inputs?`), validated by the ported atomic-agent rules (unknown fields
refused, render > 8 000 chars = refusal, `no_changes` requires empty
`filesChanged`).

Task fields (`instructions`, `title`, `deliverable`, `contract.provides[].shape`) are written in English; the operator's quoted request stays verbatim in its own language, labelled as such in the brief.

Output (`structuredContent` + text table): one row per task, in task order —
`status` (`done` / `failed` / `cancelled` / `needs_orchestrator` /
`structured_output_failed` …), `summary`, `filesChanged`, `evidence`,
`residualRisks`, `attempts`. Exactly one corrective retry for a malformed
report (same model, slot held). Usage is summed from terminal responses only;
absent numbers stay unknown (`usagePartial`), never faked as zero.

Sizing: `width = min(requested, tasks, maxParallel, 2 × |workerModels|)`;
per-model cap 2, round-robin rotation.

**Model cooldowns** (openspec `fusion-model-cooldown`):
- First offence cools: the FIRST window-class host error on a model (quota,
  rate limit exceeded, limit reached, plan/billing limit, or a bare `403`) — or
  its FIRST timeout — puts the model into a cooldown immediately (the old 5-error
  streak counter is gone). Overload (`429`), `interrupted`, `cancelled` and other
  host errors are not the model’s fault and never cool it.
- Duration comes from the error: a retry-after-like time in the text (`try again
  in 90 seconds`, `retry after 1m30s`, `wait 15 min`) is summed and clamped to
  30 s … 1 h. With no time in the text — and always for a timeout, which carries
  none — the effective `modelCooldownMs` is the length (default 5 min).
- A cooled model gets no NEW tasks for exactly that long; its running children
  are never cancelled and finish naturally. A repeat error never shortens the
  remaining cooldown (max rule); an expired cooldown returns the model to the
  rotation even mid-call.
- The cooldown state lives on the pi process: it survives every later `fusion_delegate`
  call and `/fusion on|off` toggles in that process (a rate limit belongs to the
  account, not to a project), and restarting pi resets it — cooldowns are never
  persisted.
- Fully cooled rotation = fail-fast: every task is `failed` with `no-available-model`
  and a summary naming each model, its reason and its remainder. A partial cooldown
  adds a `cooldown` clamp row only when it binds (2 × available models below the
  width), so a silent cooldown costs nothing.
- Visibility: `/fusion status` prints one indented row per cooling model of the
  effective rotation — `cooldown: <model> — <window quota|timeout>, still <Ns>`
  (remainder rounded up to whole seconds; Russian wording on a ru-* locale) — and
  the `modelCooldownMs: <value> ms [origin]` config line.

## Workers

`fusion-worker.md` (shipped, auto-installed by `/fusion on`) runs with a
tool allowlist (`read, grep, find, ls, bash, edit, write` — no delegation,
no codemode), fresh context, and must answer with the structured
`WorkerReport`. Workers never touch git or the issue tracker.

## The lead's restrictions (F19)

While fusion is enabled the lead cannot call `write`, `edit` or `bash` —
the doing belongs to the workers. After a fan-out the gate tells the lead to
review and re-dispatch; two consecutive zero-work fan-outs raise the barren
escalation. `/fusion off` frees the lead for this session immediately. The gate is inert in
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
