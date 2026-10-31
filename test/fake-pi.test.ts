/**
 * fake-pi — the delegation-seam test bus (spec 001 rev.5.2 §5 Seam Protocol).
 *
 * Acceptance gates for T5+ reuse:
 *   - subscription/response routing is keyed by requestId (the test controls
 *     order, status, usage, result.value and error);
 *   - :cancel reaches the fake host with the full
 *     {requestId, ownerRunId, nodeId} body;
 *   - the bus is a plain synchronous EventEmitter — deterministic under
 *     vi.useFakeTimers.
 *
 * Status vocabulary and payload shapes follow pi-subagents
 * src/api/delegation.d.ts; the reference host rules live in
 * src/slash/delegation-adapters.js / prompt-template-bridge.js.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createFakePi,
  createUsageTicker,
  DELEGATION_RESPONSE_EVENT,
  type DelegationResponse,
  type DelegationStatus,
  makeDelegationRequest,
} from "./fake-pi.ts";

/** Minimal seam-client stand-in (the F05 engine replaces this in T5+). */
function makeSeamClient(events: ReturnType<typeof createFakePi>["events"]) {
  const startedByRequest = new Map<string, unknown[]>();
  const updatesByRequest = new Map<string, unknown[]>();
  const responsesByRequest = new Map<string, DelegationResponse[]>();
  const sent: unknown[] = [];
  const push = (map: Map<string, unknown[]>, requestId: string, payload: unknown): void => {
    const list = map.get(requestId) ?? [];
    list.push(payload);
    map.set(requestId, list);
  };
  const offs = [
    events.on("prompt-template:subagent:started", (data) => {
      const payload = data as { requestId: string };
      push(startedByRequest, payload.requestId, payload);
    }),
    events.on("prompt-template:subagent:update", (data) => {
      const payload = data as { requestId: string };
      push(updatesByRequest, payload.requestId, payload);
    }),
    events.on(DELEGATION_RESPONSE_EVENT, (data) => {
      const payload = data as DelegationResponse;
      push(responsesByRequest, payload.requestId, payload);
    }),
  ];
  return {
    request(request: unknown): void {
      sent.push(request);
      events.emit("prompt-template:subagent:request", request);
    },
    cancel(identity: { requestId: string; ownerRunId: string; nodeId: string }): void {
      events.emit("prompt-template:subagent:cancel", identity);
    },
    sent: (): unknown[] => sent,
    started: (requestId: string): unknown[] => startedByRequest.get(requestId) ?? [],
    updates: (requestId: string): unknown[] => updatesByRequest.get(requestId) ?? [],
    responses: (requestId: string): DelegationResponse[] => responsesByRequest.get(requestId) ?? [],
    dispose(): void {
      for (const off of offs) off();
    },
  };
}

const TERMINAL_STATUSES: readonly Exclude<DelegationStatus, "invalid_request">[] = [
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "interrupted",
  "tool_budget_exhausted",
  "structured_output_failed",
  "acceptance_failed",
  "unavailable_context",
  "duplicate_node",
];

