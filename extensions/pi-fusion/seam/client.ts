/**
 * The fan-out's seam client (design rev.5.2 §4 `seam/client.ts`, §5 Seam
 * Protocol; FR-008/FR-009/FR-010). One client per fan-out (TD-001): it owns
 * the ownerRunId, the :request/:cancel emits, the :update/:response routing
 * by requestId, the local grace deadline and the mapping of all 11
 * SubagentDelegationStatus literals onto SeamOutcome.
 *
 * Wire shapes are structural copies of pi-subagents src/api/delegation.d.ts
 * (the subset this client reads); the status rules are those of
 * src/slash/delegation-adapters.js. The shapes are pinned here, not imported:
 * pi-subagents is not a dependency of pi-fusion.
 */
import type { EventBus } from "@earendil-works/pi-coding-agent";
import { type WorkerReport, WorkerReportSchema } from "../report/schema.ts";
import { violatedFields } from "../report/validate.ts";
import type { ProgressSnapshot, UsageTotals } from "../types.ts";

export const SEAM_REQUEST_EVENT = "prompt-template:subagent:request";
export const SEAM_UPDATE_EVENT = "prompt-template:subagent:update";
export const SEAM_RESPONSE_EVENT = "prompt-template:subagent:response";
export const SEAM_CANCEL_EVENT = "prompt-template:subagent:cancel";

/** Local deadline = timeoutMs + this grace; expiry sends :cancel (design §5). */
export const SEAM_GRACE_MS = 15_000;

const WORKER_AGENT = "fusion-worker";
/** Tools a fusion worker may never call (design §5 toolBudget.block). */
const BLOCKED_TOOLS = ["fusion_delegate", "subagent", "codemode"];

/** Window (quota) markers, Q-002 class 1 — case-insensitive substrings. */
const WINDOW_MARKERS = /quota|rate limit exceeded|limit reached|(?:plan|billing) limit/i;
/** Overload markers, Q-002 class 2 — transient, never counted against a model. */
const OVERLOAD_MARKERS = /overloaded|server busy|too many concurrent|try again later|\b529\b/i;

/** The 11 SubagentDelegationStatus literals (delegation.d.ts:81-92). */
export type SeamStatus =
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "interrupted"
  | "tool_budget_exhausted"
  | "structured_output_failed"
  | "acceptance_failed"
  | "invalid_request"
  | "unavailable_context"
  | "duplicate_node";

/** SubagentDelegationUsage: the terminal usage of one attempt. */
export interface SeamUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
  /** 0 = no data (the adapter's `?? 0`). */
  toolCalls: number;
  /** 0 = no data (the adapter's `?? 0`). */
  durationMs: number;
}

/** A terminal response (or the invalid-request variant, which has no usage). */
export interface SeamResponse {
  requestId: string;
  ownerRunId?: string;
  nodeId?: string;
  status: SeamStatus;
  error?: string;
  result?: { kind: "text"; text: string } | { kind: "structured"; value: unknown };
  usage?: SeamUsage;
}

interface SeamUpdate {
  requestId: string;
  /** Cumulative snapshot of ONE attempt; absent when the snapshot is not known. */
  usage?: ProgressSnapshot;
}

interface SeamRequest {
  requestId: string;
  ownerRunId: string;
  nodeId: string;
  agent: string;
  task: string;
  context: "fresh";
  cwd: string;
  model: string;
  timeoutMs: number;
  toolBudget: { hard: number; block: string[] };
  result: { kind: "structured"; schema: Record<string, unknown> };
}

/**
 * Result of one run() — the mapping of the seam's answer (design §5 table).
 * `usage` is attached to every terminal outcome that carried it; the local
 * grace timeout and the dispose-resolve carry none (= unknown, not zero).
 */
export type SeamOutcome =
  | { kind: "report"; report: WorkerReport; usage?: UsageTotals }
  | { kind: "schemaFailed"; violatedFields?: string[]; usage?: UsageTotals }
  | { kind: "timeout"; usage?: UsageTotals }
  | { kind: "interrupted"; usage?: UsageTotals }
  | { kind: "cancelled"; usage?: UsageTotals }
  | { kind: "unavailableContext" }
  | {
      kind: "hostError";
      code: string;
      message: string;
      /** true ONLY for the window class (Q-002 class 1) — counts against the model. */
      windowClass: boolean;
      usage?: UsageTotals;
    };

