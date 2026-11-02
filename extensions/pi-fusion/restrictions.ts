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
import { homedir as osHomedir } from "node:os";
import { posix, win32 } from "node:path";
import type { ExtensionAPI, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { Value } from "@sinclair/typebox/value";
import { classifyBashCommand, isPathInsideOpenSpecTarget } from "./lead-access.ts";
import { type FanoutResult, FanoutResultSchema, type TaskResult } from "./types.ts";

/** The fan-out tool name (index.ts FUSION_TOOL_NAME; not imported, to keep this module free of index.ts). */
const DELEGATE_TOOL = "fusion_delegate";

/**
 * Default `leadBlockedTools` (PLAN F01 + OQ-1 approved 2026-11-01): the
 * mutating tools plus `powershell` — the host declares that tool name, and
 * `subagent` (fusion-lead-subagent-block: every delegation goes through
 * `fusion_delegate`),
 * blocking it closes the F19 bypass on Windows. Blocking a tool the host
 * does not expose is harmless; the perl exception never applies to
 * powershell (design TD-08).
 */
export const LEAD_BLOCKED_TOOLS: readonly string[] = [
  "write",
  "edit",
  "bash",
  "powershell",
  "subagent",
];

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
  isEnabled: (ctx?: unknown) => boolean;
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
   * Override of the agent dir whose settings.json the shell-settings gate reads
   * (the global file, design §6.6). When set, it replaces the replica of the
   * host's getAgentDir(); the other shell-settings seams stay system ones.
   * Default: the replica of the host resolution (PI_CODING_AGENT_DIR, else
   * homedir()/.pi/agent). config.ts (fusion.json path) is NOT this resolution.
   */
  agentDir?: () => string;
  /**
   * Hermetic seam for the shell-settings gate (design §6.6): the env map,
   * homedir(), the platform name and readFile(path). Default: the system ones.
   */
  shellSettingsContext?: () => ShellSettingsContext;
}

function isMainProcess(): boolean {
  return process.env.PI_SUBAGENT_CHILD !== "1";
}

/** The env map, homedir(), platform name and readFile the shell-settings gate reads through (design §6.6). */
export interface ShellSettingsContext {
  env: Readonly<Record<string, string | undefined>>;
  homedir: () => string;
  platform: string;
  readFile: (path: string) => string;
}

/** The production seams: the live process env, os.homedir(), process.platform, readFileSync. */
export function systemShellSettingsContext(): ShellSettingsContext {
  return {
    env: process.env,
    homedir: osHomedir,
    platform: process.platform,
    readFile: (path) => readFileSync(path, "utf8"),
  };
}

/** The path module of the platform the seams describe (win32 or POSIX). */
function pathFor(platform: string) {
  return platform === "win32" ? win32 : posix;
}

type PathModule = typeof posix;

/** The host's homedir(), or `undefined` when it throws or is empty / not absolute (design §6.6 rule 3). */
function usableHomedir(homedir: () => string, p: PathModule): string | undefined {
  let home: unknown;
  try {
    home = homedir();
  } catch {
    return undefined;
  }
  return typeof home === "string" && home.length > 0 && p.isAbsolute(home) ? home : undefined;
}

/** The host's win32 `/c/…` → `C:\…` form (normalizeWindowsShellPath, pi-coding-agent); other inputs pass through. */
function normalizeWindowsShellPath(filePath: string): string {
  if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) {
    return filePath;
  }
  const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return filePath;
  const suffix = match[2]?.replace(/\//g, "\\");
  return `${(match[1] ?? "").toUpperCase()}:\\${suffix ?? ""}`;
}

/**
 * A local `file://` URL as a path (the host's fileURLToPath). A host part
 * (UNC or remote) is not derived here: `undefined`, which fails closed.
 */