describe("fake-pi: delegation seam bus (§5 Seam Protocol)", () => {
  it("routes :started and :response by requestId; the test controls the order", () => {
    const { events, host } = createFakePi();
    const client = makeSeamClient(events);
    const alpha = makeDelegationRequest({ nodeId: "task-alpha#a1" });
    const beta = makeDelegationRequest({ nodeId: "task-beta#a1" });
    client.request(alpha);
    client.request(beta);
    expect(host.pendingRequestIds()).toEqual([alpha.requestId, beta.requestId]);

    // Reverse order: beta finishes first, alpha is still gated.
    host.start(beta.requestId);
    expect(client.started(beta.requestId)).toHaveLength(1);
    expect(client.started(alpha.requestId)).toHaveLength(0);

    host.respond(beta.requestId, { status: "failed", error: "boom" });
    expect(client.responses(alpha.requestId)).toHaveLength(0);
    const betaResponses = client.responses(beta.requestId);
    expect(betaResponses).toHaveLength(1);
    expect(betaResponses[0]?.status).toBe("failed");
    expect(betaResponses[0]?.error).toBe("boom");

    // Only now alpha: default completed with a structured result.
    host.respond(alpha.requestId);
    const alphaResponses = client.responses(alpha.requestId);
    expect(alphaResponses).toHaveLength(1);
    expect(alphaResponses[0]?.status).toBe("completed");
    expect(alphaResponses[0]).toMatchObject({
      requestId: alpha.requestId,
      ownerRunId: alpha.ownerRunId,
      nodeId: alpha.nodeId,
      result: { kind: "structured" },
    });
    client.dispose();
  });

  it("delivers synchronously — no timers, no microtasks; unsubscribe stops delivery", () => {
    const { events, host } = createFakePi();
    const client = makeSeamClient(events);
    const request = makeDelegationRequest();
    client.request(request);
    host.respond(request.requestId, { status: "cancelled" });
    // No await between emit and assertion: the bus is a plain EventEmitter.
    expect(client.responses(request.requestId)).toHaveLength(1);

    client.dispose();
    host.respondRaw({ requestId: "late", status: "invalid_request" });
    expect(client.responses("late")).toHaveLength(0); // unsubscribed
    expect(host.responses).toHaveLength(2); // but the bus still delivered
  });

  it(":cancel reaches the host with the {requestId, ownerRunId, nodeId} body", () => {
    const { events, host } = createFakePi();
    const client = makeSeamClient(events);
    const alpha = makeDelegationRequest({ nodeId: "task-alpha#a1" });
    const beta = makeDelegationRequest({ nodeId: "task-beta#a1" });
    client.request(alpha);
    client.request(beta);

    client.cancel({
      requestId: alpha.requestId,
      ownerRunId: alpha.ownerRunId,
      nodeId: alpha.nodeId,
    });
    expect(host.cancels).toEqual([
      { requestId: alpha.requestId, ownerRunId: alpha.ownerRunId, nodeId: alpha.nodeId },
    ]);
    expect(host.cancelsFor(beta.requestId)).toEqual([]);
    // A cancelled request stays pending until the host sends its terminal
    // response (bridge holds the node active; the client decides to ignore — M13).
    expect(host.getPending(alpha.requestId)).toBeDefined();
    host.respond(alpha.requestId, { status: "cancelled" });
    expect(client.responses(alpha.requestId)[0]?.status).toBe("cancelled");
  });

  it("gates: start/update/respond on an unknown or settled requestId throw", () => {
    const { events, host } = createFakePi();
    const client = makeSeamClient(events);
    const request = makeDelegationRequest();
    client.request(request);
    expect(() => host.start("nope")).toThrow(/unknown or already settled/);
    expect(() => host.update("nope", { currentTool: "read" })).toThrow(
      /unknown or already settled/,
    );
    expect(() => host.respond("nope")).toThrow(/unknown or already settled/);

    host.respond(request.requestId);
    expect(() => host.respond(request.requestId)).toThrow(/unknown or already settled/);
    expect(() => host.update(request.requestId, { tokens: 1 })).toThrow(
      /unknown or already settled/,
    );
    // respondRaw is the verbatim escape hatch and never throws.
    expect(() =>
      host.respondRaw({
        requestId: request.requestId,
        ownerRunId: request.ownerRunId,
        nodeId: request.nodeId,
        status: "timed_out",
      }),
    ).not.toThrow();
  });

  it("auto-answers duplicate_node while the nodeId is active, frees it on terminal", () => {
    const { events, host } = createFakePi();
    const client = makeSeamClient(events);
    const first = makeDelegationRequest({ nodeId: "task-a#a1" });
    client.request(first);
    expect(host.isNodeActive("task-a#a1")).toBe(true);

    // Schema-retry style re-request on the SAME nodeId while attempt 1 runs.
    const retry = makeDelegationRequest({ nodeId: "task-a#a1" });
    client.request(retry);
    const retryResponses = client.responses(retry.requestId);
    expect(retryResponses).toHaveLength(1);
    expect(retryResponses[0]).toMatchObject({
      requestId: retry.requestId,
      ownerRunId: retry.ownerRunId,
      nodeId: "task-a#a1",
      status: "duplicate_node",
    });
    expect(host.getPending(retry.requestId)).toBeUndefined();

    // After the terminal response the node is free again.
    host.respond(first.requestId, { status: "structured_output_failed" });
    expect(host.isNodeActive("task-a#a1")).toBe(false);
    const rerun = makeDelegationRequest({ nodeId: "task-a#a1" });
    client.request(rerun);
    expect(host.getPending(rerun.requestId)).toBeDefined();
  });

  it("rejects unusable requests: malformed identity → invalid_request correlated by valid fields", () => {
    const { events, host } = createFakePi();
    const client = makeSeamClient(events);

    client.request({ requestId: "only-id" }); // no ownerRunId/nodeId/agent/…
    expect(host.malformed).toHaveLength(0);
    const invalid = client.responses("only-id");
    expect(invalid[0]).toMatchObject({ requestId: "only-id", status: "invalid_request" });

    client.request("not-an-object");
    expect(host.malformed).toHaveLength(1);

    const missingResult = makeDelegationRequest();
    client.request({ ...missingResult, result: undefined });
    const shallowInvalid = client.responses(missingResult.requestId);
    expect(shallowInvalid[0]?.status).toBe("invalid_request");
    expect(shallowInvalid[0]).toMatchObject({
      requestId: missingResult.requestId,
      ownerRunId: missingResult.ownerRunId,
      nodeId: missingResult.nodeId,
    });
  });

  it("respond() builds a valid terminal payload for every seam status", () => {
    const { events, host } = createFakePi();
    const client = makeSeamClient(events);

    for (const status of TERMINAL_STATUSES) {
      const request = makeDelegationRequest();
      client.request(request);
      const response = host.respond(request.requestId, { status });
      expect(response.status).toBe(status);
      expect(response).toMatchObject({
        requestId: request.requestId,
        ownerRunId: request.ownerRunId,
        nodeId: request.nodeId,
      });
      client.dispose();
    }

    // invalid_request: identity + error only (SubagentDelegationInvalidResponse).
    const request = makeDelegationRequest();
    client.request(request);
    const response = host.respond(request.requestId, { status: "invalid_request", error: "bad" });
    expect(response).toEqual({
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
      status: "invalid_request",
      error: "bad",
    });
    expect(Object.hasOwn(response, "result")).toBe(false);
    expect(Object.hasOwn(response, "usage")).toBe(false);
  });

  it("text-kind requests get a text default result; overrides land verbatim", () => {
    const { events, host } = createFakePi();
    const client = makeSeamClient(events);

    const textRequest = makeDelegationRequest({ result: { kind: "text" } });
    client.request(textRequest);
    const textResponse = host.respond(textRequest.requestId);
    expect(textResponse.result).toEqual({ kind: "text", text: "fake-pi completed result" });

    const usage = {
      input: 120,
      output: 45,
      cacheRead: 7,
      cacheWrite: 0,
      cost: 0.01,
      turns: 3,
      toolCalls: 0,
      durationMs: 0,
    };
    const reportValue = {
      status: "needs_orchestrator",
      summary: "blocked",
      filesChanged: [],
      evidence: [],
      residualRisks: ["seam"],
      question: "which model?",
    };
    const structured = makeDelegationRequest();
    client.request(structured);
    const response = host.respond(structured.requestId, {
      status: "unavailable_context",
      result: { kind: "structured", value: reportValue },
      usage,
      runId: "child-run-1",
      exitCode: 0,
      providerDiagnostics: { errorCount: 2 },
    });
    expect(response).toMatchObject({
      status: "unavailable_context",
      runId: "child-run-1",
      exitCode: 0,
      result: { kind: "structured", value: reportValue },
      usage,
      providerDiagnostics: { errorCount: 2 },
    });

    // FR-010: absent usage means unknown — the key must be absent, not 0.
    const noUsage = makeDelegationRequest();
    client.request(noUsage);
    const noUsageResponse = host.respond(noUsage.requestId, {
      status: "failed",
      error: "host:failed",
    });
    expect(Object.hasOwn(noUsageResponse, "usage")).toBe(false);
  });
});