export interface SeamRunRequest {
  /** `<task.id>#a<attempt>`; the attempt suffix makes each retry a new node. */
  nodeId: string;
  task: string;
  model: string;
  timeoutMs: number;
  hardToolBudget: number;
  /** Receives each cumulative :update usage snapshot of THIS attempt. */
  onProgress?: (snapshot: ProgressSnapshot) => void;
}

export interface FanoutSeamClient {
  run(req: SeamRunRequest): Promise<SeamOutcome>;
  /** Sends :cancel {requestId, ownerRunId, nodeId} for an in-flight request. */
  cancel(requestId: string): void;
  /**
   * Sends :cancel {requestId, ownerRunId, nodeId} for every pending request
   * and then resolves each as {kind:"cancelled"} (design §8 Esc row). Pending
   * entries are dropped BEFORE the emits, so neither a second sweep nor the
   * single-request cancel() can ever emit twice for the same requestId.
   */
  cancelAllPending(): void;
  /** Unsubscribes and resolves every pending run as {kind:"cancelled"}. */
  dispose(): void;
}

export interface FanoutSeamClientOptions {
  events: EventBus;
  /** Session cwd sent with every worker request. */
  cwd: string;
}

interface PendingRun {
  readonly requestId: string;
  readonly nodeId: string;
  readonly onProgress?: (snapshot: ProgressSnapshot) => void;
  readonly resolve: (outcome: SeamOutcome) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const NODE_ID_PATTERN = /^(.+)#a(\d+)$/;

let fanoutSeq = 0;
let requestSeq = 0;

/** Splits `<task.id>#a<attempt>`; the attempt keeps its written digits. */
function parseNodeId(nodeId: string): { taskId: string; attempt: string } {
  const match = NODE_ID_PATTERN.exec(nodeId);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`seam nodeId must be "<task.id>#a<attempt>", got ${JSON.stringify(nodeId)}`);
  }
  return { taskId: match[1], attempt: match[2] };
}

/**
 * Three-class host-error classification (Q-002 / FR-011). The window class
 * keeps the generic `failed` code (design §5 `hostError(code:"failed")`);
 * overload is `429-overload` (requirements FR-011: failed(host:429-overload)).
 */
function classifyFailure(error: string | undefined): { code: string; windowClass: boolean } {
  const text = error ?? "";
  if (WINDOW_MARKERS.test(text)) return { code: "failed", windowClass: true };
  if (OVERLOAD_MARKERS.test(text)) return { code: "429-overload", windowClass: false };
  return { code: "failed", windowClass: false };
}

/** Terminal usage: `0` for toolCalls/durationMs is "no data" (adapter `?? 0`). */
function toUsageTotals(usage: SeamUsage): UsageTotals {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    cost: usage.cost,
    turns: usage.turns,
    ...(usage.toolCalls !== 0 ? { toolCalls: usage.toolCalls } : {}),
    ...(usage.durationMs !== 0 ? { durationMs: usage.durationMs } : {}),
  };
}

function carriedUsage(usage: SeamUsage | undefined): { usage?: UsageTotals } {
  return usage === undefined ? {} : { usage: toUsageTotals(usage) };
}

/** Maps one terminal seam response onto SeamOutcome (design §5 table). */
function toOutcome(response: SeamResponse): SeamOutcome {
  const carried = carriedUsage(response.usage);
  const message = response.error ?? response.status;
  switch (response.status) {
    case "cancelled":
      return { kind: "cancelled", ...carried };
    case "failed": {
      const { code, windowClass } = classifyFailure(response.error);
      return { kind: "hostError", code, message, windowClass, ...carried };
    }
    case "timed_out":
      return { kind: "timeout", ...carried };
    case "structured_output_failed":
      return { kind: "schemaFailed", ...carried };
    case "tool_budget_exhausted":
      return { kind: "hostError", code: "max_steps", message, windowClass: false, ...carried };
    case "acceptance_failed":
      return {
        kind: "hostError",
        code: "acceptance-failed",
        message,
        windowClass: false,
        ...carried,
      };
    case "interrupted":
      return { kind: "interrupted", ...carried };
    case "completed": {
      const result = response.result;
      if (result === undefined || result.kind !== "structured") {
        // Adapter rule: completed without structuredOutput is a host anomaly,
        // not a schema violation — no FR-007 retry (design §5).
        return {
          kind: "hostError",
          code: "no-structured-output",
          message,
          windowClass: false,
          ...carried,
        };
      }
      const fields = violatedFields(result.value);
      if (fields.length > 0) {
        // Completed-but-invalid: retain the exact violated fields for the
        // FR-007 corrective brief. The host-refused structured_output_failed
        // mapping above carries none — the value never reached the engine.
        return { kind: "schemaFailed", violatedFields: fields, ...carried };
      }
      return { kind: "report", report: result.value as WorkerReport, ...carried };
    }
    case "unavailable_context":
      // The bridge answered without a child: no usage is carried (MINOR-1-R7).
      return { kind: "unavailableContext" };
    case "invalid_request":
      return { kind: "hostError", code: "invalid_request", message, windowClass: false };
    case "duplicate_node":
      return { kind: "hostError", code: "duplicate_node", message, windowClass: false };
    default: {
      const unreachable: never = response.status;
      return unreachable;
    }
  }
}

