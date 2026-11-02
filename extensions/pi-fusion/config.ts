/**
 * Full fusion configuration (design rev.5.2 §4, PLAN F01): load, validate and
 * atomically persist `fusion.json` in the pi agent dir. This is the editable
 * superset of the read-only `config-bridge.ts` snapshot: it adds the approval
 * gate (`requireApproval`) and the tool deny-lists that shape the workers
 * (`blockedTools`) and the lead (`leadBlockedTools`).
 *
 * Robustness contract: a missing file is a normal first run and silently
 * yields the defaults; an unreadable or non-JSON document warns and yields
 * the defaults; every field is taken only when it has the right type and is
 * inside its bounds, otherwise the field warns and keeps its default. The
 * extension never fails to load over its own settings.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { FanoutConfig } from "./pool/fanout.ts";
import { RESEARCHER_WEB_MODES, type ResearcherWebMode } from "./types.ts";

/** Editable operator configuration, persisted as the pi agent dir's `fusion.json`. */
export interface FusionConfig extends FanoutConfig {
  /** Delegate actions wait for explicit lead approval before workers run. */
  requireApproval: boolean;
  /** Tools removed from every fusion worker's active set. */
  blockedTools: string[];
  /** Tools removed from the lead session's active set while fusion is on. */
  leadBlockedTools: string[];
  /**
   * The researcher's web-tool composition (design §4.9.3): exactly one
   * researcher profile matches it, so a launch never carries a list of
   * "optional" web tool names. `none` is the only composition that can
   * never fail a launch because of the web; verified live: `both` works in
   * this environment (bd pi-fusion-8t2.2.5).
   */
  researcherWeb: ResearcherWebMode;
}

function frozenList(items: readonly string[]): string[] {
  // Frozen at runtime, mutable in type: snapshots must be read-only without
  // diverging from the mutable `string[]` shape the pool contract expects.
  return Object.freeze([...items]) as unknown as string[];
}

/** Design defaults (F01): width 3, 10 min per task, approval on. Activation is per session, not here. */
export const FUSION_CONFIG_DEFAULTS: Readonly<FusionConfig> = Object.freeze({
  workers: 3,
  maxParallel: 3,
  taskTimeoutMs: 600_000,
  workerModels: frozenList([]),
  maxSteps: 60,
  requireApproval: true,
  blockedTools: frozenList(["fusion_delegate", "subagent", "codemode"]),
  // OQ-1 (approved 2026-11-01): powershell closes the F19 bypass on Windows;
  // blocking a tool the host does not expose is harmless (design TD-08).
  leadBlockedTools: frozenList(["write", "edit", "bash", "powershell"]),
  researcherWeb: "none",
});

/** Inclusive validation bounds; out-of-range values keep their field default. */
/**
 * The inclusive validation bounds, shared with the `/fusion` command so the
 * operator-facing validation cannot drift from what config.ts accepts.
 */
export const FUSION_CONFIG_BOUNDS = {
  workers: { min: 1, max: Number.MAX_SAFE_INTEGER },
  maxParallel: { min: 1, max: 8 },
  taskTimeoutMs: { min: 30_000, max: 3_600_000 },
  maxSteps: { min: 1, max: 10_000 },
} as const;

/**
 * The pi agent dir: `PI_CODING_AGENT_DIR` when set (with `~` expanded against
 * the user home, mirroring pi-subagents' getAgentDir), else `~/.pi/agent`.
 */
function resolveAgentDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (configured === "~") return home;
  if (configured !== undefined && (configured.startsWith("~/") || configured.startsWith("~\\"))) {
    return join(home, configured.slice(2));
  }
  return configured || join(home, ".pi", "agent");
}

/** `…/agent/fusion.json` — the file this module loads and persists. */
export function defaultFusionConfigPath(): string {
  return join(resolveAgentDir(), "fusion.json");
}

function isIntInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.trim().length > 0)
  );
}

