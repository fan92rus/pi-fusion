/**
 * FR-006 — the structural worker report: the schema that travels to the
 * host and the validator that names violated fields for the retry (FR-007).
 *
 * The critical split (design §Report retry, M10-R3): the rule "question is
 * required when needs_orchestrator" must live IN the schema (if/then) so the
 * HOST refuses the report as structured_output_failed — that is the only
 * trigger of the schema retry. But TypeBox 0.34 Value.Check IGNORES if/then
 * (pinned below: the precedent threw ValueCheckUnknownTypeError on raw
 * {if,then} compositions), so validate.ts re-encodes the same rules as
 * explicit branches — they must never disagree with the host.
 */
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { type WorkerReport, WorkerReportSchema } from "../extensions/pi-fusion/report/schema.ts";
import { violatedFields } from "../extensions/pi-fusion/report/validate.ts";

/**
 * The if/then keywords are opaque to typebox's static types — one typed view.
 * Presence is guaranteed by schema.ts and asserted by the first test below.
 */
const rule = WorkerReportSchema as unknown as {
  if: { properties?: { status?: { const?: string } } } & TSchema;
  then: { required?: string[] } & TSchema;
};

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "done",
    summary: "wrote the thing",
    filesChanged: ["src/a.ts"],
    evidence: ["npm test passed"],
    residualRisks: [],
    ...overrides,
  };
}

describe("WorkerReportSchema (FR-006)", () => {
  it("carries the needs_orchestrator rule to the host as if/then", () => {
    const serialized = JSON.stringify(WorkerReportSchema);
    expect(serialized).toContain('"if"');
    expect(serialized).toContain('"then"');
    // The if-branch must match a FULL report (no additionalProperties:false —
    // otherwise it never fires and the host silently accepts a questionless
    // needs_orchestrator), and the then-branch must demand `question`.
    expect(rule.if?.properties?.status?.const).toBe("needs_orchestrator");
    expect(rule.then?.required).toContain("question");
  });

  it("host enforcement: needs_orchestrator without question fails the then-branch", () => {
    const asks = report({ status: "needs_orchestrator" });
    expect(Value.Check(rule.if, asks)).toBe(true);
    expect(Value.Check(rule.then, asks)).toBe(false);
    const asksWithQuestion = report({ status: "needs_orchestrator", question: "which API?" });
    expect(Value.Check(rule.if, asksWithQuestion)).toBe(true);
    expect(Value.Check(rule.then, asksWithQuestion)).toBe(true);
    // Other statuses never trigger the rule.
    const done = report();
    expect(Value.Check(rule.if, done)).toBe(false);
  });

  it("TypeBox 0.34 Value.Check ignores if/then — the validator re-encodes the rule", () => {
    // The exact hole the host-side if/then does not cover locally: a bare
    // Value.Check accepts a questionless needs_orchestrator. Pinned so a
    // typebox upgrade that starts honoring if/then cannot silently flip the
    // contract validate.ts relies on.
    expect(Value.Check(WorkerReportSchema, report({ status: "needs_orchestrator" }))).toBe(true);
    expect(Value.Check(WorkerReportSchema, report())).toBe(true);
  });

  it("types a full report, including the optionals", () => {
    const full: WorkerReport = {
      status: "needs_orchestrator",
      summary: "blocked",
      filesChanged: [],
      evidence: ["seam said x"],
      residualRisks: ["y"],
      replacedExistingFiles: ["src/b.ts"],
      question: "proceed?",
    };
    expect(full.status).toBe("needs_orchestrator");
  });
});

describe("violatedFields (FR-007 names the broken fields)", () => {
  it("accepts valid reports of every status", () => {
    expect(violatedFields(report())).toEqual([]);
    expect(violatedFields(report({ status: "no_changes", filesChanged: [] }))).toEqual([]);
    expect(violatedFields(report({ status: "failed" }))).toEqual([]);
    expect(
      violatedFields(report({ status: "needs_orchestrator", question: "which API?" })),
    ).toEqual([]);
    // `question` stays optional outside needs_orchestrator; empty arrays fine.
    expect(violatedFields(report({ question: "" }))).toEqual([]);
  });

  it("names `question` when needs_orchestrator omits it", () => {
    expect(violatedFields(report({ status: "needs_orchestrator" }))).toEqual(["question"]);
  });

  it("names `filesChanged` when no_changes declares changes", () => {
    expect(violatedFields(report({ status: "no_changes", filesChanged: ["src/a.ts"] }))).toEqual([
      "filesChanged",
    ]);
  });

  it("names every shape-violating field, deduplicated and sorted", () => {
    // Literal object: `summary` is missing entirely (the helper always sets it).
    expect(violatedFields({ status: "shipped", filesChanged: "src/a.ts", extra: 1 })).toEqual([
      "evidence",
      "extra",
      "filesChanged",
      "residualRisks",
      "status",
      "summary",
    ]);
    expect(violatedFields(report({ status: "needs_orchestrator", filesChanged: "nope" }))).toEqual([
      "filesChanged",
      "question",
    ]);
  });

  it("flags replacedExistingFiles when it is not a string array", () => {
    expect(violatedFields(report({ replacedExistingFiles: "src/a.ts" }))).toEqual([
      "replacedExistingFiles",
    ]);
    expect(violatedFields(report({ replacedExistingFiles: ["src/a.ts", 3] }))).toEqual([
      "replacedExistingFiles",
    ]);
  });

  it("names all required fields when the report is not an object at all", () => {
    expect(violatedFields(null)).toEqual([
      "evidence",
      "filesChanged",
      "residualRisks",
      "status",
      "summary",
    ]);
    expect(violatedFields("done")).toEqual([
      "evidence",
      "filesChanged",
      "residualRisks",
      "status",
      "summary",
    ]);
  });
});

describe("violatedFields by role (design §4.8)", () => {
  const envelope = {
    status: "done",
    summary: "s",
    filesChanged: [],
    evidence: [],
    residualRisks: [],
  };

  it("scout requires sources", () => {
    expect(violatedFields(envelope, "scout")).toEqual(["sources"]);
    expect(violatedFields({ ...envelope, sources: [] }, "scout")).toEqual([]);
  });

  it("researcher requires sources and unknowns", () => {
    expect(violatedFields(envelope, "researcher")).toEqual(["sources", "unknowns"]);
    expect(violatedFields({ ...envelope, sources: [], unknowns: [] }, "researcher")).toEqual([]);
  });

  it("reviewer requires findings, checksRun and the pass|fail verdict", () => {
    expect(violatedFields(envelope, "reviewer")).toEqual(["checksRun", "findings", "verdict"]);
    expect(
      violatedFields({ ...envelope, findings: [], checksRun: [], verdict: "pass" }, "reviewer"),
    ).toEqual([]);
    expect(
      violatedFields({ ...envelope, findings: [], checksRun: [], verdict: "ok" }, "reviewer"),
    ).toContain("verdict");
  });

  it("role-specific fields are unknown to the worker schema (strict envelope)", () => {
    expect(violatedFields({ ...envelope, sources: [] }, "worker")).toContain("sources");
  });

  it("envelope rules hold for every role (question / no_changes)", () => {
    const noQuestion = { ...envelope, status: "needs_orchestrator" };
    for (const role of ["worker", "scout", "researcher", "reviewer"] as const) {
      expect(violatedFields(noQuestion, role)).toContain("question");
    }
    const lying = { ...envelope, status: "no_changes", filesChanged: ["a.ts"] };
    for (const role of ["worker", "scout", "researcher", "reviewer"] as const) {
      expect(violatedFields(lying, role)).toContain("filesChanged");
    }
  });
});
