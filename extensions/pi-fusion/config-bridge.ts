/**
 * Read-only fusion configuration (design rev.5.2 §4 `config-bridge.ts`, §5
 * integration table, §13 feature flag). The effective settings are read fresh
 * on every call: the global `~/.pi/agent/fusion.json` with the project's
 * `.pi/fusion.json` overriding it per field (openspec fusion-project-config,
 * design D7). A missing file, an invalid JSON document or an ill-typed field
 * falls back to the defaults for that scope, so the extension never fails to
 * load over its own settings.
 *
 * Activation is NOT part of this snapshot: it is per session (session-state.ts),
 * and the retired `enabled` field in fusion.json is ignored (config.ts warns).
 * The read itself is config.ts `loadEffectiveConfig`; this module keeps only the
 * six fields the fan-out and the guidance need, so the bridge tests and the
 * production read cannot drift apart. It carries no origins (design D7).
 */

import { defaultFusionConfigPath, loadEffectiveConfig } from "./config.ts";
import type { FanoutConfig } from "./pool/fanout.ts";
import type { ResearcherWebMode } from "./types.ts";

export { defaultFusionConfigPath } from "./config.ts";

export interface FusionConfig extends FanoutConfig {
  /**
   * The researcher's web-tool composition (design §4.9.3): the seam picks
   * the researcher profile variant by it. Default `none`.
   */
  researcherWeb: ResearcherWebMode;
}

/** Design defaults: workers 3, maxParallel 3, taskTimeoutMs 600000, maxSteps 60, no models. */
export const FUSION_CONFIG_DEFAULTS: Readonly<FusionConfig> = Object.freeze({
  workers: 3,
  maxParallel: 3,
  taskTimeoutMs: 600_000,
  workerModels: [],
  maxSteps: 60,
  researcherWeb: "none",
});

/**
 * Reads the effective settings once per call; every field comes from the
 * project file when it is valid there, else from the global file, else the
 * defaults. `projectDir` defaults to `process.cwd()` at call time, as the
 * production extension does. Each call returns a new frozen snapshot, so
 * callers cannot change the defaults or each other's view.
 */
export function readFusionConfig(
  path: string = defaultFusionConfigPath(),
  projectDir: string = process.cwd(),
): Readonly<FusionConfig> {
  const { config } = loadEffectiveConfig(path, projectDir);
  return Object.freeze({
    workers: config.workers,
    maxParallel: config.maxParallel,
    taskTimeoutMs: config.taskTimeoutMs,
    workerModels: [...config.workerModels],
    maxSteps: config.maxSteps,
    researcherWeb: config.researcherWeb,
  });
}
