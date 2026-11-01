import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { FusionContractSchema } from "../extensions/pi-fusion/contract/schema.ts";
import {
  ClampRowSchema,
  DelegateContractSchema,
  FanoutResultSchema,
  FusionTaskSchema,
  MAX_CONTRACT_CHECKS,
  MAX_CONTRACT_INPUTS,
  MAX_CONTRACT_PROVIDES,
  MAX_DELEGATE_TASKS,
  MAX_INSTRUCTIONS_CHARS,
  MAX_TASK_FILES,
  MAX_TASK_ID_CHARS,
  ProgressSnapshotSchema,
  TaskResultSchema,
  UsageTotalsSchema,
  WorkerReportSchema,
} from "../extensions/pi-fusion/types.ts";

function task(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "t1", instructions: "do the thing", ...overrides };
}

function args(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { tasks: [task()], ...overrides };
}

function nTasks(n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => task({ id: `t${i}` }));
}

const report = {
  status: "done",
  summary: "wrote the thing",
  filesChanged: ["src/a.ts"],
  evidence: ["npm test passed"],
  residualRisks: [],
};

describe("FusionTaskSchema", () => {
  it("accepts the minimal form and the full form", () => {
    expect(Value.Check(FusionTaskSchema, task())).toBe(true);
    expect(
      Value.Check(FusionTaskSchema, {
        id: "ship-hud",
        instructions: "draw the hud",
        title: "Ship HUD",
        deliverable: "a working hud",
        files: ["js/hud.js"],
        maxSteps: 40,
        timeoutMs: 120000,
        etaSeconds: 90,
      }),
    ).toBe(true);
  });

  it("accepts and ignores etaSeconds without an upper bound", () => {
    expect(Value.Check(FusionTaskSchema, task({ etaSeconds: 999_999 }))).toBe(true);
  });

  it("id: 200 chars valid, 201 rejected, empty rejected", () => {
    expect(Value.Check(FusionTaskSchema, task({ id: "a".repeat(MAX_TASK_ID_CHARS) }))).toBe(true);
    expect(Value.Check(FusionTaskSchema, task({ id: "a".repeat(MAX_TASK_ID_CHARS + 1) }))).toBe(
      false,
    );
    expect(Value.Check(FusionTaskSchema, task({ id: "" }))).toBe(false);
  });

  it("id rejects CR and LF anywhere in the value", () => {
    expect(Value.Check(FusionTaskSchema, task({ id: "a\nb" }))).toBe(false);
    expect(Value.Check(FusionTaskSchema, task({ id: "a\rb" }))).toBe(false);
    expect(
      Value.Check(FusionTaskSchema, task({ id: `${"a".repeat(MAX_TASK_ID_CHARS - 1)}\n` })),
    ).toBe(false);
  });

  it("instructions: 32000 chars valid, 32001 rejected, empty rejected", () => {
    expect(
      Value.Check(FusionTaskSchema, task({ instructions: "a".repeat(MAX_INSTRUCTIONS_CHARS) })),
    ).toBe(true);
    expect(
      Value.Check(FusionTaskSchema, task({ instructions: "a".repeat(MAX_INSTRUCTIONS_CHARS + 1) })),
    ).toBe(false);
    expect(Value.Check(FusionTaskSchema, task({ instructions: "" }))).toBe(false);
  });

  it("files: 32 entries valid, 33 rejected, entries must be non-empty strings", () => {
    const many = Array.from({ length: MAX_TASK_FILES }, (_, i) => `f${i}.ts`);
    expect(Value.Check(FusionTaskSchema, task({ files: many }))).toBe(true);
    expect(Value.Check(FusionTaskSchema, task({ files: [...many, "one-too-many.ts"] }))).toBe(
      false,
    );
    expect(Value.Check(FusionTaskSchema, task({ files: [] }))).toBe(true);
    expect(Value.Check(FusionTaskSchema, task({ files: ["ok.ts", ""] }))).toBe(false);
  });

  it("rejects unknown fields (additionalProperties: false)", () => {
    expect(Value.Check(FusionTaskSchema, task({ surprise: true }))).toBe(false);
    expect(Value.Check(FusionTaskSchema, task({ model: "haiku" }))).toBe(false);
  });

  it("budgets must be positive numbers", () => {
    expect(Value.Check(FusionTaskSchema, task({ maxSteps: 1 }))).toBe(true);
    expect(Value.Check(FusionTaskSchema, task({ maxSteps: 0 }))).toBe(false);
    expect(Value.Check(FusionTaskSchema, task({ timeoutMs: -1 }))).toBe(false);
  });
});

