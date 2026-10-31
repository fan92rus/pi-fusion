/**
 * pi-fusion extension entry point (design rev.5.2 §4 `index.ts`, §13
 * feature flag, §10 step 8): registers the `fusion_delegate` tool and wires
 * one call through validate → availability → runFanout.
 *
 * Exposure is `direct` (the model reaches it while it is active). The active
 * set is the set declared to the model, so when `fusion.enabled` is false the
 * tool is removed from it right away. The host rejects `setActiveTools()`
 * while the extension loads (its runtime is not bound yet), so the removal
 * runs on the first `session_start` — before any model request.
 */
import type {
  EventBus,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type FusionConfig, readFusionConfig } from "./config-bridge.ts";
import { FusionContractSchema } from "./contract/schema.ts";
import { validateFusionCall } from "./contract/validate.ts";
import { isDegradationRefusal, renderDegradationRefusal } from "./degradation.ts";
import { type DegradationRefusal, runFanout } from "./pool/fanout.ts";
import { renderFanoutText, summarizeFanout } from "./result.ts";
import { isSeamAvailable } from "./seam/availability.ts";
import {
  createFanoutSeamClient,
  SEAM_CANCEL_EVENT,
  SEAM_REQUEST_EVENT,
  SEAM_RESPONSE_EVENT,
} from "./seam/client.ts";
import { type FanoutResult, FanoutResultSchema, type UsageTotals } from "./types.ts";

export const FUSION_TOOL_NAME = "fusion_delegate";

type ToolResult = Awaited<ReturnType<ToolDefinition["execute"]>>;
type PiUsage = NonNullable<ToolResult["usage"]>;

/**
 * Top-level `result.usage` of the tool = FanoutResult.usage (design §4,
 * docs extensions.md:249). pi's Usage needs every number and sums them
 * (`cost.total`, `input`, …), so absent fields become 0 here. That 0 is a
 * transport requirement, not a claim of zero work: the unknown-vs-zero truth
 * stays in `structuredContent.usage` (absent fields) and `usagePartial`.
 */
export function toPiUsage(usage: UsageTotals): PiUsage {
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  return {
    input,
    output,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost ?? 0 },
  };
}

interface SeamRequestRef {
  requestId: string;
  ownerRunId: string;
  nodeId: string;
}

/**
 * Esc compensation (supervisor decision, pi-fusion-hi7): the seam client keeps
 * its requestIds private and dispose() does not send :cancel, so the tool
 * watches the shared bus itself. Requests seen but not yet answered (or timed
 * out / cancelled) are the in-flight set; `cancelAll()` sends :cancel for each
 * before runFanout's dispose(). Canonical fix: client.cancelAllPending() plus
 * pool onAbort — tracked as a separate bd task.
 */
function trackInFlight(events: EventBus) {
  const pending = new Map<string, SeamRequestRef>();
  const settled = new Set<string>();
  const requestIdOf = (data: unknown): string | undefined =>
    typeof (data as { requestId?: unknown } | null)?.requestId === "string"
      ? (data as { requestId: string }).requestId
      : undefined;
  const offs = [
    events.on(SEAM_REQUEST_EVENT, (data) => {
      const ref = data as SeamRequestRef;
      // A synchronous answer may already have settled this request.
      if (!settled.has(ref.requestId)) {
        pending.set(ref.requestId, {
          requestId: ref.requestId,
          ownerRunId: ref.ownerRunId,
          nodeId: ref.nodeId,
        });
      }
    }),
    events.on(SEAM_RESPONSE_EVENT, (data) => {
      const id = requestIdOf(data);
      if (id !== undefined) {
        pending.delete(id);
        settled.add(id);
      }
    }),
    events.on(SEAM_CANCEL_EVENT, (data) => {
      const id = requestIdOf(data);
      if (id !== undefined) pending.delete(id);
    }),
  ];
  return {
    cancelAll(): void {
      const inFlight = [...pending.values()];
      pending.clear();
      for (const ref of inFlight) {
        events.emit(SEAM_CANCEL_EVENT, {
          requestId: ref.requestId,
          ownerRunId: ref.ownerRunId,
          nodeId: ref.nodeId,
        });
      }
    },
    dispose(): void {
      for (const off of offs) off();
      pending.clear();
      settled.clear();
    },
  };
}

function refusal(text: string): ToolResult {
  return { content: [{ type: "text", text }], details: undefined, isError: true };
}

function fanoutToolResult(result: FanoutResult): ToolResult {
  return {
    content: [{ type: "text", text: renderFanoutText(result) }],
    details: summarizeFanout(result),
    structuredContent: result,
    usage: toPiUsage(result.usage),
  };
}

/** One fusion_delegate call: validate → availability → runFanout, Esc-aware. */
async function runFusionDelegate(
  pi: ExtensionAPI,
  config: FusionConfig,
  params: unknown,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<ToolResult> {
  const validation = validateFusionCall(params);
  if (!validation.ok) {
    return refusal(
      `fusion_delegate refused: ${validation.error.reason} (offender: ${validation.error.offender})`,
    );
  }
  const abort = signal ?? ctx.signal;
  // Without a seam bus there is nothing to track; runFanout refuses the call.
  const inFlight = isSeamAvailable(pi) ? trackInFlight(pi.events) : undefined;
  // Registered before runFanout's own abort listener, so :cancel goes out first.
  // An already-aborted signal needs no listener: runFanout drains it itself.
  const onAbort = (): void => inFlight?.cancelAll();
  abort?.addEventListener("abort", onAbort, { once: true });
  try {
    const outcome: FanoutResult | DegradationRefusal = await runFanout({
      contract: validation.value,
      config,
      available: () => isSeamAvailable(pi),
      makeClient: () => createFanoutSeamClient({ events: pi.events, cwd: ctx.cwd }),
      ...(abort !== undefined ? { signal: abort } : {}),
    });
    if (isDegradationRefusal(outcome)) {
      // FR-009: the whole call is refused before any worker starts.
      return refusal(renderDegradationRefusal(outcome));
    }
    return fanoutToolResult(outcome);
  } finally {
    abort?.removeEventListener("abort", onAbort);
    inFlight?.dispose();
  }
}

/** Registers the tool and applies the feature flag; config is injected for tests. */
export function registerFusionDelegate(pi: ExtensionAPI, config: FusionConfig): void {
  pi.registerTool({
    name: FUSION_TOOL_NAME,
    label: "Fusion delegate",
    description:
      "Split independent work into 1..16 tasks and run them in parallel on a pool of fresh worker agents; returns each task's report.",
    parameters: FusionContractSchema,
    outputSchema: FanoutResultSchema,
    exposure: "direct",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return runFusionDelegate(pi, config, params, signal, ctx);
    },
  });
  if (!config.enabled) {
    pi.on("session_start", () => {
      pi.setActiveTools(pi.getActiveTools().filter((name) => name !== FUSION_TOOL_NAME));
    });
  }
}

export default function fusionExtension(pi: ExtensionAPI): void {
  registerFusionDelegate(pi, readFusionConfig());
}
