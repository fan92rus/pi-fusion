/**
 * pi-fusion extension entry point (design rev.5.2 §4 `index.ts`, §13
 * feature flag, §10 step 8; F02 wiring per bd pi-fusion-chq review): registers
 * the `fusion_delegate` tool and wires one call through validate →
 * availability → runFanout, plus the operator's `/fusion` command and the
 * `### fusion` guidance section (F08).
 *
 * Exposure is `direct` (the model reaches it while it is active). The active
 * set is the set declared to the model, so when `fusion.enabled` is false the
 * tool is removed from it on the first `session_start` — before any model
 * request (the host rejects `setActiveTools()` while the extension loads).
 *
 * Nothing caches the config for the session: the tool re-reads fusion.json on
 * every call and the guidance section re-reads it on every run, so a
 * `/fusion` command takes effect without a reload (review fix: the startup
 * snapshot is never used after startup).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { FOLLOW_UP_MAX_CHARS, ORIGINAL_REQUEST_CHAR_BUDGET } from "./briefs.ts";
import { type FusionCommandDeps, registerFusionCommand } from "./commands.ts";
import { loadFusionConfig, persistFusionConfig } from "./config.ts";
import { interactiveFusionConfig } from "./config-ui.ts";
import { FusionContractSchema } from "./contract/schema.ts";
import { validateFusionCall } from "./contract/validate.ts";
import { isDegradationRefusal, renderDegradationRefusal } from "./degradation.ts";
import { registerFusionGuidance } from "./guidance.ts";
import { type DegradationRefusal, type FanoutConfig, runFanout } from "./pool/fanout.ts";
import { registerLeadRestrictions } from "./restrictions.ts";
import { renderFanoutText, summarizeFanout } from "./result.ts";
import { isSeamAvailable } from "./seam/availability.ts";
import { createFanoutSeamClient } from "./seam/client.ts";
import { type FanoutResult, FanoutResultSchema, type UsageTotals } from "./types.ts";
import {
  defaultWorkerAgentTargetPath,
  FUSION_WORKER_AGENT_FILENAME,
  installFusionWorkerAgent,
} from "./worker-install.ts";

export const FUSION_TOOL_NAME = "fusion_delegate";

/** Injection points for tests; production uses the pi agent dir defaults. */
export interface FusionExtensionOptions {
  /** Override the fusion.json path; defaults to `~/.pi/agent/fusion.json`. */
  configPath?: string;
  /** Override the agents root the worker installs into; defaults to `~/.pi/agent`. */
  agentDir?: string;
}

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

/** One fusion_delegate call: validate → availability → runFanout. */
async function runFusionDelegate(
  pi: ExtensionAPI,
  config: FanoutConfig,
  params: unknown,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  originalRequest: string | undefined,
): Promise<ToolResult> {
  const validation = validateFusionCall(params);
  if (!validation.ok) {
    return refusal(
      `fusion_delegate refused: ${validation.error.reason} (offender: ${validation.error.offender})`,
    );
  }
  // Esc (design §8) is handled inside the pool: runFanout's abort listener
  // sends :cancel to every in-flight child through the seam client
  // (cancelAllPending), then disposes it — pending runs resolve cancelled.
  const abort = signal ?? ctx.signal;
  const outcome: FanoutResult | DegradationRefusal = await runFanout({
    contract: validation.value,
    config,
    available: () => isSeamAvailable(pi),
    makeClient: () => createFanoutSeamClient({ events: pi.events, cwd: ctx.cwd }),
    ...(abort !== undefined ? { signal: abort } : {}),
    ...(originalRequest !== undefined ? { originalRequest } : {}),
  });
  if (isDegradationRefusal(outcome)) {
    // FR-009: the whole call is refused before any worker starts.
    return refusal(renderDegradationRefusal(outcome));
  }
  return fanoutToolResult(outcome);
}

/**
 * Registers the tool and applies the feature flag (§13). `config` is a
 * snapshot (tests) or a fresh-read getter (production): every execute
 * re-reads, so a `/fusion` change applies to the next call without a reload.
 * While fusion is disabled the tool is removed from the active set on the
 * first `session_start` — before any model request.
 */