describe("FusionContractSchema (fusion_delegate tool args)", () => {
  it("tasks: 1..16 — 16 tasks valid, 17 rejected, 0 rejected", () => {
    expect(Value.Check(FusionContractSchema, { tasks: nTasks(MAX_DELEGATE_TASKS) })).toBe(true);
    expect(Value.Check(FusionContractSchema, { tasks: nTasks(MAX_DELEGATE_TASKS + 1) })).toBe(
      false,
    );
    expect(Value.Check(FusionContractSchema, { tasks: [] })).toBe(false);
  });

  it("maxWorkers: absent ok, >=1 ok, below 1 and fractional rejected", () => {
    expect(Value.Check(FusionContractSchema, args())).toBe(true);
    expect(Value.Check(FusionContractSchema, args({ maxWorkers: 1 }))).toBe(true);
    expect(Value.Check(FusionContractSchema, args({ maxWorkers: 0 }))).toBe(false);
    expect(Value.Check(FusionContractSchema, args({ maxWorkers: 1.5 }))).toBe(false);
  });

  it("contract must be an object when present", () => {
    expect(Value.Check(FusionContractSchema, args({ contract: {} }))).toBe(true);
    expect(Value.Check(FusionContractSchema, args({ contract: "not an object" }))).toBe(false);
    expect(Value.Check(FusionContractSchema, args({ contract: [] }))).toBe(false);
  });

  it("rejects unknown top-level fields", () => {
    expect(Value.Check(FusionContractSchema, args({ notes: "extra" }))).toBe(false);
  });
});

describe("DelegateContractSchema", () => {
  it("inputs: at most 32 non-empty paths", () => {
    const paths = Array.from({ length: MAX_CONTRACT_INPUTS }, (_, i) => `in${i}.ts`);
    expect(Value.Check(DelegateContractSchema, { inputs: paths })).toBe(true);
    expect(Value.Check(DelegateContractSchema, { inputs: [...paths, "over.ts"] })).toBe(false);
    expect(Value.Check(DelegateContractSchema, { inputs: [""] })).toBe(false);
  });

  it("provides: at most 64 entries with a closed kind enum", () => {
    const provide = { task: "t1", kind: "symbol", name: "HD.Ship" };
    const many = Array.from({ length: MAX_CONTRACT_PROVIDES }, () => provide);
    expect(Value.Check(DelegateContractSchema, { provides: many })).toBe(true);
    expect(Value.Check(DelegateContractSchema, { provides: [...many, provide] })).toBe(false);
    expect(
      Value.Check(DelegateContractSchema, {
        provides: [{ task: "t1", kind: "widget", name: "x" }],
      }),
    ).toBe(false);
    expect(
      Value.Check(DelegateContractSchema, {
        provides: [
          { task: "t1", kind: "file", name: "js/hud.js", in: "js/hud.js", shape: "class" },
        ],
      }),
    ).toBe(true);
  });

  it("requires entries need a non-empty task and name", () => {
    expect(
      Value.Check(DelegateContractSchema, { requires: [{ task: "t1", name: "HD.Ship" }] }),
    ).toBe(true);
    expect(Value.Check(DelegateContractSchema, { requires: [{ task: "", name: "HD.Ship" }] })).toBe(
      false,
    );
    expect(Value.Check(DelegateContractSchema, { requires: [{ task: "t1", name: "" }] })).toBe(
      false,
    );
  });

  it("checks: at most 16 open verify.run specs with optional task", () => {
    const spec = { task: "t1", cmd: "npm test" };
    const many = Array.from({ length: MAX_CONTRACT_CHECKS }, () => spec);
    expect(Value.Check(DelegateContractSchema, { checks: many })).toBe(true);
    expect(Value.Check(DelegateContractSchema, { checks: [...many, spec] })).toBe(false);
    expect(Value.Check(DelegateContractSchema, { checks: [{ cmd: "npm test" }] })).toBe(true);
    expect(Value.Check(DelegateContractSchema, { checks: [{ task: 7, cmd: "npm test" }] })).toBe(
      false,
    );
  });
});

