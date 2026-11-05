/**
 * The fan-out pool (design rev.5.2 §4 "Pool: ширина, клампы, расписание";
 * FR-003/FR-004/FR-011, B-FINAL, B3/R2, TD-003/TD-006).
 *
 * Width chain (FR-003): W_req = maxWorkers ?? config.workers and
 * width = min(W_req, tasks, config.maxParallel, 2 × |workerModels|), factors
 * applied in the order maxParallel → perModel → tasks. Every binding factor
 * emits one ClampRow whose `requested` is the width BEFORE it — the first
 * row's `requested` is therefore W_req, and there is deliberately no separate
 * "maxWorkers" row (MINOR-3-R7: no factor produces one).
 *
 * Schedule (FR-004): a task launches only while running < width AND some
 * rotation model has fewer than 2 live workers AND is not cooling; models
 * rotate round-robin, skipping saturated and cooling ones. FIFO: the queue IS
 * the task-index order and every slot release re-runs the dispatch.
 *
 * Model cooldown (openspec/changes/fusion-model-cooldown, design D3 "Integration
 * into pool/fanout.ts"; it OVERRIDES FR-011): the streak counter is gone — the
 * FIRST window-class hostError (quota/rate-limit markers plus the bare `403`
 * of D4), or the FIRST timeout, puts the model into a cooldown for the retry-after
 * time parsed out of the error text (fallback: config.modelCooldownMs), and a
 * cooled model is off dispatch for EXACTLY that long. `pickModel` re-reads the
 * injected store every cycle, so an expired cooldown returns the model to the
 * rotation mid-call; the "excluded for the rest of the call" semantics no longer
 * exist. A cooldown never sends :cancel — the model's running children finish
 * naturally, completed ones are accepted, failed ones stay terminal with their
 * original cause (owner decision 2026-10-31). `schemaFailed` keeps its FR-007
 * same-model corrective run and never cools: a schema violation is not the
 * model's fault. Overload, interrupted, cancelled, unavailableContext and
 * non-window host errors never cool (spec "Overload is not an account").
 *
 * Cooldown STATE (design D1): the store is injected through `FanoutDeps.cooldowns`
 * — the pool owns no cooldown state of its own. Production wires the process
 * singleton from index.ts, so a cooldown survives across `fusion_delegate` calls;
 * a caller that injects nothing gets a call-local store (cooldowns then cannot
 * cross calls, which is all such a caller asked for).
 *
 * Drainage (B3/R2): when no active model remains, every not-yet-started task
 * is drained as failed(no-available-model) — a deadlock is impossible.
 * Empty rotation (B-FINAL): workerModels [] fails the whole call up front —
 * all tasks immediately failed(no-available-model), attempts 0, zero
 * :request emits, no timer that could revive the call.
 *
 * The pool does not know the brief format (it renders through briefs.ts) and
 * never cools a model for interrupted/overload/non-window errors — those are
 * not the model's fault (§8 edge cases). A timeout IS counted now: design D3
 * made the first timeout cool the model (owner decision for this change).
 */
import { renderBrief } from "../briefs.ts";
import type { ValidatedFusionCall, ValidatedTask } from "../contract/validate.ts";
import { runReportRetry } from "../report/retry.ts";
import type { WorkerReport } from "../report/schema.ts";
import type { FanoutSeamClient, SeamOutcome } from "../seam/client.ts";
import type { ClampRow, FanoutResult, TaskResult, UsageTotals } from "../types.ts";
import {
  type Clock,
  type CooldownEntry,
  type CooldownStore,
  createCooldownStore,
  defaultClock,
  formatCooldownRemaining,
  parseRetryAfterMs,
} from "./cooldown.ts";

/** Live workers allowed per model at any moment (FR-004). */
export const PER_MODEL_CAP = 2;
/**
 * Clamp window for a retry-after parsed out of an error text: [30 000; 3 600 000]
 * ms. This is a MIRROR of `FUSION_CONFIG_BOUNDS.modelCooldownMs` (config.ts, D5):
 * importing config.ts here would close an import cycle against the
 * `config.ts → fanout.ts` type import of `FanoutConfig`, so the bounds are restated
 * locally and `test/config.test.ts` pins `COOLDOWN_CLAMP_MS` equal to
 * `FUSION_CONFIG_BOUNDS.modelCooldownMs` — the pair cannot drift unnoticed. The
 * clamp happens HERE (not in cooldown.ts) so the retry-after parser stays pure
 * (design D2), at the moment the cooldown is applied.
 */