describe("fake-pi: cumulative :update snapshots", () => {
  it("snapshots are cumulative per attempt and adapter-honest", () => {
    const { events, host } = createFakePi();
    const client = makeSeamClient(events);
    const request = makeDelegationRequest();
    client.request(request);
    host.start(request.requestId);

    const ticker = createUsageTicker();
    const first = ticker.add({ turns: 1, input: 100, output: 20, cacheRead: 0, cacheWrite: 0 });
    expect(first).toEqual({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0, turns: 1 });
    const second = ticker.add({ turns: 1, input: 50, output: 10, cacheRead: 4, cacheWrite: 2 });
    expect(second).toEqual({ input: 150, output: 30, cacheRead: 4, cacheWrite: 2, turns: 2 });

    host.update(request.requestId, { usage: first });
    host.update(request.requestId, { usage: second, currentTool: "edit" });
    const updates = client.updates(request.requestId);
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
      usage: { turns: 1 },
    });
    expect(updates[1]).toMatchObject({ usage: { turns: 2 }, currentTool: "edit" });

    // Invalid observation (negative delta): no snapshot, totals unpoisoned.
    expect(ticker.add({ turns: -5 })).toBeUndefined();
    expect(ticker.add({ input: Number.NaN })).toBeUndefined();
    expect(ticker.add({ turns: 1 })).toEqual({
      input: 150,
      output: 30,
      cacheRead: 4,
      cacheWrite: 2,
      turns: 3,
    });

    // :update also travels WITHOUT usage (bridge parity) — heartbeat fields only.
    host.update(request.requestId, { recentOutput: "step done" });
    const bare = client.updates(request.requestId)[2] as { usage?: unknown };
    expect(Object.hasOwn(bare, "usage")).toBe(false);
  });
});