function fileUrlToPath(url: string, platform: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.hostname !== "") return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(parsed.pathname);
  } catch {
    return undefined;
  }
  return platform === "win32"
    ? decoded.replace(/^\/([a-zA-Z]:)/, "$1").replace(/\//g, "\\")
    : decoded;
}

/**
 * The agent dir that holds the global settings.json: a replica of the host's
 * `getAgentDir()` (design §6.6 rule 1; pi-coding-agent chunk-BSS6T6KQ). Only
 * `PI_CODING_AGENT_DIR` decides; `HOME` and `USERPROFILE` never do. A relative
 * value stays relative, as on the host. `undefined` = the directory cannot be
 * derived (rule 3, fail-closed).
 */
export function resolveHostAgentDir(
  env: Readonly<Record<string, string | undefined>>,
  homedir: () => string,
  platform: string,
): string | undefined {
  const p = pathFor(platform);
  const configured = env.PI_CODING_AGENT_DIR;
  if (configured === undefined || configured === "") {
    const home = usableHomedir(homedir, p);
    return home === undefined ? undefined : p.join(home, ".pi", "agent");
  }
  // The host's order (normalizePath): the win32 /c/… form, then ~, then file://.
  const value = platform === "win32" ? normalizeWindowsShellPath(configured) : configured;
  if (value.startsWith("~")) {
    const home = usableHomedir(homedir, p);
    if (home === undefined) return undefined;
    if (value === "~") return home;
    if (value.startsWith("~/") || (platform === "win32" && value.startsWith("~\\"))) {
      return p.join(home, value.slice(2));
    }
    // "~user" is literal on the host (only ~ and ~/ expand); the check above is conservative.
  }
  if (/^file:\/\//.test(value)) return fileUrlToPath(value, platform);
  return value;
}

/**
 * What the shell settings say about the bash tool (design §6.1.5, §6.6, §6.7):
 * `stock` = the host's own POSIX shell; `custom` = a shellPath or a
 * shellCommandPrefix is configured; `unreadable` = a settings file could not be
 * read or parsed; `unresolvable` = the agent dir cannot be derived. The last
 * three disable the perl and bd exceptions (fail-closed).
 */
export type ShellSettingsVerdict = "stock" | "custom" | "unreadable" | "unresolvable";

/** The inputs of one shell-settings check; `replicaDir` = the agentDir override, when given. */
export interface ShellSettingsInput extends ShellSettingsContext {
  projectRoot: string;
  replicaDir?: string;
}

/**
 * ONE settings file (design §6.1.5). A missing file is the stock install (or
 * "not configured" for a HOME candidate). A configured `shellPath` (any truthy
 * non-string counts too: the host truthy-checks it before normalizing) or a
 * configured `shellCommandPrefix` means custom. Corrupt JSON, a non-object, or
 * any other read error is unreadable.
 */
function readShellSettings(path: string, readFile: (path: string) => string): ShellSettingsVerdict {
  let raw: string;
  try {
    raw = readFile(path);
  } catch (error) {
    return (error as { code?: unknown } | null)?.code === "ENOENT" ? "stock" : "unreadable";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "unreadable";
  }
  if (typeof parsed !== "object" || parsed === null) return "unreadable";
  const record = parsed as Record<string, unknown>;
  // The host truthy-checks shellPath (settings-manager getShellPath): any non-empty
  // value counts, whitespace included, so there is no trim here.
  const customShell = Boolean(record.shellPath);
  const prefix = record.shellCommandPrefix;
  const prefixSet =
    prefix !== undefined &&
    prefix !== null &&
    (!(typeof prefix === "string") || prefix.trim().length > 0);
  return customShell || prefixSet ? "custom" : "stock";
}

/**
 * The HOME and USERPROFILE candidates (design §6.6 rule 3(в)): each non-empty
 * value that differs from homedir() after normalization. They are extra checks
 * only: an extra file the host never reads can only disable the exception.
 */
function homeCandidateDirs(
  env: Readonly<Record<string, string | undefined>>,
  homedir: () => string,
  platform: string,
): string[] {
  const p = pathFor(platform);
  const fold = (path: string) => (platform === "win32" ? path.toLowerCase() : path);
  const home = usableHomedir(homedir, p);
  const homeKey = home === undefined ? undefined : fold(p.normalize(home));
  const dirs = new Map<string, string>();
  for (const name of ["HOME", "USERPROFILE"] as const) {
    const raw = env[name];
    if (raw === undefined || raw === "") continue;
    const dir = p.normalize(raw);
    if (fold(dir) === homeKey) continue;
    dirs.set(fold(dir), dir);
  }
  return [...dirs.values()];
}

/**
 * Reads every settings file the host can merge for the bash tool (global
 * replica, project `projectRoot/.pi/settings.json`, HOME/USERPROFILE
 * candidates). Any file that configures a shell wins; then any unreadable
 * file; then an unresolvable agent dir; otherwise stock. Only a stock verdict
 * keeps the exception.
 */
export function shellSettingsVerdict(input: ShellSettingsInput): ShellSettingsVerdict {
  const p = pathFor(input.platform);
  const replica = input.replicaDir ?? resolveHostAgentDir(input.env, input.homedir, input.platform);
  const files = new Set<string>();
  if (replica !== undefined) files.add(p.join(replica, "settings.json"));
  files.add(p.join(input.projectRoot, ".pi", "settings.json"));
  for (const dir of homeCandidateDirs(input.env, input.homedir, input.platform)) {
    files.add(p.join(dir, ".pi", "agent", "settings.json"));
  }
  let unreadable = false;
  for (const file of files) {
    const verdict = readShellSettings(file, input.readFile);
    if (verdict === "custom") return "custom";
    if (verdict === "unreadable") unreadable = true;
  }
  if (unreadable) return "unreadable";
  return replica === undefined ? "unresolvable" : "stock";
}

/**
 * The host bash tool runs a CUSTOM shell when `shellPath` (or a
 * `shellCommandPrefix`) is set in the MERGED settings — global OR project
 * (settings-manager.js:220 deepMerge). Either file disables the perl exception
 * (§6.1.5); in pwsh `;` separates commands, so the classified "single call"
 * would be a lie about the executed command.
 */
export function hostShellCustomized(
  env: Readonly<Record<string, string | undefined>>,
  homedir: () => string,
  platform: string,
  readFile: (path: string) => string,
  projectRoot: string,
): boolean {
  return shellSettingsVerdict({ env, homedir, platform, readFile, projectRoot }) !== "stock";
}

/** The cause of each disabling verdict (design §6.7); the exception name follows it per branch. */
const SHELL_CAUSE: Record<Exclude<ShellSettingsVerdict, "stock">, string> = {
  custom: "оболочка не POSIX-совместима (задан shellPath или префикс)",
  unreadable: "настройки оболочки нечитаемы или не разобраны",
  unresolvable: "каталог настроек агента не определяется",
};

/** The refusal reason when a disabling verdict meets a classified branch (design §6.5.3, §6.7): perl, bd and git texts are separate. */
function shellRefusal(
  branch: "perl" | "bd" | "git",
  verdict: Exclude<ShellSettingsVerdict, "stock">,
): string {
  return `${SHELL_CAUSE[verdict]} — исключение ${branch} отключено`;
}

/** The exception-aware decision for one blocked tool call (design §5.1, §6.1). */
function gateDecision(
  toolName: string,
  input: unknown,
  state: LeadRestrictionState,
  projectRoot: string,
  shellVerdict: () => ShellSettingsVerdict,
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
        `${refusalText(toolName, state)} Причина исключения: у вызова нет команды — исключения perl и bd не применяются`,
      );
    }
    const classified = classifyBashCommand(command);
    if (classified.branch === "other") {
      return block(
        `${refusalText(toolName, state)} Причина исключения: разрешены только одиночный вызов perl или одиночная команда bd (create/show/list/ready/update/close) — ${classified.reason}`,
      );
    }
    if (!classified.verdict.ok) {
      return block(
        `${refusalText(toolName, state)} Причина исключения: не одиночный вызов ${classified.branch} — ${classified.verdict.reason}`,
      );
    }
    const shell = shellVerdict();
    if (shell !== "stock") {
      return block(
        `${refusalText(toolName, state)} Причина исключения: ${shellRefusal(classified.branch, shell)}`,
      );
    }
    // exactly one perl or bd call under the host's own POSIX shell (§6.1, §6.5)
    return undefined;
  }

  // powershell and anything else on the block list: no exception applies.
  return block(refusalText(toolName, state));
}

