import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("uses the design defaults when fusion.json is absent", () => {
    const config = readFusionConfig(join(dir, "missing.json"));
    expect(config).toEqual({
      enabled: false,
      workers: 3,
      maxParallel: 3,
      taskTimeoutMs: 600_000,
      workerModels: [],
      maxSteps: 60,
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
        workerModels: ["model-a", "model-b"],
        maxSteps: 25,
      }),
    );
    expect(readFusionConfig(path)).toEqual({
      enabled: true,
      workers: 5,
      maxParallel: 4,
      taskTimeoutMs: 120_000,
      workerModels: ["model-a", "model-b"],
      maxSteps: 25,
    });
  });

  it("keeps the default for each field that is missing or ill-typed", () => {
    const path = write(JSON.stringify({ workers: "many", maxSteps: 0, workerModels: [""] }));
    expect(readFusionConfig(path)).toEqual(FUSION_CONFIG_DEFAULTS);
  });

  it("falls back to the defaults when the file is not valid JSON", () => {
    expect(readFusionConfig(write("{ not json"))).toEqual(FUSION_CONFIG_DEFAULTS);
  });

  it("returns a frozen snapshot that does not share state with the defaults", () => {
    const config = readFusionConfig(join(dir, "missing.json"));
    expect(Object.isFrozen(config)).toBe(true);
    config.workerModels.push("leaked");
    expect(readFusionConfig(join(dir, "missing.json")).workerModels).toEqual([]);
    expect(FUSION_CONFIG_DEFAULTS.workerModels).toEqual([]);
  });
});