export function createFanoutSeamClient(options: FanoutSeamClientOptions): FanoutSeamClient {
  const { events, cwd } = options;
  fanoutSeq += 1;
  // One ownerRunId per fan-out (design §5): fusion-<seq>-<ts>.
  const ownerRunId = `fusion-${fanoutSeq}-${Date.now()}`;
  const pending = new Map<string, PendingRun>();
  let disposed = false;

  const emitCancel = (entry: PendingRun): void => {
    events.emit(SEAM_CANCEL_EVENT, {
      requestId: entry.requestId,
      ownerRunId,
      nodeId: entry.nodeId,
    });
  };

  /** Resolves a run once; a settled or timed-out requestId is no longer pending. */
  const settle = (entry: PendingRun, outcome: SeamOutcome): void => {
    if (pending.get(entry.requestId) !== entry) return;
    pending.delete(entry.requestId);
    clearTimeout(entry.timer);
    entry.resolve(outcome);
  };

  const onUpdate = (update: SeamUpdate): void => {
    const entry = pending.get(update.requestId);
    if (entry?.onProgress === undefined || update.usage === undefined) return;
    const { input, output, cacheRead, cacheWrite, turns } = update.usage;
    entry.onProgress({ input, output, cacheRead, cacheWrite, turns });
  };

  const onResponse = (response: SeamResponse): void => {
    const entry = pending.get(response.requestId);
    if (entry === undefined) return;
    settle(entry, toOutcome(response));
  };

  const offs: Array<() => void> = [
    events.on(SEAM_UPDATE_EVENT, (data) => onUpdate(data as SeamUpdate)),
    events.on(SEAM_RESPONSE_EVENT, (data) => onResponse(data as SeamResponse)),
  ];

  return {
    run(req) {
      const { taskId, attempt } = parseNodeId(req.nodeId);
      if (disposed) return Promise.resolve({ kind: "cancelled" });
      requestSeq += 1;
      const requestId = `fusion-${taskId}-a${attempt}-${requestSeq}-${Date.now()}`;
      const request: SeamRequest = {
        requestId,
        ownerRunId,
        nodeId: req.nodeId,
        agent: WORKER_AGENT,
        task: req.task,
        context: "fresh",
        cwd,
        model: req.model,
        timeoutMs: req.timeoutMs,
        toolBudget: { hard: req.hardToolBudget, block: [...BLOCKED_TOOLS] },
        result: { kind: "structured", schema: WorkerReportSchema as Record<string, unknown> },
      };
      return new Promise<SeamOutcome>((resolve) => {
        const entry: PendingRun = {
          requestId,
          nodeId: req.nodeId,
          ...(req.onProgress !== undefined ? { onProgress: req.onProgress } : {}),
          resolve,
        };
        entry.timer = setTimeout(() => {
          // Local deadline: stop the child, then report timeout with no usage.
          emitCancel(entry);
          settle(entry, { kind: "timeout" });
        }, req.timeoutMs + SEAM_GRACE_MS);
        pending.set(requestId, entry);
        events.emit(SEAM_REQUEST_EVENT, request);
      });
    },

    cancel(requestId) {
      const entry = pending.get(requestId);
      if (entry !== undefined) emitCancel(entry);
    },

    cancelAllPending() {
      const entries = [...pending.values()];
      if (entries.length === 0) return;
      // Drop the whole pending set BEFORE emitting: from this moment every
      // sweep/cancel/response finds an empty map — one :cancel per requestId,
      // ever. The grace timers die with the entries, so no timeout :cancel
      // can follow the sweep.
      pending.clear();
      for (const entry of entries) {
        clearTimeout(entry.timer);
        emitCancel(entry);
        entry.resolve({ kind: "cancelled" });
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const off of offs.splice(0)) off();
      for (const entry of [...pending.values()]) settle(entry, { kind: "cancelled" });
    },
  };
}