/** Registers the lead gate: the tool_call refusal plus the run-scoped fan-out state. */
export function registerLeadRestrictions(pi: ExtensionAPI, options: LeadRestrictionOptions): void {
  const blocked = new Set<string>(options.blockedTools ?? LEAD_BLOCKED_TOOLS);
  const isLeadSession = options.isLeadSession ?? isMainProcess;
  const projectRootOf = (ctx: { cwd?: string } | undefined): string =>
    (options.projectRoot ?? (() => ctx?.cwd ?? process.cwd()))();
  const liveShellVerdict = (projectRoot: string): ShellSettingsVerdict =>
    shellSettingsVerdict({
      ...(options.shellSettingsContext ?? systemShellSettingsContext)(),
      projectRoot,
      ...(options.agentDir === undefined ? {} : { replicaDir: options.agentDir() }),
    });
  // The shell verdict is a snapshot taken at the lifecycle boundaries: here
  // (extension load, a child worker reads nothing) and at every session_start
  // (new, resume, fork, reload). The host captures its shellPath and
  // commandPrefix once, when it builds the runtime, so the gate must not
  // follow a later edit of the files. A snapshot that is not stock holds until
  // the next session_start, whatever the disk says then. This narrows the gap
  // to the host's own capture moment; it does not remove it (no TOCTOU claim).
  let pinnedShell: ShellSettingsVerdict = isLeadSession()
    ? liveShellVerdict(projectRootOf(undefined))
    : "stock";
  let state = emptyLeadRestrictionState();

  // One user-initiated run = one agent_start..agent_end scope (the
  // atomic-agent "turn"): the fan-out phase and barren streak reset per run,
  // NOT per model request — pi fires turn_start for every model request, so a
  // turn_start reset would wipe the post-fan-out phase before the model ever
  // sees it (orchestrator decision, bd pi-fusion-du1).
  pi.on("agent_start", () => {
    state = emptyLeadRestrictionState();
  });

  pi.on("session_start", (_event, ctx) => {
    pinnedShell = isLeadSession() ? liveShellVerdict(projectRootOf(ctx)) : "stock";
  });

  pi.on("tool_result", (event) => {
    if (event.toolName !== DELEGATE_TOOL) return;
    if (isFanoutResult(event.structuredContent)) {
      state = recordFanout(state, event.structuredContent);
    }
  });

  pi.on("tool_call", (event, ctx): ToolCallEventResult | undefined => {
    if (!blocked.has(event.toolName)) return undefined;
    let enabled = false;
    try {
      enabled = options.isEnabled(ctx);
    } catch {
      return { block: true, reason: "не удалось восстановить состояние сессии" };
    }
    if (!enabled || !isLeadSession()) return undefined;
    const projectRoot = projectRootOf(ctx);
    // Fail-closed: a non-stock snapshot wins over the live read; the live read
    // only matters when the snapshot is stock (the stock -> custom path).
    return gateDecision(event.toolName, event.input, state, projectRoot, () =>
      pinnedShell !== "stock" ? pinnedShell : liveShellVerdict(projectRoot),
    );
  });
}
