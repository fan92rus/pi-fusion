/**
 * Lead restrictions (PLAN F19, atomic-agent `fusion-orchestrator-mode`): while
 * fusion is on, the main session's mutating tools are refused on the
 * `tool_call` hook — `write`, `edit` and `bash` as a whole. Bash mutates
 * through python, sed or redirects, so command classification is unreliable
 * and the block is total. The code is written by the workers; the lead plans,
 * delegates and reviews.
 *
 * The block never depends on state: nothing unlocks a mutating tool within a
 * run. State only shapes the refusal text, read from the FanoutResult that
 * each completed `fusion_delegate` call carries as `structuredContent`:
 *   - before any fan-out: plan and delegate;
 *   - after a fan-out: send the rework out again (needs_orchestrator = a new
 *     fan-out with paths in `files`);
 *   - after BARREN_DELEGATION_LIMIT fan-outs in a row in which every task ran
 *     zero steps: the worker leg is not running, tell the operator.
 *
 * The state resets on `agent_start` (the spec's "turn": one user-initiated
 * run = one agent_start..agent_end scope — pi fires turn_start per model
 * request, which would wipe the post-fan-out phase before the model sees it).
 *
 * Child processes (pi-subagents runner, `PI_SUBAGENT_CHILD=1`) are workers,
 * not the lead: the gate is inert there, or the workers would be blocked too.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { Value } from "@sinclair/typebox/value";
import { isPathInsideOpenSpecTarget, isSinglePerlInvocation } from "./lead-access.ts";
import { type FanoutResult, FanoutResultSchema, type TaskResult } from "./types.ts";

/** The fan-out tool name (index.ts FUSION_TOOL_NAME; not imported, to keep this module free of index.ts). */
const DELEGATE_TOOL = "fusion_delegate";

/**
 * Default `leadBlockedTools` (PLAN F01 + OQ-1 approved 2026-11-01): the
 * mutating tools plus `powershell` — the host declares that tool name, and
 * blocking it closes the F19 bypass on Windows. Blocking a tool the host
 * does not expose is harmless; the perl exception never applies to
 * powershell (design TD-08).
 */
export const LEAD_BLOCKED_TOOLS: readonly string[] = ["write", "edit", "bash", "powershell"];

/** The additional refusal line when a write/edit falls outside the boundary (design §5.1). */
export const OPENSPEC_REFUSAL_NOTE =
  "вне каталога документации OpenSpec код пишут воркеры; исключение лида ограничено целевым каталогом openspec/";

/**
 * Barren fan-outs in a row before the refusal stops asking for another one.
 * Two, not one: a single all-cancelled fan-out (an operator's Esc) is not a
 * broken leg.
 */
export const BARREN_DELEGATION_LIMIT = 2;

export interface LeadRestrictionState {
  /** Completed fan-outs with results in the current run. */
  delegations: number;
  /** Consecutive fan-outs in which no worker executed a step. */
  barrenDelegations: number;
}

export function emptyLeadRestrictionState(): LeadRestrictionState {
  return { delegations: 0, barrenDelegations: 0 };
}

/**
 * Steps a task ran: the terminal `turns`, else the last `turnsObserved`
 * snapshot (design TD-008); `undefined` = unknown, never zero (B4-R1).
 */
function taskSteps(task: TaskResult): number | undefined {
  return task.turns ?? task.turnsObserved;
}

/**
 * Did the fan-out run anything? Only an explicit zero on every task is
 * barren. Unknown steps count as work: the refusal keeps asking for a rework
 * rather than telling the lead to stop on a signal it cannot read.
 */
export function fanoutProducedWork(result: FanoutResult): boolean {
  if (result.results.length === 0) return true;
  return result.results.some((task) => taskSteps(task) !== 0);
}

/** Counts one completed fan-out with results. */
export function recordFanout(
  state: LeadRestrictionState,
  result: FanoutResult,
): LeadRestrictionState {
  return {
    delegations: state.delegations + 1,
    barrenDelegations: fanoutProducedWork(result) ? 0 : state.barrenDelegations + 1,
  };
}

