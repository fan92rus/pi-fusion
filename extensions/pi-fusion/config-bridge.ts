/**
 * Read-only fusion configuration (design rev.5.2 §4 `config-bridge.ts`, §5
 * integration table, §13 feature flag). `~/.pi/agent/fusion.json` is read once
 * when the extension loads; a missing file, an invalid JSON document or an
 * ill-typed field falls back to the design defaults for that scope, so the
 * extension never fails to load over its own settings.
 *
 * `enabled` (default false) drives the feature flag in index.ts: while it is
 * false the tool is registered but removed from the active set.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FanoutConfig } from "./pool/fanout.ts";
import { RESEARCHER_WEB_MODES, type ResearcherWebMode } from "./types.ts";

export interface FusionConfig extends FanoutConfig {
  /** Feature flag (§13): the tool is declared to the model only when true. */
  enabled: boolean;
  /**
   * The researcher's web-tool composition (design §4.9.3): the seam picks
   * the researcher profile variant by it. Default `none`.
   */
  researcherWeb: ResearcherWebMode;
}

/** Design defaults: workers 3, maxParallel 3, taskTimeoutMs 600000, maxSteps 60, no models. */
export const FUSION_CONFIG_DEFAULTS: Readonly<FusionConfig> = Object.freeze({
  enabled: false,
  workers: 3,
  maxParallel: 3,
  taskTimeoutMs: 600_000,
  workerModels: [],
  maxSteps: 60,
  researcherWeb: "none",
});

/** The settings file the lead operator edits: `~/.pi/agent/fusion.json`. */
export function defaultFusionConfigPath(): string {
  return join(homedir(), ".pi", "agent", "fusion.json");
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isModelList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((model) => typeof model === "string" && model.trim().length > 0)
  );
}

/**
 * Reads the settings once; every field is taken only when it has the right
 * type. Each call returns a new frozen snapshot, so callers cannot change the
 * defaults or each other's view.
 */
export function readFusionConfig(path: string = defaultFusionConfigPath()): Readonly<FusionConfig> {
  let fields: Record<string, unknown> = {};
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      fields = raw as Record<string, unknown>;
    }
  } catch {
    // Missing or unreadable file, or invalid JSON: every field keeps its default.
  }
  const pick = <T>(value: unknown, accept: (v: unknown) => v is T, fallback: T): T =>
    accept(value) ? value : fallback;
  const isResearcherWebMode = (v: unknown): v is ResearcherWebMode =>
    typeof v === "string" && (RESEARCHER_WEB_MODES as readonly string[]).includes(v);
  const defaults = FUSION_CONFIG_DEFAULTS;
  return Object.freeze({
    enabled: pick(fields.enabled, (v): v is boolean => typeof v === "boolean", defaults.enabled),
    workers: pick(fields.workers, isPositiveInteger, defaults.workers),
    maxParallel: pick(fields.maxParallel, isPositiveInteger, defaults.maxParallel),
    taskTimeoutMs: pick(fields.taskTimeoutMs, isPositiveInteger, defaults.taskTimeoutMs),
    workerModels: pick(fields.workerModels, isModelList, []),
    maxSteps: pick(fields.maxSteps, isPositiveInteger, defaults.maxSteps),
    researcherWeb: pick(fields.researcherWeb, isResearcherWebMode, defaults.researcherWeb),
  });
}