export function registerFusionDelegate(
  pi: ExtensionAPI,
  config: (FanoutConfig & { enabled: boolean }) | (() => FanoutConfig & { enabled: boolean }),
): void {
  const readConfig = typeof config === "function" ? config : () => config;
  // The operator's request that started the run (atomic-agent
  // `pickOriginalRequest` precedent): every worker brief quotes it as
  // context, because a brief is a summary and thin summaries lose the job.
  // A user message shorter than FOLLOW_UP_MAX_CHARS («continue», «fix the
  // failing test») is a follow-up: it merges with the previous request
  // instead of replacing it — quoted alone it IS the thin brief. When the
  // accumulation outgrows ORIGINAL_REQUEST_CHAR_BUDGET, the stale head is
  // clipped and the follow-up stays whole at the end: the newest instruction
  // is exactly what a worker must not miss. An empty prompt (an image-only
  // run) keeps the previous request; a non-user run (steer, custom) never
  // touches it; a new session starts clean.
  let originalRequest: string | undefined;
  pi.on("before_agent_start", (event) => {
    if (event.messageType !== "user") return;
    const text = event.prompt.trim();
    if (text.length === 0) return;
    if (text.length < FOLLOW_UP_MAX_CHARS && originalRequest !== undefined) {
      const merged = `${originalRequest}\n\n--- follow-up ---\n${text}`;
      const overflow = merged.length - ORIGINAL_REQUEST_CHAR_BUDGET;
      if (overflow > 0) {
        const cut = merged.slice(overflow);
        // A head cut can split a surrogate pair; drop the orphaned half.
        const first = cut.charCodeAt(0);
        originalRequest = first >= 0xdc00 && first <= 0xdfff ? cut.slice(1) : cut;
      } else {
        originalRequest = merged;
      }
    } else {
      originalRequest = event.prompt;
    }
  });
  pi.registerTool({
    name: FUSION_TOOL_NAME,
    label: "Fusion delegate",
    description:
      "Split independent work into 1..16 tasks and run them in parallel on a pool of fresh worker agents; returns each task's report.",
    parameters: FusionContractSchema,
    outputSchema: FanoutResultSchema,
    exposure: "direct",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return runFusionDelegate(pi, readConfig(), params, signal, ctx, originalRequest);
    },
  });
  pi.on("session_start", (event) => {
    // Defensive reset against instance reuse across sessions: in the real
    // host every new/resume/fork/reload builds a fresh closure (so the
    // request starts empty anyway), and a reload loses the captured prompt
    // just the same. Keeping it on "reload" costs nothing and documents the
    // intent: only a genuinely new conversation clears the quote.
    if (event?.reason !== "reload") originalRequest = undefined;
    if (!readConfig().enabled) {
      pi.setActiveTools(pi.getActiveTools().filter((name) => name !== FUSION_TOOL_NAME));
    }
  });
}

/** Where the worker agent must exist for this extension's options. */
function workerAgentTargetPath(agentDir: string | undefined): string {
  return agentDir === undefined
    ? defaultWorkerAgentTargetPath()
    : join(agentDir, "agents", FUSION_WORKER_AGENT_FILENAME);
}

/**
 * Binds the `/fusion` deps to the production modules: fresh reads and atomic
 * persistence from config.ts, the active tool set from pi, the worker-agent
 * check/install from worker-install.ts, notifications from the command
 * context (bd pi-fusion-chq review fix: the command must act on the real
 * extension runtime, not a test-only seam).
 */
function makeFusionCommandDeps(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  options: FusionExtensionOptions,
): FusionCommandDeps {
  const configPath = options.configPath;
  const agentDir = options.agentDir;
  // ctx.ui is a structural superset of FusionUIDialogs; null when the run
  // mode has no dialog-capable UI (headless — /fusion config refuses).
  const dialogs = ctx.hasUI ? ctx.ui : null;
  const deps: FusionCommandDeps = {
    toolName: FUSION_TOOL_NAME,
    loadConfig: () => loadFusionConfig(configPath),
    persistConfig: (next) => persistFusionConfig(next, configPath),
    getActiveTools: () => pi.getActiveTools(),
    setActiveTools: (toolNames) => pi.setActiveTools(toolNames),
    agentInstalled: () => existsSync(workerAgentTargetPath(agentDir)),
    installAgent: () => {
      installFusionWorkerAgent(agentDir === undefined ? {} : { agentDir });
    },
    notify: (message, level) => ctx.ui.notify(message, level),
    dialogs,
    interactiveConfig: () => {
      if (!dialogs) return Promise.resolve();
      return interactiveFusionConfig(deps, dialogs);
    },
  };
  return deps;
}

/**
 * Extension entry: tool + feature flag, the per-run guidance section, the
 * `/fusion` command and the F19 lead gate — all reading the same fusion.json.
 */
export default function fusionExtension(
  pi: ExtensionAPI,
  options: FusionExtensionOptions = {},
): void {
  const startup = loadFusionConfig(options.configPath);
  registerFusionDelegate(pi, () => loadFusionConfig(options.configPath));
  registerFusionGuidance(pi, () => loadFusionConfig(options.configPath));
  registerFusionCommand(pi, (ctx) => makeFusionCommandDeps(pi, ctx, options));
  // F19: while fusion is on, the lead session cannot call its own
  // write/edit/bash — the doing belongs to the workers. isEnabled is read
  // fresh per call, so /fusion off frees the lead without a reload; the
  // blocked list binds the startup leadBlockedTools (the command never edits
  // that field).
  registerLeadRestrictions(pi, {
    isEnabled: () => loadFusionConfig(options.configPath).enabled,
    blockedTools: startup.leadBlockedTools,
  });
}
