/**
 * Fake delegation seam (fake-pi) — the T5+ test double for the pi-subagents
 * delegation bridge (spec 001 rev.5.2 §5 Seam Protocol).
 *
 * WHAT IT IS
 *   - `events` — a `pi.events`-shaped bus: the exact `EventBus` interface of
 *     @earendil-works/pi-coding-agent, implemented over a plain
 *     node:events EventEmitter. Delivery is synchronous (no timers, no
 *     microtasks), so tests are deterministic under vi.useFakeTimers.
 *   - `host` — the fake HOST side (what pi-subagents' prompt-template bridge
 *     does): validates delegation request identity, auto-answers
 *     `duplicate_node` while a nodeId is still active (the real bridge holds
 *     activeOwnedNodes until the terminal response), and hands the test full
 *     control over :started/:update/:response ORDER, STATUS, usage,
 *     result.value and error — always routed by requestId. :cancel bodies are
 *     recorded verbatim for gating.
 *
 * WHAT IT IS NOT
 *   - Not a status-rules engine. Adapter projections (interrupted checked
 *     before failed, completed without structuredOutput → failed, usage
 *     `?? 0` = "no data") live in pi-subagents src/slash/delegation-adapters.js
 *     and are the seam client's (F05) responsibility. Use respondRaw() to put
 *     a verbatim payload on the bus.
 *
 * Payload types below are structural copies of pi-subagents@0.84.0
 * src/api/delegation.d.ts (C:/Users/user/.pi/agent/npm/node_modules/pi-subagents/
 * src/api/delegation.d.ts). That package is not an npm dependency of
 * pi-fusion, so the seam shapes are pinned here; keep them in sync.
 */

import { EventEmitter } from "node:events";
import type { EventBus } from "@earendil-works/pi-coding-agent";

// ────────────────────────────────────────────────────────────────────────
// Seam event names (pi-subagents src/api/delegation.d.ts)
// ────────────────────────────────────────────────────────────────────────

export const DELEGATION_REQUEST_EVENT = "prompt-template:subagent:request";
export const DELEGATION_STARTED_EVENT = "prompt-template:subagent:started";
export const DELEGATION_UPDATE_EVENT = "prompt-template:subagent:update";
export const DELEGATION_RESPONSE_EVENT = "prompt-template:subagent:response";
export const DELEGATION_CANCEL_EVENT = "prompt-template:subagent:cancel";

// ────────────────────────────────────────────────────────────────────────
// Seam payload types — structural copies of pi-subagents delegation.d.ts
// ────────────────────────────────────────────────────────────────────────

export type DelegationThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface DelegationToolBudget {
  soft?: number;
  hard: number;
  block?: string[] | "*";
}

export type DelegationResultRequest =
  | { kind: "text" }
  | { kind: "structured"; schema: Record<string, unknown> };

export interface DelegationRequest {
  requestId: string;
  ownerRunId: string;
  nodeId: string;
  agent: string;
  task: string;
  context: "fresh" | "fork";
  cwd: string;
  model?: string;
  thinking?: DelegationThinking;
  timeoutMs?: number;
  toolBudget?: DelegationToolBudget;
  skill?: string | string[] | boolean;
  artifacts?: boolean;
  /** IntercomBridgeConfig in pi-subagents (shared/types.ts); opaque here. */
  intercomBridge?: unknown;
  result: DelegationResultRequest;
}

export interface DelegationStarted {
  requestId: string;
  ownerRunId: string;
  nodeId: string;
}

/** Cumulative usage for one attempt at one observation time (adapter: only emitted when every counter is known, finite, non-negative). */
export interface DelegationUpdateUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  turns: number;
}

export interface DelegationProviderDiagnostics {
  errorCount: number;
  lastError?: {
    kind: "rate_limited" | "transient_other" | "unknown";
    message: string;
    at: number;
  };
  retry?: {
    phase: "backoff" | "in_flight";
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    scheduledAt: number;
  };
}