/** What the lead is told; the wording depends on the fan-out state. */
export function refusalText(toolName: string, state: LeadRestrictionState): string {
  if (state.barrenDelegations >= BARREN_DELEGATION_LIMIT) {
    return (
      `${toolName} не выполнен: последние ${state.barrenDelegations} fan-out'а — все воркеры выполнили 0 шагов. ` +
      `Ещё один fusion_delegate это не починит: воркер-нога не работает — скажи оператору, что ты строишь ` +
      `и что нужно от него (например, поднят ли сервер воркеров). Код сам не пиши.`
    );
  }
  if (state.delegations === 0) {
    return (
      `${toolName} не выполнен: fusion включён, код пишут воркеры — планируй и делегируй — отправь fusion_delegate: ` +
      `по одной задаче на независимую часть, в files — точные пути, которые она создаёт, критерий готовности ` +
      `и формат ответа.`
    );
  }
  return (
    `${toolName} не выполнен: в этом запуске ты делегировал ${state.delegations} раз(а), и собирать результат ` +
    `самому этот режим запрещает, как бы ни прошёл последний fan-out; отправь переделку: needs_orchestrator = ` +
    `новый fan-out, пути в files, не захватывай работу сам. Скажи, что было не так, что поменять и как ` +
    `выглядит «готово».`
  );
}

function isFanoutResult(value: unknown): value is FanoutResult {
  return Value.Check(FanoutResultSchema, value);
}

export interface LeadRestrictionOptions {
  /** Feature flag: the gate applies only while fusion is on. */
  isEnabled: () => boolean;
  /** Tools the lead may not call; defaults to LEAD_BLOCKED_TOOLS. */
  blockedTools?: readonly string[];
  /** False in a child worker process; defaults to "not PI_SUBAGENT_CHILD=1". */
  isLeadSession?: () => boolean;
  /**
   * The session root the openspec/ boundary is resolved against; defaults
   * to the handler's `ctx.cwd` (the main session cwd). Overridable in tests.
   */
  projectRoot?: () => string;
  /**
   * The pi agent dir holding settings.json; defaults to PI_CODING_AGENT_DIR
   * (or ~/.pi/agent) — the same resolution the config bridge uses.
   */
  agentDir?: () => string;
}

function isMainProcess(): boolean {
  return process.env.PI_SUBAGENT_CHILD !== "1";
}

function defaultAgentDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const configured = process.env.PI_CODING_AGENT_DIR;
  // Expand ~ exactly like config.ts resolveAgentDir (review blocker: a
  // literal ~ path made the settings read ENOENT, which read as "stock
  // install" and left the perl exception ON under a custom shellPath).
  if (configured === "~") return home;
  if (configured !== undefined && (configured.startsWith("~/") || configured.startsWith("~\\"))) {
    return join(home, configured.slice(2));
  }
  if (configured !== undefined && configured.length > 0) return configured;
  return home.length > 0 ? join(home, ".pi", "agent") : ".pi/agent";
}

/**
 * Whether the host bash tool runs a CUSTOM shell (design §6.1.5): any
 * configured `shellPath` in settings.json means POSIX-quoting parity is
 * unproven, so the perl exception is OFF — and an unreadable settings file
 * fails closed the same way. An empty string counts as not configured
 * (settings-manager normalizes the value only when truthy).
 */
/**
 * Whether ONE settings file signals a non-default shell for the bash tool
 * (design §6.1.5): a configured `shellPath` means POSIX-quoting parity is
 * unproven; a configured `shellCommandPrefix` means the executed command is
 * not the classified string — either way the perl exception is OFF. Any
 * truthy non-string `shellPath` also counts as configured (fail-closed;
 * the host truthy-checks the value before normalizing). A missing file is
 * the stock install (not configured); corrupt/unreadable fails closed.
 */
function settingsDisablesPerlException(path: string): boolean {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return true; // fail closed
    const record = parsed as Record<string, unknown>;
    const shellPath = record.shellPath;
    const customShell =
      shellPath === undefined || shellPath === null
        ? false
        : typeof shellPath === "string"
          ? shellPath.trim().length > 0
          : Boolean(shellPath);
    const prefix = record.shellCommandPrefix;
    const prefixSet =
      prefix !== undefined &&
      prefix !== null &&
      (!(typeof prefix === "string") || prefix.trim().length > 0);
    return customShell || prefixSet;
  } catch (error) {
    // A MISSING file is the stock install — the host's own POSIX shell, no
    // custom shellPath. Everything else (corrupt JSON, unreadable) fails
    // closed: the exception stays off (§6.1.5).
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true;
  }
}