export const COOLDOWN_CLAMP_MS = { min: 30_000, max: 3_600_000 } as const;
/** Per-task budget ceiling over the config base (atomic-agent port, FR-008). */
export const BUDGET_CEILING_FACTOR = 4;

/** FR-009 pre-flight refusal: the lead does the work itself, zero workers. */
export interface DegradationRefusal {
  readonly seamUnavailable: true;
}

/** Operator/bridge configuration the pool clamps against (design §4). */
export interface FanoutConfig {
  /** Default width when the call does not name maxWorkers (FR-003). */
  workers: number;
  /** Machine-level concurrency ceiling; first factor of the clamp chain. */
  maxParallel: number;
  /** Base wall-time budget per task; per-task values clamp at 4× this. */
  taskTimeoutMs: number;
  /** The model rotation; [] fails the whole call up front (B-FINAL). */
  workerModels: string[];
  /** Base step budget per task; becomes the seam's hard tool budget. */
  maxSteps: number;
  /**
   * Fallback cooldown length for a window error that carries no retry-after time
   * and for every timeout (spec "Duration cooldown is taken from the error", D5).
   * REQUIRED since task 2.3 moved the field into the config layers: the value is
   * always the operator's effective one (global file, project override or the
   * design default 300 000), so the pool keeps no cooldown length of its own and
   * a snapshot taken before the feature no longer compiles.
   */
  modelCooldownMs: number;
}

/** The cooldown state a fan-out reads and writes (design D1, D3). */
export interface CooldownDeps {
  store: CooldownStore;
  clock: Clock;
}

export interface FanoutDeps {
  /**
   * The call as the pool receives it in the design's data flow
   * (validate → availability → pool, §3): tasks carry their normalised
   * `title` so briefs never see the raw id (M3/N3-R4).
   */
  contract: ValidatedFusionCall;
  config: FanoutConfig;
  /** FR-009 pre-flight; false refuses the whole call before any launch. */
  available: () => boolean;
  makeClient: () => FanoutSeamClient;
  /** Esc (§8): abort → :cancel to every in-flight child, queued tasks cancel. */
  signal?: AbortSignal;
  /**
   * The operator's request that started the current run, quoted into every
   * brief as context (atomic-agent `pickOriginalRequest` precedent — briefs
   * are summaries, and thin summaries lose the job). Undefined/empty when
   * the extension could not capture it: the brief is then exactly as before.
   */
  originalRequest?: string;
  /**
   * The cooldown store the pool reads and writes (design D1 "the store is a
   * factory; index.ts passes the process singleton"). Injection only — the pool
   * keeps no cooldown map of its own; the optional marker exists so pre-feature
   * callers (and the older pool tests) still compile: without an injected store
   * `runFanout` creates one for the duration of the call, so cooldowns inside a
   * call work and simply cannot survive it.
   */
  cooldowns?: CooldownDeps;
}

export interface WidthPlan {
  /** Width the schedule dispatches against; 0 only when nothing can launch. */
  width: number;
  /** One row per binding factor, in application order. */
  clamps: ClampRow[];
}

/**
 * The width chain (FR-003, minor 1/N1-R3). Pure so tests can pin the row
 * order and the requested/applied bookkeeping without a running pool.
 */