export interface DelegationUpdate extends DelegationStarted {
  providerDiagnostics?: DelegationProviderDiagnostics;
  runId?: string;
  currentTool?: string;
  currentToolArgs?: string;
  recentOutput?: string;
  recentOutputLines?: string[];
  recentTools?: Array<{ tool: string; args: string }>;
  model?: string;
  toolCount?: number;
  durationMs?: number;
  tokens?: number;
  usage?: DelegationUpdateUsage;
}

export type DelegationStatus =
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

export type DelegationValue =
  | { kind: "text"; text: string }
  | { kind: "structured"; value: unknown };

export interface DelegationUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
  toolCalls: number;
  durationMs: number;
}

export interface DelegationTerminalResponse extends DelegationStarted {
  providerDiagnostics?: DelegationProviderDiagnostics;
  status: Exclude<DelegationStatus, "invalid_request">;
  error?: string;
  runId?: string;
  agent?: string;
  model?: string;
  thinking?: string;
  exitCode?: number;
  launchContractDigest?: string;
  result?: DelegationValue;
  usage?: DelegationUsage;
}

/** A malformed request can only be correlated by the valid identity fields it supplied. */
export interface DelegationInvalidResponse {
  requestId: string;
  ownerRunId?: string;
  nodeId?: string;
  status: "invalid_request";
  error?: string;
}

export type DelegationResponse = DelegationTerminalResponse | DelegationInvalidResponse;

export interface DelegationCancel extends DelegationStarted {}

// ────────────────────────────────────────────────────────────────────────
// EventBus over EventEmitter — the pi.events surface
// ────────────────────────────────────────────────────────────────────────

