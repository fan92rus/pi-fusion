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
 * active model has fewer than 2 live workers; models rotate round-robin with
 * skipping saturated or excluded ones. FIFO: the queue IS the task-index
 * order and every slot release re-runs the dispatch.
 *
 * Rate-limit window (FR-011, TD-006): a window-class hostError bumps the
 * model's consecutive-failure counter, ANY other outcome of that model resets
 * it; at 5 the model leaves activeModels for the rest of the call — with NO
 * :cancel (its running children finish naturally; completed ones are
 * accepted, failed ones are terminal) and with no task retries: every failure
 * is terminal with its original cause (owner decision 2026-10-31).
 *
 * Drainage (B3/R2): when no active model remains, every not-yet-started task
 * is drained as failed(no-available-model) — a deadlock is impossible.
 * Empty rotation (B-FINAL): workerModels [] fails the whole call up front —
 * all tasks immediately failed(no-available-model), attempts 0, zero
 * :request emits, no timer that could revive the call.
 *
 * The pool does not know the brief format (it renders through briefs.ts) and
 * never touches a model for timeout/interrupted/overload — those are not the
 * model's fault (§8 edge cases).
 */
import { renderBrief } from "../briefs.ts";
import type { ValidatedFusionCall, ValidatedTask } from "../contract/validate.ts";
import { runReportRetry } from "../report/retry.ts";
import type { FanoutSeamClient, SeamOutcome } from "../seam/client.ts";
import type { ClampRow, FanoutResult, TaskResult, UsageTotals } from "../types.ts";

/** Consecutive window-class failures that exclude a model (FR-011). */
export const WINDOW_STREAK_LIMIT = 5;
/** Live workers allowed per model at any moment (FR-004). */
export const PER_MODEL_CAP = 2;
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
  /** Esc: abort → queued tasks cancel, in-flight children dispose. */
  signal?: AbortSignal;
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

function noModelResult(task: ValidatedTask): TaskResult {
  return failedTask(task.id, 0, "no-available-model", "no available model left in the rotation");
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
 * Runs the whole fan-out: pre-flight → width chain → FIFO schedule with the
 * per-model cap and the rate-limit window → aggregated FanoutResult.
 */
export async function runFanout(deps: FanoutDeps): Promise<FanoutResult | DegradationRefusal> {
  const { contract: call, config } = deps;
  if (!deps.available()) {
    return { seamUnavailable: true };
  }

  const tasks = call.tasks;
  const models = config.workerModels;
  const { width, clamps } = planFanoutWidth(call, config);

  // A width below 1 can never launch anything — fail the whole call now
  // instead of deadlocking the schedule (B-FINAL; the only config that
  // produces the noModels row is the empty rotation).
  if (width < 1) {
    return {
      results: tasks.map(noModelResult),
      clamps,
      usage: {},
      usagePartial: tasks.length > 0,
    };
  }

  const client = deps.makeClient();
  const signal = deps.signal;
  const activeModels = new Set(models);
  const runningByModel = new Map<string, number>();
  const windowStreak = new Map<string, number>();
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

  /** Round-robin over the rotation, skipping saturated/excluded models. */
  const pickModel = (): string | undefined => {
    for (let step = 0; step < models.length; step += 1) {
      const model = models[(cursor + step) % models.length];
      if (
        model !== undefined &&
        activeModels.has(model) &&
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

  const excludeModel = (model: string): void => {
    if (!activeModels.delete(model)) {
      return;
    }
    // Deliberately NO :cancel — the excluded model's running children keep
    // going; completed ones are accepted, failed ones stay terminal (FR-011).
    if (activeModels.size === 0) {
      drainQueue(noModelResult);
    }
  };

  /** Window counter: window-class failures count up, anything else resets. */
  const accountWindow = (model: string, outcome: SeamOutcome): void => {
    if (outcome.kind === "hostError" && outcome.windowClass) {
      const streak = (windowStreak.get(model) ?? 0) + 1;
      windowStreak.set(model, streak);
      if (streak >= WINDOW_STREAK_LIMIT) {
        excludeModel(model);
      }
      return;
    }
    windowStreak.set(model, 0);
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
    accountWindow(model, outcome);
    if (outcome.kind === "schemaFailed") {
      // FR-007 / TD-004: one corrective run on the same model; the slot stays
      // held until it settles. Its window outcome is not counted (Q-002).
      const budget = attemptBudget[index];
      if (budget === undefined) {
        throw new Error(`task ${task.id} settled without a launch budget`);
      }
      return runReportRetry(client, {
        taskId: task.id,
        firstOutcome: outcome,
        model,
        violatedFields: [],
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
          task: renderBrief(task, call.contract),
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
        // Every active model is saturated — wait for a release. The queue
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
    // Queued tasks can never launch now; in-flight children are disposed and
    // resolve as cancelled (F12: interrupted, not failed).
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