export function planFanoutWidth(
  call: Pick<ValidatedFusionCall, "tasks" | "maxWorkers">,
  config: FanoutConfig,
  availableModels?: number,
): WidthPlan {
  const requested = call.maxWorkers ?? config.workers;
  const modelCount = config.workerModels.length;
  if (modelCount === 0) {
    return {
      width: 0,
      clamps: [
        {
          field: "noModels",
          requested,
          applied: 0,
          reason: "workerModels is empty — no launch is possible (B-FINAL)",
        },
      ],
    };
  }
  const clamps: ClampRow[] = [];
  let width = requested;
  const applyFactor = (field: ClampRow["field"], applied: number, reason: string): void => {
    clamps.push({ field, requested: width, applied, reason });
    width = applied;
  };
  if (config.maxParallel < width) {
    applyFactor("maxParallel", config.maxParallel, `config.maxParallel is ${config.maxParallel}`);
  }
  const capacity = PER_MODEL_CAP * modelCount;
  if (capacity < width) {
    applyFactor("perModel", capacity, `per-model cap ${PER_MODEL_CAP} × ${modelCount} model(s)`);
  }
  // The cooldown factor (design D3), right after perModel: perModel keeps the
  // FULL rotation, so a partially cooled rotation re-clamps against the models
  // actually available. A row appears only when the factor BINDS; with
  // availableModels === modelCount the capacity equals perModel's and the chain
  // stays byte-identical to the pre-feature chain (back-compat pin).
  const available = availableModels ?? modelCount;
  const coolCapacity = PER_MODEL_CAP * available;
  if (coolCapacity < width) {
    applyFactor(
      "cooldown",
      coolCapacity,
      available === 0
        ? `all ${modelCount} model(s) cooling down — the rotation is empty at plan time`
        : `per-model cap ${PER_MODEL_CAP} × ${available} of ${modelCount} model(s) cool`,
    );
  }
  if (call.tasks.length < width) {
    applyFactor("tasks", call.tasks.length, `the call carries ${call.tasks.length} task(s)`);
  }
  return { width, clamps };
}

const USAGE_KEYS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "cost",
  "turns",
  "toolCalls",
  "durationMs",
] as const;

/** Sums only the present fields; absence stays unknown, never 0 (FR-010). */
function addUsage(total: UsageTotals, addition: UsageTotals | undefined): void {
  if (addition === undefined) return;
  for (const key of USAGE_KEYS) {
    const value = addition[key];
    if (value !== undefined) {
      total[key] = (total[key] ?? 0) + value;
    }
  }
}

function failedTask(id: string, attempts: number, error: string, summary: string): TaskResult {
  return {
    id,
    status: "failed",
    summary,
    filesChanged: [],
    evidence: [],
    residualRisks: [],
    attempts,
    error,
  };
}

function cancelledTask(id: string, attempts: number, summary: string): TaskResult {
  return {
    id,
    status: "cancelled",
    summary,
    filesChanged: [],
    evidence: [],
    residualRisks: [],
    attempts,
  };
}

function noModelResult(task: ValidatedTask, reason: string): TaskResult {
  return failedTask(task.id, 0, "no-available-model", reason);
}

/**
 * The honest fail-fast/drained summary (spec "Fully cooled rotation is fail-fast"):
 * every cooling model, its reason and its remainder in whole seconds.
 */
function cooldownReason(rows: CooldownEntry[]): string {
  if (rows.length === 0) {
    return "no available model left in the rotation";
  }
  const list = rows.map(
    (row) => `${row.model} ${row.reason} ${formatCooldownRemaining(row.remainingMs)}`,
  );
  return `all ${rows.length} model(s) cooling down — ${list.join(", ")} — nothing can launch before their cooldowns expire`;
}

/** Role report fields a report may carry; copied through when present (§4.8, B3). */
const ROLE_REPORT_FIELDS = ["sources", "unknowns", "findings", "checksRun", "verdict"] as const;

/** Copies the role fields the report carried; worker reports carry none. */
function roleReportFields(
  report: WorkerReport,
): Partial<Pick<TaskResult, (typeof ROLE_REPORT_FIELDS)[number]>> {
  const carried = {} as Record<string, unknown>;
  for (const field of ROLE_REPORT_FIELDS) {
    const value = (report as Record<string, unknown>)[field];
    if (value !== undefined) carried[field] = value;
  }
  return carried as Partial<Pick<TaskResult, (typeof ROLE_REPORT_FIELDS)[number]>>;
}

