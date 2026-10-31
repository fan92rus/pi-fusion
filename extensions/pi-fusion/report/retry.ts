/**
 * The FR-007 report retry (design rev.5.2 §4 "Report retry", TD-004):
 * after a `schemaFailed` attempt — the seam client's mapping of the host's
 * `structured_output_failed` and of completed-but-schema-violating answers
 * (M10-R3) — the worker gets EXACTLY ONE corrective request on the SAME
 * model, never a re-run of the brief (re-implementation would destroy the
 * finished work the report is about; the pi-agile lesson).
 *
 * Contract:
 * - the corrective text names the violated fields (report/validate.ts
 *   violatedFields()) and demands report-only output;
 * - the caller holds the model slot across both runs (TD-004): the task
 *   settles only when runReportRetry resolves — the slot is never released
 *   and never re-offered to other tasks mid-retry;
 * - the retry is a NEW attempt-scoped run: nodeId `<task.id>#a2` (the
 *   requestId carries `-a2-`), so the bridge's per-attempt node identity,
 *   released with attempt 1's terminal, cannot answer duplicate_node
 *   (B-3-R5);
 * - the retry's wall time is min(120s, the task's attempt-1 timeoutMs);
 * - a second schema failure is terminal: `failed` + `schemaMissing: true`,
 *   attempts = 2 — schema-missing is NOT a window-class outcome, so the
 *   FR-011 rate-limit counter does not grow for it (Q-002);
 * - usage/turns sum across BOTH runs; absent usage stays unknown (FR-010).
 */
import type { FanoutSeamClient, SeamOutcome } from "../seam/client.ts";
import type { ProgressSnapshot, TaskResult, UsageTotals } from "../types.ts";

/** Wall-time cap of the corrective attempt (design §Report retry). */
export const RETRY_TIMEOUT_MS = 120_000;

/** The corrective attempt is always the task's second worker launch (FR-007). */
export const RETRY_ATTEMPT = 2;

/**
 * «Твой предыдущий отчёт нарушал схему: {fields}. Верни ТОЛЬКО JSON-отчёт о
 * завершённой работе по схеме. Реализацию не повторять.» — {fields} is
 * violatedFields() of the rejected report; empty (no dangling colon) when the
 * host refused the answer before the engine saw a value — the retry must
 * still happen.
 */
export function correctiveRequest(violated: readonly string[]): string {
  const fields = violated.length > 0 ? `: ${violated.join(", ")}` : "";
  return `Твой предыдущий отчёт нарушал схему${fields}. Верни ТОЛЬКО JSON-отчёт о завершённой работе по схеме. Реализацию не повторять.`;
}

/** The FR-007 trigger: attempt 1's schemaFailed seam outcome. */
export type SchemaFailedOutcome = Extract<SeamOutcome, { kind: "schemaFailed" }>;

export interface SchemaRetryRequest {
  /** The task's id; the corrective run's nodeId is `<taskId>#a2`. */
  taskId: string;
  /** Attempt 1's schemaFailed outcome; its terminal usage joins the sum. */
  firstOutcome: SchemaFailedOutcome;
  /** The SAME model attempt 1 ran on (FR-007) — the caller keeps its slot. */
  model: string;
  /** violatedFields() of the rejected report; [] when the value never reached the engine. */
  violatedFields: readonly string[];
  /** Attempt 1's effective timeoutMs; the retry gets min(RETRY_TIMEOUT_MS, this). */
  attemptTimeoutMs: number;
  /** The task's hard tool budget, carried over unchanged (FR-008). */
  hardToolBudget: number;
  /** Receives attempt 2's cumulative :update snapshots. */
  onProgress?: (snapshot: ProgressSnapshot) => void;
}