/**
 * The host bash tool runs a CUSTOM shell when `shellPath` (or a
 * `shellCommandPrefix`) is set in the MERGED settings — global
 * (agentDir/settings.json) OR project (projectRoot/.pi/settings.json,
 * settings-manager.js:220 deepMerge). Either file disables the perl
 * exception (§6.1.5); in pwsh `;` separates commands, so the classified
 * "single call" would be a lie about the executed command.
 */
function hostShellCustomized(agentDir: string, projectRoot: string): boolean {
  return (
    settingsDisablesPerlException(join(agentDir, "settings.json")) ||
    settingsDisablesPerlException(join(projectRoot, ".pi", "settings.json"))
  );
}

/** The exception-aware decision for one blocked tool call (design §5.1, §6.1). */
function gateDecision(
  toolName: string,
  input: unknown,
  state: LeadRestrictionState,
  projectRoot: string,
  agentDir: string,
): ToolCallEventResult | undefined {
  const block = (reason: string): ToolCallEventResult => ({ block: true, reason });

  if (toolName === "write" || toolName === "edit") {
    const path =
      typeof input === "object" &&
      input !== null &&
      typeof (input as { path?: unknown }).path === "string"
        ? (input as { path: string }).path
        : undefined;
    if (path === undefined) {
      // Conservative: a call whose path we cannot read is not verifiable.
      return block(
        `${refusalText(toolName, state)} Причина исключения: у вызова нет пути — исключение openspec/ не применяется`,
      );
    }
    const check = isPathInsideOpenSpecTarget(path, { projectRoot });
    if (check.allowed) return undefined; // inside the realpath target of openspec/ (OQ-4)
    const note = check.reason.includes("вне каталога") ? OPENSPEC_REFUSAL_NOTE : check.reason;
    return block(`${refusalText(toolName, state)} Причина исключения: ${note}`);
  }

  if (toolName === "bash") {
    const command =
      typeof input === "object" &&
      input !== null &&
      typeof (input as { command?: unknown }).command === "string"
        ? (input as { command: string }).command
        : undefined;
    if (command === undefined) {
      return block(
        `${refusalText(toolName, state)} Причина исключения: у вызова нет команды — исключение perl не применяется`,
      );
    }
    const verdict = isSinglePerlInvocation(command);
    if (!verdict.ok) {
      return block(
        `${refusalText(toolName, state)} Причина исключения: не одиночный вызов perl — ${verdict.reason}`,
      );
    }
    if (hostShellCustomized(agentDir, projectRoot)) {
      return block(
        `${refusalText(toolName, state)} Причина исключения: оболочка не POSIX-совместима (задан shellPath или префикс) — исключение perl отключено`,
      );
    }
    return undefined; // exactly one perl call under the host's own POSIX shell (§6.1)
  }

  // powershell and anything else on the block list: no exception applies.
  return block(refusalText(toolName, state));
}

/** Registers the lead gate: the tool_call refusal plus the run-scoped fan-out state. */
export function registerLeadRestrictions(pi: ExtensionAPI, options: LeadRestrictionOptions): void {
  const blocked = new Set<string>(options.blockedTools ?? LEAD_BLOCKED_TOOLS);
  const isLeadSession = options.isLeadSession ?? isMainProcess;
  let state = emptyLeadRestrictionState();

  // One user-initiated run = one agent_start..agent_end scope (the
  // atomic-agent "turn"): the fan-out phase and barren streak reset per run,
  // NOT per model request — pi fires turn_start for every model request, so a
  // turn_start reset would wipe the post-fan-out phase before the model ever
  // sees it (orchestrator decision, bd pi-fusion-du1).
  pi.on("agent_start", () => {
    state = emptyLeadRestrictionState();
  });

  pi.on("tool_result", (event) => {
    if (event.toolName !== DELEGATE_TOOL) return;
    if (isFanoutResult(event.structuredContent)) {
      state = recordFanout(state, event.structuredContent);
    }
  });

  pi.on("tool_call", (event, ctx): ToolCallEventResult | undefined => {
    if (!blocked.has(event.toolName)) return undefined;
    if (!options.isEnabled() || !isLeadSession()) return undefined;
    return gateDecision(
      event.toolName,
      event.input,
      state,
      (options.projectRoot ?? (() => ctx?.cwd ?? process.cwd()))(),
      (options.agentDir ?? defaultAgentDir)(),
    );
  });
}