/** Maps one seam outcome onto the task's row (design §5 table, §4 result). */
function resultFromOutcome(
  task: ValidatedTask,
  outcome: SeamOutcome,
  attempts: number,
  turnsObserved: number | undefined,
  usage: UsageTotals | undefined,
): TaskResult {
  const id = task.id;
  const turns = usage?.turns;
  const withTelemetry = (result: TaskResult): TaskResult => ({
    ...result,
    ...(turns !== undefined ? { turns } : {}),
    ...(turnsObserved !== undefined ? { turnsObserved } : {}),
  });
  switch (outcome.kind) {
    case "report": {
      const { report } = outcome;
      return withTelemetry({
        id,
        status: report.status,
        summary: report.summary,
        filesChanged: [...report.filesChanged],
        evidence: [...report.evidence],
        residualRisks: [...report.residualRisks],
        ...(report.question !== undefined ? { question: report.question } : {}),
        // Role fields the report carried (§4.8, B3): scout sources,
        // researcher sources+unknowns, reviewer findings+checksRun+verdict.
        ...roleReportFields(report),
        attempts,
      });
    }
    case "schemaFailed":
      return withTelemetry({
        ...failedTask(id, attempts, "schema-missing", "worker report violated the report schema"),
        schemaMissing: true,
      });
    case "timeout":
      return withTelemetry(
        failedTask(
          id,
          attempts,
          "timeout",
          "worker hit the local deadline — taskTimeoutMs may be too small",
        ),
      );
    case "interrupted":
      return withTelemetry(
        failedTask(id, attempts, "interrupted", "worker was interrupted before finishing"),
      );
    case "cancelled":
      return withTelemetry(cancelledTask(id, attempts, "cancelled before the worker finished"));
    case "unavailableContext":
      return withTelemetry(
        failedTask(
          id,
          attempts,
          "seam-unavailable",
          "delegation seam could not run the child (unavailable_context)",
        ),
      );
    case "hostError": {
      // max_steps and acceptance-failed are first-class machine codes
      // (design §4 error list); the rest keep the host:<code> form.
      const error =
        outcome.code === "max_steps" || outcome.code === "acceptance-failed"
          ? outcome.code
          : `host:${outcome.code}`;
      return withTelemetry(failedTask(id, attempts, error, `worker failed: ${outcome.message}`));
    }
  }
}

/**
 * Runs the whole fan-out: pre-flight → width chain (with the cooldown factor)
 * → FIFO schedule with the per-model cap and the cooldown → aggregated FanoutResult.
 * The cooldown store comes in through `deps.cooldowns` (design D1/D3).
 */
