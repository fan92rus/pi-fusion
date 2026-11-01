/**
 * The `/fusion` command (design rev.5.2 F02, PLAN §83): the operator flips
 * `enabled` in fusion.json — the truth that survives restart — adds or removes
 * `fusion_delegate` from the active tool set, reads the state with `/fusion
 * status` and edits the pool fields (`workers`, `model`, `timeout`) with
 * validation. The guidance section (F08 `guidance.ts`) reads `enabled` from
 * the config per run, so on/off makes it appear or disappear without this
 * module touching the prompt.
 *
 * The subcommand list, the completions and the help text are all derived from
 * one `FUSION_SUBCOMMANDS` table (pi-autoresearch `commands.ts` precedent), so
 * a new subcommand cannot appear in one of them and miss the others. All
 * effects go through the injected `FusionCommandDeps` seam — the same pattern
 * as `registerFusionDelegate(pi, config)` — so tests pin behaviour, not pi's
 * process; `index.ts` binds the deps to config.ts, worker-install.ts and
 * `ctx.ui`.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
// The full persisted config (config.ts), not the read-only bridge view: the
// command persists whole snapshots, so dropping the approval/tool fields
// would silently reset them (bd pi-fusion-chq review fix).
import { FUSION_CONFIG_BOUNDS, type FusionConfig } from "./config.ts";

export interface FusionSubcommand {
  name: string;
  description: string;
}

/** The one list of /fusion subcommands: completions, dispatch and help. */
export const FUSION_SUBCOMMANDS: readonly FusionSubcommand[] = [
  {
    name: "on",
    description:
      "Enable fusion: persist enabled, declare fusion_delegate to the model, install the worker agent if missing.",
  },
  {
    name: "off",
    description: "Disable fusion: persist enabled, drop fusion_delegate from the model's tools.",
  },
  {
    name: "status",
    description:
      "Show enabled, worker models, width, timeout and whether the fusion-worker agent is installed.",
  },
  { name: "workers", description: "Set the worker pool size, e.g. /fusion workers 4." },
  {
    name: "model",
    description: "Set the worker model rotation, e.g. /fusion model vendor/name, other/name.",
  },
  {
    name: "timeout",
    description: "Set the per-task wall-time budget in ms, e.g. /fusion timeout 300000.",
  },
  { name: "help", description: "Show this help." },
];

// Accepted but not offered as completions: `help` already covers them.
const HELP_ALIASES: ReadonlySet<string> = new Set(["--help", "-h"]);

const NAME_GUTTER = 2;

/**
 * Everything a subcommand may effect. `index.ts` binds these to the real
 * config module, the worker-agent installer and `ctx.ui`; tests record calls.
 * `toolName` is the registered fan-out tool (`fusion_delegate`) whose presence
 * in the active set is the mode; it is injected to keep this module free of a
 * circular import with index.ts.
 */
export interface FusionCommandDeps {
  toolName: string;
  /** Fresh read of fusion.json — the truth a restart would see. */
  loadConfig(): FusionConfig;
  /** Atomic persist of the changed snapshot (tmp+rename in config.ts). */
  persistConfig(next: FusionConfig): void;
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): void;
  /** Whether `~/.pi/agent/agents/fusion-worker.md` resolves. */
  agentInstalled(): boolean;
  /** Copy the packaged worker agent into the pi agents dir (worker-install.ts). */
  installAgent(): void;
  notify(message: string, level?: "info" | "warning" | "error"): void;
}

/** The completions for the argument being typed; derived from FUSION_SUBCOMMANDS. */
export function getFusionArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  const typed = argumentPrefix.trim().toLowerCase();
  // pi applies an open completion on Enter instead of submitting, so offering
  // a subcommand that is already typed in full would make it take two Enters.
  if (isSubcommandName(typed)) return null;
  const matches = FUSION_SUBCOMMANDS.filter((subcommand) => subcommand.name.startsWith(typed));
  return matches.length > 0 ? matches.map(toAutocompleteItem) : null;
}

/** The help text: a usage line and one aligned entry per subcommand. */
export function renderFusionHelp(): string {
  return [
    `Usage: /fusion [${FUSION_SUBCOMMANDS.map((s) => s.name).join("|")}]`,
    "",
    ...describedLines(FUSION_SUBCOMMANDS),
  ].join("\n");
}

/** Dispatches one `/fusion <args>` invocation; every effect goes through deps. */
export function runFusionCommand(args: string, deps: FusionCommandDeps): void {
  const trimmed = (args ?? "").trim();
  const lowered = trimmed.toLowerCase();
  if (trimmed.length === 0 || lowered === "help" || HELP_ALIASES.has(lowered)) {
    deps.notify(renderFusionHelp());
    return;
  }

  // Model ids are case-sensitive (review fix, bd pi-fusion-chq): only the
  // subcommand word is matched case-insensitively; the remainder is passed
  // through verbatim so `/fusion model Vendor/Name` keeps its exact case.
  const [rawName] = trimmed.split(/\s+/);
  const name = (rawName ?? "").toLowerCase();
  const argument = trimmed.slice((rawName ?? "").length).trim();

  switch (name) {
    case "on":
      turnFusion(deps, true);
      return;
    case "off":
      turnFusion(deps, false);
      return;
    case "status":
      showStatus(deps);
      return;
    case "workers":
      setNumberField(deps, "workers", argument, "workers", "/fusion workers 4");
      return;
    case "model":
      setModels(deps, argument);
      return;
    case "timeout":
      setNumberField(deps, "taskTimeoutMs", argument, "timeout", "/fusion timeout 300000");
      return;
    default:
      deps.notify(`Unknown /fusion subcommand: ${name}. Run /fusion help for the list.`, "error");
  }
}

