import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FUSION_CONFIG_DEFAULTS, readFusionConfig } from "../extensions/pi-fusion/config-bridge.ts";

describe("config-bridge readFusionConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fusion-config-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (content: string): string => {
    const path = join(dir, "fusion.json");
    writeFileSync(path, content, "utf8");
    return path;
  };

  // The global-layer tests always pass `dir` as projectDir: an omitted project
  // directory falls back to process.cwd(), which is the repo root under vitest,
  // and the repo's gitignored machine-local .pi/fusion.json would leak into
  // these otherwise global-only reads. `dir` is a fresh temp dir with no .pi/,
  // so it is the overlay-free project layer these tests need.

  it("uses the design defaults when fusion.json is absent", () => {
    const config = readFusionConfig(join(dir, "missing.json"), dir);
    expect(config).toEqual({
      workers: 3,
      maxParallel: 3,
      taskTimeoutMs: 600_000,
      modelCooldownMs: 300_000,
      workerModels: [],
      maxSteps: 60,
      researcherWeb: "none",
    });
    expect(config).toEqual(FUSION_CONFIG_DEFAULTS);
  });

  it("reads every field from fusion.json", () => {
    const path = write(
      JSON.stringify({
        enabled: true,
        workers: 5,
        maxParallel: 4,
        taskTimeoutMs: 120_000,
        modelCooldownMs: 45_000,
        workerModels: ["model-a", "model-b"],
        maxSteps: 25,
        researcherWeb: "both",
      }),
    );
    expect(readFusionConfig(path, dir)).toEqual({
      workers: 5,
      maxParallel: 4,
      taskTimeoutMs: 120_000,
      modelCooldownMs: 45_000,
      workerModels: ["model-a", "model-b"],
      maxSteps: 25,
      researcherWeb: "both",
    });
  });

  it("ignores a legacy enabled field: the shared snapshot has no activation key", () => {
    const config = readFusionConfig(write(JSON.stringify({ enabled: true, workers: 4 })), dir);
    expect(config).not.toHaveProperty("enabled");
    expect(config.workers).toBe(4);
    expect(FUSION_CONFIG_DEFAULTS).not.toHaveProperty("enabled");
  });

  it("keeps the default for each field that is missing or ill-typed", () => {
    const path = write(JSON.stringify({ workers: "many", maxSteps: 0, workerModels: [""] }));
    expect(readFusionConfig(path, dir)).toEqual(FUSION_CONFIG_DEFAULTS);
  });

  it("falls back to the defaults when the file is not valid JSON", () => {
    expect(readFusionConfig(write("{ not json"), dir)).toEqual(FUSION_CONFIG_DEFAULTS);
  });

  describe("the project layer (design D7: delegates to loadEffectiveConfig)", () => {
    let projectDir: string;

    beforeEach(() => {
      projectDir = mkdtempSync(join(tmpdir(), "fusion-project-"));
      mkdirSync(join(projectDir, ".pi"));
    });

    afterEach(() => {
      rmSync(projectDir, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    const writeProject = (content: string): void => {
      writeFileSync(join(projectDir, ".pi", "fusion.json"), content, "utf8");
    };

    it("a valid project field overrides the global one, the others stay global", () => {
      const globalPath = write(JSON.stringify({ workers: 5, workerModels: ["g/a"] }));
      writeProject(JSON.stringify({ workerModels: ["l/b"] }));
      const config = readFusionConfig(globalPath, projectDir);
      expect(config.workerModels).toEqual(["l/b"]);
      expect(config.workers).toBe(5);
    });

    it("a broken project file is ignored: the global values stand", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const globalPath = write(JSON.stringify({ workers: 5 }));
      writeProject("{ not json");
      expect(readFusionConfig(globalPath, projectDir).workers).toBe(5);
    });

    it("reads the project directory of process.cwd() at call time when none is given", () => {
      const globalPath = write(JSON.stringify({ workers: 5 }));
      writeProject(JSON.stringify({ workers: 7 }));
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(projectDir);
      expect(readFusionConfig(globalPath).workers).toBe(7);
      expect(cwd).toHaveBeenCalled();
    });

    it("keeps the bridge snapshot to its seven fields (no origins, no lead-gate lists)", () => {
      const config = readFusionConfig(join(dir, "missing.json"), projectDir);
      expect(Object.keys(config).sort()).toEqual(
        [
          "maxParallel",
          "maxSteps",
          "modelCooldownMs",
          "researcherWeb",
          "taskTimeoutMs",
          "workerModels",
          "workers",
        ].sort(),
      );
    });

    it("modelCooldownMs passes through the bridge, a project override included (design D5)", () => {
      const globalPath = write(JSON.stringify({ modelCooldownMs: 120_000 }));
      expect(readFusionConfig(globalPath, projectDir).modelCooldownMs).toBe(120_000);
      writeProject(JSON.stringify({ modelCooldownMs: 60_000 }));
      expect(readFusionConfig(globalPath, projectDir).modelCooldownMs).toBe(60_000);
    });

    it("modelCooldownMs keeps its default when no layer sets it", () => {
      const globalPath = write(JSON.stringify({ workers: 5 }));
      expect(readFusionConfig(globalPath, projectDir).modelCooldownMs).toBe(
        FUSION_CONFIG_DEFAULTS.modelCooldownMs,
      );
    });
  });

  it("returns a frozen snapshot that does not share state with the defaults", () => {
    const config = readFusionConfig(join(dir, "missing.json"), dir);
    expect(Object.isFrozen(config)).toBe(true);
    config.workerModels.push("leaked");
    expect(readFusionConfig(join(dir, "missing.json"), dir).workerModels).toEqual([]);
    expect(FUSION_CONFIG_DEFAULTS.workerModels).toEqual([]);
  });
});