export async function runFanout(deps: FanoutDeps): Promise<FanoutResult | DegradationRefusal> {
  const { contract: call, config } = deps;
  if (!deps.available()) {
    return { seamUnavailable: true };
  }

  const tasks = call.tasks;
  const models = config.workerModels;
  // D1: the store and the clock come from the caller (production: index.ts'
  // process singleton + defaultClock). Without an injected store the state is
  // call-local — created here, never at module level (design D1: "injection only").
  const cooldowns = deps.cooldowns ?? {
    store: createCooldownStore(),
    clock: defaultClock,
  };
  const store = cooldowns.store;
  const clock = cooldowns.clock;
  // D5: the fallback length is the config field, required — no pool-side default.
  const cooldownFallback = config.modelCooldownMs;
  // The width chain is planned against the rotation AS IT IS NOW (design D3:
  // clamp rows are a start-of-call snapshot; dispatch re-reads the store).
  const coolingAtPlan = store.activeCooldowns(models, clock.now());
  const { width, clamps } = planFanoutWidth(call, config, models.length - coolingAtPlan.length);

  // A width below 1 can never launch anything — fail the whole call now instead
  // of deadlocking the schedule. Two shapes reach this branch: the empty rotation
  // (the noModels row, B-FINAL) and a rotation that is entirely cooling at plan
  // time (the cooldown row, the same B-FINAL shape with an honest reason).
  if (width < 1) {
    const blocked = store.activeCooldowns(models, clock.now());
    return {
      results: tasks.map((task) => noModelResult(task, cooldownReason(blocked))),
      clamps,
      usage: {},
      usagePartial: tasks.length > 0,
    };
  }

  const client = deps.makeClient();
  const signal = deps.signal;
  const runningByModel = new Map<string, number>();
  const results: Array<TaskResult | undefined> = new Array(tasks.length);
  const attempts = new Array<number>(tasks.length).fill(0);
  const observedTurns: Array<number | undefined> = new Array(tasks.length).fill(undefined);
  const attemptUsage: Array<UsageTotals | undefined> = new Array(tasks.length).fill(undefined);
  // First-attempt budgets, carried into the FR-007 corrective run (same limits).
  const attemptBudget: Array<{ timeoutMs: number; hardToolBudget: number } | undefined> = new Array(
    tasks.length,
  ).fill(undefined);
  const queue = tasks.map((task, index) => ({ task, index }));
  const launches: Array<Promise<void>> = [];
  let running = 0;
  let cursor = 0;
  let aborted = false;

  /**
   * The cooling models of the rotation right now — reading the store also sweeps
   * the entries that already expired, which is how a model comes back to the
   * rotation MID-CALL (design D3, the FR-011 override).
   */
  const coolingNow = (): CooldownEntry[] => store.activeCooldowns(models, clock.now());

  /**
   * Round-robin over the rotation, skipping saturated models and cooling ones.
   * The store is consulted EVERY cycle, so an expired cooldown returns the model
   * to dispatch mid-call; cooldown is the ONLY reason a model is invisible now
   * (the old "excluded for the rest of the call" semantics are gone).
   */
  const pickModel = (): string | undefined => {
    const now = clock.now();
    for (let step = 0; step < models.length; step += 1) {
      const model = models[(cursor + step) % models.length];
      if (
        model !== undefined &&
        !store.isCooling(model, now) &&
        (runningByModel.get(model) ?? 0) < PER_MODEL_CAP
      ) {
        cursor = (cursor + step + 1) % models.length;
        return model;
      }
    }
    return undefined;
  };

  const drainQueue = (fill: (task: ValidatedTask) => TaskResult): void => {
    for (const entry of queue.splice(0)) {
      results[entry.index] = fill(entry.task);
    }
  };

  /** Every model of a non-empty rotation is cooling, so nothing can launch. */
  const everyModelCools = (): boolean => {
    if (models.length === 0) {
      return false;
    }
    const now = clock.now();
    return models.every((model) => store.isCooling(model, now));
  };

  /**
   * The cooldown itself (design D3) — the successor of FR-011's `accountWindow`,
   * which is deleted together with WINDOW_STREAK_LIMIT, `windowStreak` and
   * `excludeModel`. Only two outcomes cool a model:
   *  - a window-class hostError (quota/rate-limit markers, or the bare 403 of
   *    D4): duration = retry-after parsed out of the error text, clamped to
   *    COOLDOWN_CLAMP_MS — the local mirror of FUSION_CONFIG_BOUNDS.modelCooldownMs,
   *    pinned equal to it by config.test.ts — falling back to config.modelCooldownMs;
   *  - a timeout: duration = config.modelCooldownMs (a timeout carries no time).
   * Everything else — report, schemaFailed, interrupted, cancelled,
   * unavailableContext, a non-window hostError, the transient 429-overload —
   * leaves the model alone. `schemaFailed` in particular keeps its FR-007
   * same-model corrective run and NEVER cools: a schema violation is the
   * report's shape, not the model's fault (Q-002, design D3).
   *
   * Cooling never sends :cancel and never re-runs a task: the model's flying
   * children finish naturally and every failure stays terminal with its own
   * cause (owner decision 2026-10-31).
   */
  const applyCooldown = (model: string, outcome: SeamOutcome): void => {
    const at = clock.now();
    if (outcome.kind === "hostError" && outcome.windowClass) {
      const parsed = parseRetryAfterMs(outcome.message);
      const durationMs =
        parsed === undefined
          ? cooldownFallback
          : Math.min(COOLDOWN_CLAMP_MS.max, Math.max(COOLDOWN_CLAMP_MS.min, parsed));
      store.enterCooldown(model, "window", durationMs, at);
      return;
    }
    if (outcome.kind === "timeout") {
      store.enterCooldown(model, "timeout", cooldownFallback, at);
    }
  };

  /** Releases the model slot and records the task's final row. */
  const finish = (
    index: number,
    model: string,
    row: TaskResult,
    usage: UsageTotals | undefined,
  ): void => {
    running = Math.max(0, running - 1);
    runningByModel.set(model, Math.max(0, (runningByModel.get(model) ?? 0) - 1));
    attemptUsage[index] = usage;
    results[index] = row;
    dispatch();
  };

  const settle = (
    task: ValidatedTask,
    index: number,
    model: string,
    outcome: SeamOutcome,
  ): Promise<void> | void => {
    applyCooldown(model, outcome);
    if (outcome.kind === "schemaFailed") {
      // FR-007 / TD-004: one corrective run on the SAME model; the slot stays
      // held until it settles. The retry's own outcome is not counted against
      // the model either (Q-002), and applyCooldown already passed over the
      // schemaFailed outcome itself — a schema violation never cools a model.
      const budget = attemptBudget[index];
      if (budget === undefined) {
        throw new Error(`task ${task.id} settled without a launch budget`);
      }
      return runReportRetry(client, {
        taskId: task.id,
        role: task.role,
        brief: renderBrief(task, call.contract, deps.originalRequest),
        firstOutcome: outcome,
        model,
        violatedFields: outcome.violatedFields ?? [],
        attemptTimeoutMs: budget.timeoutMs,
        hardToolBudget: budget.hardToolBudget,
      }).then((retried) => {
        finish(index, model, retried.result, retried.usage);
      });
    }
    // unavailableContext answers without a child — no usage exists (§5).
    const usage = outcome.kind === "unavailableContext" ? undefined : outcome.usage;
    const launched = attempts[index] ?? 0;
    finish(
      index,
      model,
      resultFromOutcome(task, outcome, launched, observedTurns[index], usage),
      usage,
    );
  };

  const launch = (entry: { task: ValidatedTask; index: number }, model: string): void => {
    const { task, index } = entry;
    attempts[index] = 1;
    running += 1;
    runningByModel.set(model, (runningByModel.get(model) ?? 0) + 1);
    const timeoutMs = Math.min(
      task.timeoutMs ?? config.taskTimeoutMs,
      BUDGET_CEILING_FACTOR * config.taskTimeoutMs,
    );
    const hardToolBudget = Math.min(
      task.maxSteps ?? config.maxSteps,
      BUDGET_CEILING_FACTOR * config.maxSteps,
    );
    attemptBudget[index] = { timeoutMs, hardToolBudget };
    launches.push(
      client
        .run({
          nodeId: `${task.id}#a1`,
          task: renderBrief(task, call.contract, deps.originalRequest),
          role: task.role,
          model,
          timeoutMs,
          hardToolBudget,
          onProgress: (snapshot) => {
            observedTurns[index] = snapshot.turns;
          },
        })
        .then((outcome) => settle(task, index, model, outcome)),
    );
  };

  /** FIFO by task index; every slot release re-runs the dispatch. */
  function dispatch(): void {
    while (!aborted && queue.length > 0 && running < width) {
      const model = pickModel();
      if (model === undefined) {
        if (everyModelCools()) {
          // The whole rotation cooled down mid-call: a cooldown is not a stall
          // the queue may wait for (failures stay terminal), so the rest of the
          // queue drains with the honest reason (B3/R2 drainage, D3).
          drainQueue((task) => noModelResult(task, cooldownReason(coolingNow())));
          break;
        }
        // Every available model is saturated — wait for a release. The queue
        // entry stays put; it is neither lost nor drained here.
        break;
      }
      const next = queue.shift();
      if (next === undefined) {
        break;
      }
      launch(next, model);
    }
  }

  const onAbort = (): void => {
    if (aborted) {
      return;
    }
    aborted = true;
    // Esc (design §8): stop the in-flight children first — one :cancel each —
    // then dispose() resolves whatever is left as cancelled (F12: interrupted,
    // not failed).
    client.cancelAllPending();
    // Queued tasks can never launch now.
    drainQueue((task) => cancelledTask(task.id, 0, "cancelled before launch"));
    client.dispose();
  };

  try {
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    dispatch();
    // dispatch() appends while settles run — drain in batches, not one all().
    while (launches.length > 0) {
      const batch = launches.splice(0);
      await Promise.all(batch);
    }

    const usage: UsageTotals = {};
    for (const entry of attemptUsage) {
      addUsage(usage, entry);
    }
    const filled: TaskResult[] = results.map((result, index) => {
      const task = tasks[index];
      return result ?? failedTask(task?.id ?? "", 0, "no-available-model", "task never launched");
    });
    return {
      results: filled,
      clamps,
      usage,
      usagePartial: attemptUsage.some((entry) => entry === undefined),
    };
  } finally {
    client.dispose();
    signal?.removeEventListener("abort", onAbort);
  }
}
