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
 *
 * Layers (openspec fusion-project-config, design D1-D3): the project file
 * `<projectDir>/.pi/fusion.json` overrides the global file per field. Both
 * layers are read by the same presence-aware parser, so a field is either
 * present-and-valid in a layer or absent from it; a list replaces the lower
 * layer as a whole, never merges with it.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { FanoutConfig } from "./pool/fanout.ts";
import { RESEARCHER_WEB_MODES, type ResearcherWebMode } from "./types.ts";

/**
 * Editable operator configuration, persisted as the pi agent dir's `fusion.json`.
 * It extends the pool's `FanoutConfig`, so every field the pool reads is also
 * a field the operator can set, layer and reset (openspec fusion-project-config).
 */
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

/** Where the effective value of each field comes from (design D2). */
export type FieldOrigins = { [K in keyof FusionConfig]: "local" | "global" | "default" };

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
  // openspec fusion-model-cooldown D5: the fallback cooldown length, 5 minutes.
  modelCooldownMs: 300_000,
  workerModels: frozenList([]),
  maxSteps: 60,
  requireApproval: true,
  blockedTools: frozenList(["fusion_delegate", "subagent", "codemode"]),
  // OQ-1 (approved 2026-11-01): powershell closes the F19 bypass on Windows;
  // blocking a tool the host does not expose is harmless (design TD-08).
  leadBlockedTools: frozenList(["write", "edit", "bash", "powershell", "subagent"]),
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
  // D5 (fusion-model-cooldown): the cooldown fallback bounds, which the pool
  // clamps a retry-after time to as well (pool/fanout.ts mirrors these bounds —
  // `config.test.ts` pins the two against each other so they cannot drift).
  modelCooldownMs: { min: 30_000, max: 3_600_000 },
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

/** `<projectDir>/.pi/fusion.json` — the project layer (design D1). */
export function projectFusionConfigPath(projectDir: string): string {
  return join(projectDir, ".pi", "fusion.json");
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

/**
 * Keys of the warnings already emitted in this process (a file, or one field
 * of a file, per key). config.ts is read on every tool call and every
 * `/fusion status`, so a broken file would otherwise repeat its warning for as
 * long as it stays broken (review major 2). Keys carry the path, so a second
 * broken file in another directory still warns once.
 */
const warnedOnce = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  console.warn(message);
}

/** Operator-facing wording of the two layers' fallbacks (warnings only). */
interface LayerNotes {
  /** Closes a file-level warning, after the reason. */
  fileFallback: string;
  /** Closes a per-field warning, after the field name. */
  fieldFallback: string;
}

const GLOBAL_NOTES: LayerNotes = {
  fileFallback: "using defaults",
  fieldFallback: "keeping the default",
};

const LOCAL_NOTES: LayerNotes = {
  fileFallback: "ignoring the project layer",
  fieldFallback: "inheriting the lower layer",
};

/** A fresh independent copy of the defaults or of a validated document. */
function snapshot(config: FusionConfig): Readonly<FusionConfig> {
  return Object.freeze({
    workers: config.workers,
    maxParallel: config.maxParallel,
    taskTimeoutMs: config.taskTimeoutMs,
    modelCooldownMs: config.modelCooldownMs,
    workerModels: frozenList(config.workerModels),
    maxSteps: config.maxSteps,
    requireApproval: config.requireApproval,
    blockedTools: frozenList(config.blockedTools),
    leadBlockedTools: frozenList(config.leadBlockedTools),
    researcherWeb: config.researcherWeb,
  });
}

/**
 * Keeps only the keys that were present and valid. Absence stays absence:
 * that is what lets a layer inherit from the one below it.
 */
function presentOnly(fields: Partial<Record<keyof FusionConfig, unknown>>): Partial<FusionConfig> {
  const present: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) present[key] = value;
  }
  return present as Partial<FusionConfig>;
}

/** Validates one layer's document; returns only the fields it actually sets validly. */
function readFields(
  fields: Record<string, unknown>,
  path: string,
  notes: LayerNotes,
): Partial<FusionConfig> {
  const warnField = (key: string): void => {
    warnOnce(
      `${path}\u0000${key}`,
      `[pi-fusion] ${path}: field "${key}" has an invalid value, ${notes.fieldFallback}`,
    );
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
  ): number | undefined => {
    const value = fields[key];
    if (value === undefined) return undefined;
    if (!isIntInRange(value, bound.min, bound.max)) {
      warnField(key);
      return undefined;
    }
    return value;
  };
  const flag = (key: keyof FusionConfig): boolean | undefined => {
    const value = fields[key];
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") {
      warnField(key);
      return undefined;
    }
    return value;
  };
  const list = (key: keyof FusionConfig): string[] | undefined => {
    const value = fields[key];
    if (value === undefined) return undefined;
    if (!isStringList(value)) {
      warnField(key);
      return undefined;
    }
    return [...value];
  };
  const mode = (key: keyof FusionConfig): ResearcherWebMode | undefined => {
    const value = fields[key];
    if (value === undefined) return undefined;
    if (!isResearcherWebMode(value)) {
      warnField(key);
      return undefined;
    }
    return value;
  };
  return presentOnly({
    workers: number("workers", FUSION_CONFIG_BOUNDS.workers),
    maxParallel: number("maxParallel", FUSION_CONFIG_BOUNDS.maxParallel),
    taskTimeoutMs: number("taskTimeoutMs", FUSION_CONFIG_BOUNDS.taskTimeoutMs),
    modelCooldownMs: number("modelCooldownMs", FUSION_CONFIG_BOUNDS.modelCooldownMs),
    workerModels: list("workerModels"),
    maxSteps: number("maxSteps", FUSION_CONFIG_BOUNDS.maxSteps),
    requireApproval: flag("requireApproval"),
    blockedTools: list("blockedTools"),
    leadBlockedTools: list("leadBlockedTools"),
    researcherWeb: mode("researcherWeb"),
  });
}