describe("fake-pi: vi.useFakeTimers compatibility", () => {
  it("FR-008 grace scenario: late response and deadline cancel under fake timers", async () => {
    vi.useFakeTimers();
    try {
      const { events, host } = createFakePi();
      const client = makeSeamClient(events);
      const request = makeDelegationRequest();
      client.request(request);

      // Local deadline = timeoutMs + 15s grace (FR-008): cancel at 15s.
      const graceTimer = setTimeout(() => {
        client.cancel({
          requestId: request.requestId,
          ownerRunId: request.ownerRunId,
          nodeId: request.nodeId,
        });
      }, 15_000);
      // The host child finishes late, at 5s.
      const childTimer = setTimeout(() => {
        host.respond(request.requestId, {
          status: "completed",
          usage: {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            turns: 2,
            toolCalls: 0,
            durationMs: 5000,
          },
        });
      }, 5_000);

      await vi.advanceTimersByTimeAsync(5_000);
      const responses = client.responses(request.requestId);
      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({ status: "completed", usage: { turns: 2 } });
      expect(host.cancels).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(host.cancels).toEqual([
        { requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId },
      ]);

      clearTimeout(graceTimer);
      clearTimeout(childTimer);
    } finally {
      vi.useRealTimers();
    }
  });

  it("usage ticker driven by fake-timer intervals stays cumulative", async () => {
    vi.useFakeTimers();
    try {
      const { events, host } = createFakePi();
      const client = makeSeamClient(events);
      const request = makeDelegationRequest();
      client.request(request);
      const ticker = createUsageTicker();
      const meter = setInterval(() => {
        const snapshot = ticker.add({
          turns: 1,
          input: 10,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
        });
        host.update(request.requestId, snapshot !== undefined ? { usage: snapshot } : {});
      }, 1_000);

      await vi.advanceTimersByTimeAsync(3_000);
      clearInterval(meter);
      const updates = client.updates(request.requestId);
      expect(updates).toHaveLength(3);
      expect(updates[2]).toMatchObject({ usage: { turns: 3, input: 30, output: 6 } });
    } finally {
      vi.useRealTimers();
    }
  });
});