export interface ReportRetryOutcome {
  /** The task's final row; attempts is always 2 (start + the one retry). */
  result: TaskResult;
  /** Σ terminal usage of BOTH runs; absent when neither run reported any (FR-010). */
  usage?: UsageTotals;
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

/** Σ of two terminal usages; only present fields sum — absence stays unknown. */
function sumUsage(
  first: UsageTotals | undefined,
  second: UsageTotals | undefined,
): UsageTotals | undefined {
  if (first === undefined) return second === undefined ? undefined : { ...second };
  if (second === undefined) return { ...first };
  const total: UsageTotals = {};
  for (const key of USAGE_KEYS) {
    const a = first[key];
    const b = second[key];
    if (a !== undefined || b !== undefined) {
      total[key] = (a ?? 0) + (b ?? 0);
    }
  }
  return total;
}

function failedRow(id: string, summary: string, error: string): TaskResult {
  return {
    id,
    status: "failed",
    summary,
    filesChanged: [],
    evidence: [],
    residualRisks: [],
    attempts: RETRY_ATTEMPT,
    error,
  };
}

/** turns/turnsObserved over both runs; keys exist only when known (B4-R1). */
interface RetryTelemetry {
  turns?: number;
  turnsObserved?: number;
}

/**
 * The corrective run's terminal outcome → the task's final row (design §5
 * mapping at attempts = 2): the report wins, a second schema failure is the
 * terminal schema-missing mark, everything else keeps its honest cause.
 */
function resultFromRetryOutcome(
  id: string,
  outcome: SeamOutcome,
  telemetry: RetryTelemetry,
): TaskResult {
  switch (outcome.kind) {
    case "report": {
      const { report } = outcome;
      return {
        id,
        status: report.status,
        summary: report.summary,
        filesChanged: [...report.filesChanged],
        evidence: [...report.evidence],
        residualRisks: [...report.residualRisks],
        ...(report.question !== undefined ? { question: report.question } : {}),
        attempts: RETRY_ATTEMPT,
        ...telemetry,
      };
    }
    case "schemaFailed":
      return {
        ...failedRow(
          id,
          "worker report violated the report schema (after the retry too)",
          "schema-missing",
        ),
        schemaMissing: true,
        ...telemetry,
      };
    case "timeout":
      return {
        ...failedRow(
          id,
          "retry hit the local deadline — taskTimeoutMs may be too small",
          "timeout",
        ),
        ...telemetry,
      };
    case "interrupted":
      return {
        ...failedRow(id, "retry was interrupted before finishing", "interrupted"),
        ...telemetry,
      };
    case "cancelled":
      return {
        id,
        status: "cancelled",
        summary: "cancelled before the retry finished",
        filesChanged: [],
        evidence: [],
        residualRisks: [],
        attempts: RETRY_ATTEMPT,
        ...telemetry,
      };
    case "unavailableContext":
      return {
        ...failedRow(
          id,
          "delegation seam could not run the retry (unavailable_context)",
          "seam-unavailable",
        ),
        ...telemetry,
      };
    case "hostError": {
      // First-class machine codes keep their names; the rest take host:<code>.
      const error =
        outcome.code === "max_steps" || outcome.code === "acceptance-failed"
          ? outcome.code
          : `host:${outcome.code}`;
      return { ...failedRow(id, `retry failed: ${outcome.message}`, error), ...telemetry };
    }
  }
}

/**
 * Runs THE corrective attempt (FR-007): one new run on the same model with
 * the report-only corrective request; resolves with the task's final row and
 * the usage summed over both runs. The caller holds the model slot from
 * attempt 1's terminal until this resolves (TD-004).
 */
export async function runReportRetry(
  client: FanoutSeamClient,
  req: SchemaRetryRequest,
): Promise<ReportRetryOutcome> {
  let turnsObserved: number | undefined;
  const outcome = await client.run({
    nodeId: `${req.taskId}#a${RETRY_ATTEMPT}`,
    task: correctiveRequest(req.violatedFields),
    model: req.model,
    timeoutMs: Math.min(RETRY_TIMEOUT_MS, req.attemptTimeoutMs),
    hardToolBudget: req.hardToolBudget,
    onProgress: (snapshot) => {
      turnsObserved = snapshot.turns;
      req.onProgress?.(snapshot);
    },
  });
  // unavailableContext answers without a child — no usage exists (§5).
  const usage = sumUsage(
    req.firstOutcome.usage,
    outcome.kind === "unavailableContext" ? undefined : outcome.usage,
  );
  const telemetry: RetryTelemetry = {};
  if (usage?.turns !== undefined) telemetry.turns = usage.turns;
  if (turnsObserved !== undefined) telemetry.turnsObserved = turnsObserved;
  const result = resultFromRetryOutcome(req.taskId, outcome, telemetry);
  return usage === undefined ? { result } : { result, usage };
}