/** A raw JSON document read from disk, before any field validation. */
type DocumentRead =
  | { status: "missing" }
  | { status: "invalid"; reason: string }
  | { status: "ok"; doc: Record<string, unknown> };

/** Reads and parses one file; only a non-existent file counts as `missing`. */
function readDocument(path: string): DocumentRead {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "invalid", reason: `is unreadable (${errorText(error)})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { status: "invalid", reason: `is not valid JSON (${errorText(error)})` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: "invalid", reason: "is not a JSON object" };
  }
  return { status: "ok", doc: parsed as Record<string, unknown> };
}

/**
 * The one presence-aware parser, applied to each layer. A missing file is an
 * empty layer, silently; a broken file is an empty layer with one warning.
 */
function readLayer(path: string, notes: LayerNotes): Partial<FusionConfig> {
  const document = readDocument(path);
  if (document.status === "missing") return {};
  if (document.status === "invalid") {
    warnOnce(path, `[pi-fusion] ${path} ${document.reason}; ${notes.fileFallback}`);
    return {};
  }
  return readFields(document.doc, path, notes);
}

/**
 * Reads the global settings file; every field is taken only when it has the
 * right type and sits inside its bounds. Each call returns a new frozen
 * snapshot, so callers cannot change the defaults or each other's view.
 */
export function loadFusionConfig(path: string = defaultFusionConfigPath()): Readonly<FusionConfig> {
  return snapshot({ ...FUSION_CONFIG_DEFAULTS, ...readLayer(path, GLOBAL_NOTES) });
}

/**
 * The effective configuration: defaults, then valid global fields, then valid
 * project overrides, each field resolved independently. `origins` names the
 * layer that supplied every value. Read fresh on every call.
 */
export function loadEffectiveConfig(
  globalPath: string,
  projectDir: string,
): { config: Readonly<FusionConfig>; origins: FieldOrigins } {
  const global = readLayer(globalPath, GLOBAL_NOTES);
  const local = readLayer(projectFusionConfigPath(projectDir), LOCAL_NOTES);
  const origins = {} as FieldOrigins;
  for (const key of Object.keys(FUSION_CONFIG_DEFAULTS) as (keyof FusionConfig)[]) {
    origins[key] = Object.hasOwn(local, key)
      ? "local"
      : Object.hasOwn(global, key)
        ? "global"
        : "default";
  }
  const merged: FusionConfig = { ...FUSION_CONFIG_DEFAULTS, ...global, ...local };
  return { config: snapshot(merged), origins: Object.freeze(origins) };
}

/** Writes a JSON document atomically: tmp file, then rename onto the target. */
function writeJsonAtomic(path: string, document: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * Raw document of the project file for a write: `null` when the file is
 * absent, and a refusal (never a silent overwrite) when it is broken.
 */
function readProjectDocumentForWrite(path: string): Record<string, unknown> | null {
  const document = readDocument(path);
  if (document.status === "missing") return null;
  if (document.status === "invalid") {
    throw new Error(
      `cannot write project config ${path}: the file ${document.reason}; fix or remove it first (nothing was changed)`,
    );
  }
  return document.doc;
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
  writeJsonAtomic(path, {
    workers: config.workers,
    maxParallel: config.maxParallel,
    taskTimeoutMs: config.taskTimeoutMs,
    modelCooldownMs: config.modelCooldownMs,
    workerModels: [...config.workerModels],
    maxSteps: config.maxSteps,
    requireApproval: config.requireApproval,
    blockedTools: [...config.blockedTools],
    leadBlockedTools: [...config.leadBlockedTools],
    researcherWeb: config.researcherWeb,
  });
}

/**
 * Merges the delta into the project file's raw JSON: only the delta keys are
 * touched, unknown keys stay as they are, and a missing file is created with
 * just the delta. An `undefined` delta value is skipped. A broken project file
 * is refused, not overwritten.
 */
export function persistProjectFusionDelta(delta: Partial<FusionConfig>, projectDir: string): void {
  const path = projectFusionConfigPath(projectDir);
  const document = readProjectDocumentForWrite(path) ?? {};
  for (const [key, value] of Object.entries(delta)) {
    if (value !== undefined) document[key] = value;
  }
  writeJsonAtomic(path, document);
}

/**
 * Removes one key from the project file's raw JSON. When no keys are left the
 * file is deleted: an empty `{}` is never persisted. An absent file or key is
 * a no-op; a broken project file is refused.
 */
export function clearProjectFusionOverride(key: keyof FusionConfig, projectDir: string): void {
  const path = projectFusionConfigPath(projectDir);
  const document = readProjectDocumentForWrite(path);
  if (document === null || !Object.hasOwn(document, key)) return;
  delete document[key];
  if (Object.keys(document).length === 0) {
    rmSync(path, { force: true });
    return;
  }
  writeJsonAtomic(path, document);
}