describe("WorkerReportSchema", () => {
  it("accepts done without a question", () => {
    expect(Value.Check(WorkerReportSchema, report)).toBe(true);
  });

  it("demands question when status is needs_orchestrator", () => {
    const asking = { ...report, status: "needs_orchestrator" };
    expect(Value.Check(WorkerReportSchema, asking)).toBe(false);
    expect(Value.Check(WorkerReportSchema, { ...asking, question: "which branch?" })).toBe(true);
  });

  it("status is closed to the four worker statuses", () => {
    expect(Value.Check(WorkerReportSchema, { ...report, status: "ok" })).toBe(false);
    expect(Value.Check(WorkerReportSchema, { ...report, status: "cancelled" })).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(Value.Check(WorkerReportSchema, { ...report, extra: 1 })).toBe(false);
  });
});

describe("runtime result forms", () => {
  it("TaskResult: seam statuses incl cancelled; attempts >= 0; strict", () => {
    const result = {
      id: "t1",
      status: "cancelled",
      summary: "disposed",
      filesChanged: [],
      evidence: [],
      residualRisks: [],
      attempts: 0,
    };
    expect(Value.Check(TaskResultSchema, result)).toBe(true);
    expect(
      Value.Check(TaskResultSchema, { ...result, status: "needs_orchestrator", question: "q" }),
    ).toBe(true);
    expect(Value.Check(TaskResultSchema, { ...result, attempts: -1 })).toBe(false);
    expect(Value.Check(TaskResultSchema, { ...result, status: "done", extra: 1 })).toBe(false);
  });

  it("UsageTotals: every field optional, unknown rejected", () => {
    expect(Value.Check(UsageTotalsSchema, {})).toBe(true);
    expect(
      Value.Check(UsageTotalsSchema, {
        input: 10,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.5,
        turns: 4,
        toolCalls: 9,
        durationMs: 1200,
      }),
    ).toBe(true);
    expect(Value.Check(UsageTotalsSchema, { tokens: 30 })).toBe(false);
  });

  it("ProgressSnapshot: all five cumulative fields required", () => {
    const snapshot = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, turns: 5 };
    expect(Value.Check(ProgressSnapshotSchema, snapshot)).toBe(true);
    expect(Value.Check(ProgressSnapshotSchema, { ...snapshot, turns: undefined })).toBe(false);
    expect(Value.Check(ProgressSnapshotSchema, { input: 1, output: 2 })).toBe(false);
  });

  it("ClampRow: closed field enum; FanoutResult requires usage and usagePartial", () => {
    const row = { field: "perModel", requested: 9, applied: 4, reason: "capacity" };
    expect(Value.Check(ClampRowSchema, row)).toBe(true);
    expect(Value.Check(ClampRowSchema, { ...row, field: "maxWorkers" })).toBe(false);
    const result = { results: [], clamps: [row], usage: {}, usagePartial: true };
    expect(Value.Check(FanoutResultSchema, result)).toBe(true);
    expect(Value.Check(FanoutResultSchema, { ...result, usagePartial: "yes" })).toBe(false);
    expect(Value.Check(FanoutResultSchema, { results: [], clamps: [] })).toBe(false);
  });
});

describe("FusionTaskSchema.role (design §4.1)", () => {
  it("accepts each exact role literal and a task without role", () => {
    for (const role of ["worker", "scout", "researcher", "reviewer"]) {
      expect(Value.Check(FusionTaskSchema, task({ role }))).toBe(true);
    }
    expect(Value.Check(FusionTaskSchema, task())).toBe(true);
  });

  it("rejects unknown or mistyped roles (case-sensitive literals)", () => {
    for (const role of ["lead", "Worker", "SCOUT", 42, null]) {
      expect(Value.Check(FusionTaskSchema, task({ role }))).toBe(false);
    }
  });

  it("TaskResultSchema carries the optional role fields, nothing required", () => {
    expect(
      Value.Check(TaskResultSchema, {
        id: "t1",
        status: "done",
        summary: "s",
        filesChanged: [],
        evidence: [],
        residualRisks: [],
        attempts: 1,
        sources: ["src/a.ts:12"],
        unknowns: ["network"],
        findings: ["pin drift"],
        checksRun: ["npm test"],
        verdict: "fail",
      }),
    ).toBe(true);
  });
});