function isResearcherWebMode(value: unknown): value is ResearcherWebMode {
  return typeof value === "string" && (RESEARCHER_WEB_MODES as readonly string[]).includes(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Set once per process: `enabled` is retired (fusion activation moved to the
 * session), and config.ts is read several times per turn — one warning is enough.
 */
let retiredEnabledWarned = false;

/** A fresh independent copy of the defaults or of a validated document. */
function snapshot(config: FusionConfig): Readonly<FusionConfig> {
  return Object.freeze({
    workers: config.workers,
    maxParallel: config.maxParallel,
    taskTimeoutMs: config.taskTimeoutMs,
    workerModels: frozenList(config.workerModels),
    maxSteps: config.maxSteps,
    requireApproval: config.requireApproval,
    blockedTools: frozenList(config.blockedTools),
    leadBlockedTools: frozenList(config.leadBlockedTools),
    researcherWeb: config.researcherWeb,
  });
}

function readFields(fields: Record<string, unknown>, path: string): FusionConfig {
  const warnField = (key: string): void => {
    console.warn(`[pi-fusion] ${path}: field "${key}" has an invalid value, keeping the default`);
  };
  if (Object.hasOwn(fields, "enabled") && !retiredEnabledWarned) {
    retiredEnabledWarned = true;
    console.warn(
      `[pi-fusion] ${path}: field "enabled" is retired and ignored; fusion is switched per session with /fusion on|off`,
    );
  }
  const number = (
    key: keyof FusionConfig,
    bound: { min: number; max: number },
    fallback: number,
  ): number => {
    const value = fields[key];
    if (value === undefined) return fallback;
    if (!isIntInRange(value, bound.min, bound.max)) {
      warnField(key);
      return fallback;
    }
    return value;
  };
  const flag = (key: keyof FusionConfig, fallback: boolean): boolean => {
    const value = fields[key];
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") {
      warnField(key);
      return fallback;
    }
    return value;
  };
  const list = (key: keyof FusionConfig, fallback: string[]): string[] => {
    const value = fields[key];
    if (value === undefined) return fallback;
    if (!isStringList(value)) {
      warnField(key);
      return fallback;
    }
    return [...value];
  };
  const mode = (key: keyof FusionConfig, fallback: ResearcherWebMode): ResearcherWebMode => {
    const value = fields[key];
    if (value === undefined) return fallback;
    if (!isResearcherWebMode(value)) {
      warnField(key);
      return fallback;
    }
    return value;
  };
  const defaults = FUSION_CONFIG_DEFAULTS;
  return {
    workers: number("workers", FUSION_CONFIG_BOUNDS.workers, defaults.workers),
    maxParallel: number("maxParallel", FUSION_CONFIG_BOUNDS.maxParallel, defaults.maxParallel),
    taskTimeoutMs: number(
      "taskTimeoutMs",
      FUSION_CONFIG_BOUNDS.taskTimeoutMs,
      defaults.taskTimeoutMs,
    ),
    workerModels: list("workerModels", [...defaults.workerModels]),
    maxSteps: number("maxSteps", FUSION_CONFIG_BOUNDS.maxSteps, defaults.maxSteps),
    requireApproval: flag("requireApproval", defaults.requireApproval),
    blockedTools: list("blockedTools", [...defaults.blockedTools]),
    leadBlockedTools: list("leadBlockedTools", [...defaults.leadBlockedTools]),
    researcherWeb: mode("researcherWeb", defaults.researcherWeb),
  };
}

/**
 * Reads the settings file; every field is taken only when it has the right
 * type and sits inside its bounds. Each call returns a new frozen snapshot,
 * so callers cannot change the defaults or each other's view.
 */
export function loadFusionConfig(path: string = defaultFusionConfigPath()): Readonly<FusionConfig> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return snapshot(FUSION_CONFIG_DEFAULTS);
    }
    console.warn(`[pi-fusion] ${path} is unreadable (${errorText(error)}); using defaults`);
    return snapshot(FUSION_CONFIG_DEFAULTS);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(`[pi-fusion] ${path} is not valid JSON (${errorText(error)}); using defaults`);
    return snapshot(FUSION_CONFIG_DEFAULTS);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.warn(`[pi-fusion] ${path} is not a JSON object; using defaults`);
    return snapshot(FUSION_CONFIG_DEFAULTS);
  }
  return snapshot(readFields(parsed as Record<string, unknown>, path));
}

/**
 * Writes the full canonical configuration atomically: the JSON document
 * lands in a sibling temporary file and is moved onto the target with a
 * rename, so a reader never observes a partial file. Creates the agent dir
 * when missing and removes the temporary file when the move fails.
 */
export function persistFusionConfig(
  config: FusionConfig,
  path: string = defaultFusionConfigPath(),
): void {
  const canonical = {
    workers: config.workers,
    maxParallel: config.maxParallel,
    taskTimeoutMs: config.taskTimeoutMs,
    workerModels: [...config.workerModels],
    maxSteps: config.maxSteps,
    requireApproval: config.requireApproval,
    blockedTools: [...config.blockedTools],
    leadBlockedTools: [...config.leadBlockedTools],
    researcherWeb: config.researcherWeb,
  };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(canonical, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}