/** Registers the command; `makeDeps` binds the deps per invocation's context. */
export function registerFusionCommand(
  pi: ExtensionAPI,
  makeDeps: (ctx: ExtensionCommandContext) => FusionCommandDeps,
): void {
  pi.registerCommand("fusion", {
    description: "Configure fusion mode: on, off, status, workers, model, timeout, help",
    getArgumentCompletions: (argumentPrefix) => getFusionArgumentCompletions(argumentPrefix),
    handler: async (args, ctx) => {
      runFusionCommand(args, makeDeps(ctx));
    },
  });
}

// ─── subcommands ───────────────────────────────────────────────────────────

/** on/off: persist enabled, then move the tool in or out of the active set. */
function turnFusion(deps: FusionCommandDeps, enabled: boolean): void {
  deps.persistConfig({ ...deps.loadConfig(), enabled });
  const active = deps.getActiveTools();
  const has = active.includes(deps.toolName);
  if (enabled && !has) deps.setActiveTools([...active, deps.toolName]);
  if (!enabled && has) deps.setActiveTools(active.filter((name) => name !== deps.toolName));
  if (enabled && !deps.agentInstalled()) {
    deps.installAgent();
    deps.notify("fusion: on — the fusion-worker agent was missing and has been installed.");
    return;
  }
  deps.notify(`fusion: ${enabled ? "on" : "off"}.`);
}

function showStatus(deps: FusionCommandDeps): void {
  const config = deps.loadConfig();
  const models = config.workerModels;
  const modelList =
    models.length > 0
      ? models.join(", ")
      : "(none — every fan-out is refused until models are set)";
  const agent = deps.agentInstalled() ? "installed" : "missing (run /fusion on to install)";
  deps.notify(
    [
      `fusion: ${config.enabled ? "on" : "off"}`,
      `agent fusion-worker: ${agent}`,
      `workers: ${config.workers} (maxParallel ${config.maxParallel})`,
      `models: ${modelList}`,
      `timeout: ${config.taskTimeoutMs} ms per task`,
    ].join("\n"),
  );
}

function setNumberField(
  deps: FusionCommandDeps,
  field: "workers" | "taskTimeoutMs",
  argument: string,
  label: string,
  usage: string,
): void {
  const value = parsePositiveInt(argument);
  if (value === null) {
    deps.notify(`${label} needs one positive whole number, e.g. ${usage}`, "error");
    return;
  }
  // The same inclusive bounds config.ts enforces on load: a value outside
  // them would be silently replaced by the default on the next read, so
  // refuse it here instead of persisting a setting that never takes effect
  // (review fix, bd pi-fusion-chq).
  const { min, max } = FUSION_CONFIG_BOUNDS[field];
  if (value < min || value > max) {
    deps.notify(`${label} needs a whole number from ${min} to ${max}, e.g. ${usage}`, "error");
    return;
  }
  deps.persistConfig({ ...deps.loadConfig(), [field]: value });
  deps.notify(`${label}: ${value} — persisted to fusion.json.`);
}

function setModels(deps: FusionCommandDeps, argument: string): void {
  const models = argument.split(/[\s,]+/).filter((model) => model.length > 0);
  if (models.length === 0) {
    deps.notify("model needs at least one id, e.g. /fusion model vendor/name, other/name", "error");
    return;
  }
  deps.persistConfig({ ...deps.loadConfig(), workerModels: models });
  deps.notify(`models: ${models.join(", ")} — persisted to fusion.json.`);
}

// ─── helpers ───────────────────────────────────────────────────────────────

function isSubcommandName(typed: string): boolean {
  return FUSION_SUBCOMMANDS.some((subcommand) => subcommand.name === typed);
}

function toAutocompleteItem(subcommand: FusionSubcommand): AutocompleteItem {
  return { value: subcommand.name, label: subcommand.name, description: subcommand.description };
}

function describedLines(entries: readonly FusionSubcommand[]): string[] {
  const nameColumnWidth = Math.max(...entries.map((entry) => entry.name.length)) + NAME_GUTTER;
  return entries.map((entry) => `${entry.name.padEnd(nameColumnWidth)}${entry.description}`);
}

/** One token of `^\d+$` worth at least 1; everything else is a usage error. */
function parsePositiveInt(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const value = Number.parseInt(text.trim(), 10);
  return Number.isInteger(value) && value >= 1 ? value : null;
}