/** pi.events-shaped bus over a plain EventEmitter; emit is synchronous. */
export function createFakePiEvents(): EventBus {
  const emitter = new EventEmitter();
  // Test fake: arbitrary subscription counts per channel, no warnings.
  emitter.setMaxListeners(0);
  return {
    on(channel, handler) {
      emitter.on(channel, handler);
      return () => {
        emitter.off(channel, handler);
      };
    },
    emit(channel, data) {
      emitter.emit(channel, data);
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// Request factory — a valid DelegationRequest with a fresh identity
// ────────────────────────────────────────────────────────────────────────

let requestSeq = 0;

export function makeDelegationRequest(
  overrides: Partial<DelegationRequest> = {},
): DelegationRequest {
  requestSeq += 1;
  return {
    requestId: `fusion-test-${requestSeq}-a1-${Date.now()}`,
    ownerRunId: "fusion-test-owner",
    nodeId: `task-${requestSeq}#a1`,
    agent: "fusion-worker",
    task: "fake-pi test task",
    context: "fresh",
    cwd: process.cwd(),
    timeoutMs: 60_000,
    toolBudget: { hard: 200, block: ["fusion_delegate", "subagent", "codemode"] },
    result: { kind: "structured", schema: { type: "object" } },
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Cumulative :update usage snapshots
// ────────────────────────────────────────────────────────────────────────

export interface UsageTicker {
  /**
   * Accumulate a delta and return the cumulative snapshot (the shape
   * :update carries). Returns undefined — without committing — when any
   * running total would be non-finite or negative, mirroring the adapter's
   * "snapshot only when every counter is known, finite, non-negative" rule
   * (delegation-adapters.js buildDelegationUpdateUsage).
   */
  add(delta: Partial<DelegationUpdateUsage>): DelegationUpdateUsage | undefined;
}

export function createUsageTicker(start: Partial<DelegationUpdateUsage> = {}): UsageTicker {
  let input = start.input ?? 0;
  let output = start.output ?? 0;
  let cacheRead = start.cacheRead ?? 0;
  let cacheWrite = start.cacheWrite ?? 0;
  let turns = start.turns ?? 0;
  const finiteNonNegative = (value: number): boolean => Number.isFinite(value) && value >= 0;
  return {
    add(delta) {
      const next = {
        input: input + (delta.input ?? 0),
        output: output + (delta.output ?? 0),
        cacheRead: cacheRead + (delta.cacheRead ?? 0),
        cacheWrite: cacheWrite + (delta.cacheWrite ?? 0),
        turns: turns + (delta.turns ?? 0),
      };
      if (
        !finiteNonNegative(next.input) ||
        !finiteNonNegative(next.output) ||
        !finiteNonNegative(next.cacheRead) ||
        !finiteNonNegative(next.cacheWrite) ||
        !finiteNonNegative(next.turns)
      ) {
        return undefined;
      }
      input = next.input;
      output = next.output;
      cacheRead = next.cacheRead;
      cacheWrite = next.cacheWrite;
      turns = next.turns;
      return { ...next };
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// Fake host — the pi-subagents prompt-template bridge stand-in
// ────────────────────────────────────────────────────────────────────────

export interface RespondOverrides {
  status?: DelegationStatus;
  error?: string;
  result?: DelegationValue;
  usage?: DelegationUsage;
  runId?: string;
  agent?: string;
  model?: string;
  thinking?: string;
  exitCode?: number;
  launchContractDigest?: string;
  providerDiagnostics?: DelegationProviderDiagnostics;
}

export type DelegationUpdateFields = Partial<
  Omit<DelegationUpdate, "requestId" | "ownerRunId" | "nodeId">
>;

export interface MalformedRequest {
  data: unknown;
  error: string;
}

/**
 * Minimal structural check for the fields the fake itself depends on
 * (identity + result kind). Deep limits (byte sizes, toolBudget, skill…) are
 * validated by pi-subagents delegation-request.js, not re-implemented here.
 */
function shallowRequestError(value: Record<string, unknown>): string | undefined {
  const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
  if (!nonEmpty(value.agent)) return "Delegation agent must be a non-empty string.";
  if (!nonEmpty(value.task)) return "Delegation task must be a non-empty string.";
  if (value.context !== "fresh" && value.context !== "fork") {
    return "Delegation context must be fresh or fork.";
  }
  if (!nonEmpty(value.cwd)) return "Delegation cwd must be a non-empty string.";
  const result = value.result;
  if (
    typeof result !== "object" ||
    result === null ||
    !(
      (result as { kind?: unknown }).kind === "text" ||
      ((result as { kind?: unknown }).kind === "structured" &&
        typeof (result as { schema?: unknown }).schema === "object" &&
        (result as { schema?: unknown }).schema !== null)
    )
  ) {
    return "Delegation result must be { kind: 'text' } or { kind: 'structured', schema: object }.";
  }
  return undefined;
}

function validId(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 256 ||
    /[\r\n]/.test(value)
  ) {
    return undefined;
  }
  return value;
}

/** Default completed result for the request's result kind. */
function defaultResult(request: DelegationRequest): DelegationValue {
  if (request.result.kind === "text") {
    return { kind: "text", text: "fake-pi completed result" };
  }
  // Minimal valid worker report (extensions/pi-fusion/report/schema.ts), so
  // F07 engine tests can consume the default unoverridden.
  return {
    kind: "structured",
    value: {
      status: "done",
      summary: "fake-pi structured result",
      filesChanged: [],
      evidence: [],
      residualRisks: [],
    },
  };
}

const REQUEST_ID_GATE_ERROR = "fake-pi: requestId is unknown or already settled";

export class FakeDelegationHost {
  /** Accepted requests in arrival order. */
  readonly requests: DelegationRequest[] = [];
  /** :started payloads the host emitted (test-driven via start()). */
  readonly startedEvents: DelegationStarted[] = [];
  /** :update payloads the host emitted (test-driven via update()). */
  readonly updates: DelegationUpdate[] = [];
  /** Every :response payload that went through the host (respond/respondRaw). */
  readonly responses: DelegationResponse[] = [];
  /** :cancel bodies recorded verbatim off the bus. */
  readonly cancels: DelegationCancel[] = [];
  /** Requests rejected before registration (unusable identity). */
  readonly malformed: MalformedRequest[] = [];

  private readonly pending = new Map<string, DelegationRequest>();
  private readonly activeNodes = new Map<string, string>();
  private readonly subscriptions: Array<() => void> = [];
  private readonly events: EventBus;

  constructor(events: EventBus) {
    this.events = events;
    this.subscriptions.push(
      events.on(DELEGATION_REQUEST_EVENT, (data) => {
        this.onRequest(data);
      }),
      events.on(DELEGATION_CANCEL_EVENT, (data) => {
        this.cancels.push(data as DelegationCancel);
      }),
    );
  }

  /** Stop listening; pending state stays readable for assertions. */
  dispose(): void {
    for (const off of this.subscriptions) off();
    this.subscriptions.length = 0;
  }

  getPending(requestId: string): DelegationRequest | undefined {
    return this.pending.get(requestId);
  }

  pendingRequestIds(): string[] {
    return [...this.pending.keys()];
  }

  isNodeActive(nodeId: string): boolean {
    return this.activeNodes.has(nodeId);
  }

  cancelsFor(requestId: string): DelegationCancel[] {
    return this.cancels.filter((cancel) => cancel.requestId === requestId);
  }

  /** Emit :started for a pending request. Throws on unknown/settled requestId. */
  start(requestId: string): DelegationStarted {
    const request = this.requirePending(requestId);
    const started: DelegationStarted = {
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
    };
    this.startedEvents.push(started);
    this.events.emit(DELEGATION_STARTED_EVENT, started);
    return started;
  }

  /** Emit :update with the request identity filled in. Throws when settled. */
  update(requestId: string, fields: DelegationUpdateFields = {}): DelegationUpdate {
    const request = this.requirePending(requestId);
    const update: DelegationUpdate = {
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
      ...fields,
    };
    this.updates.push(update);
    this.events.emit(DELEGATION_UPDATE_EVENT, update);
    return update;
  }

  /**
   * Build a valid terminal response for a pending request (defaults: status
   * completed with a result matching the request's result kind), emit it on
   * :response and settle the request (the node is freed — a retry may reuse
   * the nodeId). Throws on unknown/settled requestId.
   */
  respond(requestId: string): DelegationTerminalResponse;
  respond(
    requestId: string,
    overrides: RespondOverrides & { status?: Exclude<DelegationStatus, "invalid_request"> },
  ): DelegationTerminalResponse;
  respond(
    requestId: string,
    overrides: RespondOverrides & { status: "invalid_request" },
  ): DelegationInvalidResponse;
  respond(requestId: string, overrides: RespondOverrides = {}): DelegationResponse {
    const request = this.requirePending(requestId);
    const status = overrides.status ?? "completed";
    let response: DelegationResponse;
    if (status === "invalid_request") {
      // SubagentDelegationInvalidResponse: identity + error only.
      response = {
        requestId: request.requestId,
        ownerRunId: request.ownerRunId,
        nodeId: request.nodeId,
        status,
        ...(overrides.error !== undefined ? { error: overrides.error } : {}),
      };
    } else {
      const result =
        overrides.result !== undefined
          ? overrides.result
          : status === "completed"
            ? defaultResult(request)
            : undefined;
      response = {
        requestId: request.requestId,
        ownerRunId: request.ownerRunId,
        nodeId: request.nodeId,
        status,
        ...(overrides.error !== undefined ? { error: overrides.error } : {}),
        ...(overrides.runId !== undefined ? { runId: overrides.runId } : {}),
        ...(overrides.agent !== undefined ? { agent: overrides.agent } : {}),
        ...(overrides.model !== undefined ? { model: overrides.model } : {}),
        ...(overrides.thinking !== undefined ? { thinking: overrides.thinking } : {}),
        ...(overrides.exitCode !== undefined ? { exitCode: overrides.exitCode } : {}),
        ...(overrides.launchContractDigest !== undefined
          ? { launchContractDigest: overrides.launchContractDigest }
          : {}),
        ...(result !== undefined ? { result } : {}),
        ...(overrides.usage !== undefined ? { usage: overrides.usage } : {}),
        ...(overrides.providerDiagnostics !== undefined
          ? { providerDiagnostics: overrides.providerDiagnostics }
          : {}),
      };
    }
    this.responses.push(response);
    this.events.emit(DELEGATION_RESPONSE_EVENT, response);
    this.pending.delete(requestId);
    this.activeNodes.delete(request.nodeId);
    return response;
  }

  /**
   * Put an arbitrary :response payload on the bus verbatim (late terminals,
   * foreign requestIds, adapter-projection fixtures). Recorded, but pending
   * state is NOT touched.
   */
  respondRaw(response: DelegationResponse): void {
    this.responses.push(response);
    this.events.emit(DELEGATION_RESPONSE_EVENT, response);
  }

  private requirePending(requestId: string): DelegationRequest {
    const request = this.pending.get(requestId);
    if (!request) {
      throw new Error(`${REQUEST_ID_GATE_ERROR}: ${JSON.stringify(requestId)}`);
    }
    return request;
  }

  private onRequest(data: unknown): void {
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      this.malformed.push({ data, error: "Delegation request must be an object." });
      return;
    }
    const value = data as Record<string, unknown>;
    const requestId = validId(value.requestId);
    if (!requestId) {
      this.malformed.push({
        data,
        error:
          "Delegation requestId must be a non-empty string of at most 256 characters without newlines.",
      });
      return;
    }
    const ownerRunId = validId(value.ownerRunId);
    const nodeId = validId(value.nodeId);
    if (!ownerRunId || !nodeId) {
      // Correlate only by the valid identity fields supplied (delegation.d.ts).
      const response: DelegationResponse = {
        requestId,
        ...(ownerRunId !== undefined ? { ownerRunId } : {}),
        ...(nodeId !== undefined ? { nodeId } : {}),
        status: "invalid_request",
        error:
          "Delegation ownerRunId and nodeId must be non-empty strings of at most 256 characters without newlines.",
      };
      this.responses.push(response);
      this.events.emit(DELEGATION_RESPONSE_EVENT, response);
      return;
    }
    const active = this.activeNodes.get(nodeId);
    if (active !== undefined) {
      // Bridge rule: the node is still active → duplicate_node, not pending.
      const response: DelegationResponse = {
        requestId,
        ownerRunId,
        nodeId,
        status: "duplicate_node",
        error: `Node ${JSON.stringify(nodeId)} is still active for request ${JSON.stringify(active)}.`,
      };
      this.responses.push(response);
      this.events.emit(DELEGATION_RESPONSE_EVENT, response);
      return;
    }
    const shallowError = shallowRequestError(value);
    if (shallowError !== undefined) {
      const response: DelegationResponse = {
        requestId,
        ownerRunId,
        nodeId,
        status: "invalid_request",
        error: shallowError,
      };
      this.responses.push(response);
      this.events.emit(DELEGATION_RESPONSE_EVENT, response);
      return;
    }
    const request = value as unknown as DelegationRequest;
    this.requests.push(request);
    this.pending.set(requestId, request);
    this.activeNodes.set(nodeId, requestId);
  }
}

// ────────────────────────────────────────────────────────────────────────
// Assembled fake pi
// ────────────────────────────────────────────────────────────────────────

export interface FakePi {
  /** `pi.events` stand-in (EventBus interface of @earendil-works/pi-coding-agent). */
  events: EventBus;
  /** Fake bridge host with test controls (gated by requestId). */
  host: FakeDelegationHost;
}

export function createFakePi(): FakePi {
  const events = createFakePiEvents();
  const host = new FakeDelegationHost(events);
  return { events, host };
}
