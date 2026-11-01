/**
 * §4 Core Interfaces — TypeBox forms of the fusion contract and the
 * runtime result types (design.md rev.5.2, spec 001).
 *
 * The wire forms the orchestrator (a frontier model writing free-form
 * JSON) produces are deliberately strict: unknown fields are REJECTED
 * and every resource-bounding cap is enforced here, in the form itself.
 * This deviates from atomic-agent, whose parser ignores unknown keys —
 * a documented deviation (TD-007(г), design §6/§14).
 *
 * The caps bound real resources, exactly as in the ported reference
 * (atomic-agent delegate-args.ts / contract.ts / contract-inputs.ts):
 * task count bounds how many turns one call can start, `instructions`
 * bounds the worker's prompt, `files` bounds the paths pasted into it,
 * and a ≤200-char id without CR/LF keeps the seam's requestId ≤256
 * (m1-R5/R6, M9-R3).
 */
import { type Static, Type } from "@sinclair/typebox";
import type { FusionContractSchema } from "./contract/schema.ts";

/** Fan-out width in tasks per call (FR-001, cap D-005). */
export const MAX_DELEGATE_TASKS = 16;
/** Task id ≤200 chars: the worst-case seam requestId stays ≤256 (R6). */
export const MAX_TASK_ID_CHARS = 200;
/** Ceiling on one brief; the worker also gets the operator's request. */
export const MAX_INSTRUCTIONS_CHARS = 32_000;
/** Paths a task may paste into its worker's brief. */
export const MAX_TASK_FILES = 32;
/** Operator-provided files any worker may edit in place, never replace. */
export const MAX_CONTRACT_INPUTS = 32;
/** Entries the contract's `provides` list may carry. */
export const MAX_CONTRACT_PROVIDES = 64;
/** Entries the contract's `checks` list may carry. */
export const MAX_CONTRACT_CHECKS = 16;

/**
 * The role of one delegated task (design §4.1): which agent profile runs it
 * and which report schema its child must answer with. Absent = `worker` —
 * the validator normalises before anything downstream sees the field.
 */
export const FUSION_ROLES = ["worker", "scout", "researcher", "reviewer"] as const;
export type FusionRole = (typeof FUSION_ROLES)[number];

/**
 * The researcher's web-tool composition (design §4.9.3): exactly one
 * researcher profile matches it, so no profile ever carries a list of
 * "optional" tool names. Default `none` — the only composition that can
 * never fail a launch because of the web.
 */
export const RESEARCHER_WEB_MODES = ["none", "web", "codex", "both"] as const;
export type ResearcherWebMode = (typeof RESEARCHER_WEB_MODES)[number];

/** What a `provides` entry can name (`file` uses `name` as the path). */
export const CONTRACT_PROVIDE_KINDS = [
  "symbol",
  "file",
  "id",
  "endpoint",
  "env",
  "flag",
  "other",
] as const;

const NonEmptyString = Type.String({ minLength: 1 });

/**
 * One unit of delegated work; becomes exactly one worker turn.
 * Unknown fields are rejected, not ignored. `etaSeconds` is accepted
 * and explicitly ignored in 001 (advisory estimate, nothing schedules
 * against it).
 */
export const FusionTaskSchema = Type.Object(
  {
    /** Orchestrator-chosen id, unique within the call; echoed in the output. */
    id: Type.String({
      minLength: 1,
      maxLength: MAX_TASK_ID_CHARS,
      // No CR/LF: the seam builds requestId/nodeId from it and the bridge
      // silently drops malformed ones (M9-R3).
      pattern: "^[^\\r\\n]+$",
    }),
    /** The task's brief; the worker sees this plus the operator's request. */
    instructions: Type.String({ minLength: 1, maxLength: MAX_INSTRUCTIONS_CHARS }),
    /** One-line label; defaults to humaniseTaskId(id) in the validator. */
    title: Type.Optional(NonEmptyString),
    /** What the worker should hand back (format, shape, acceptance). */
    deliverable: Type.Optional(NonEmptyString),
    /** Paths the worker should start from. */
    files: Type.Optional(Type.Array(NonEmptyString, { maxItems: MAX_TASK_FILES })),
    /** Step budget for THIS task; clamped at the runner, not refused here. */
    maxSteps: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    /** Wall-time budget for THIS task; clamped at the runner, not refused here. */
    timeoutMs: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    /** Advisory estimate in seconds; accepted and ignored in 001. */
    etaSeconds: Type.Optional(Type.Number()),
    /**
     * Which agent profile runs this task (design §4.1). Optional on the
     * wire; the validator always writes a concrete value downstream, and
     * an unknown literal is refused before any worker starts (FR-001).
     */
    role: Type.Optional(Type.Union(FUSION_ROLES.map((role) => Type.Literal(role)))),
  },
  { additionalProperties: false },
);
export type FusionTask = Static<typeof FusionTaskSchema>;

/** One `provides` entry: a named artifact a task must produce. */
export const ContractProvideSchema = Type.Object(
  {
    /** The task that must produce it. */
    task: NonEmptyString,
    kind: Type.Union(CONTRACT_PROVIDE_KINDS.map((kind) => Type.Literal(kind))),
    /** The literal name: `HD.Ship.reset`, `btn-launch`, `/api/score`. */
    name: NonEmptyString,
    /** Where it must appear; absent: any path the task owns or declares. */
    in: Type.Optional(NonEmptyString),
    /** What the thing IS, in one line; truncated later, never refused. */
    shape: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);
export type ContractProvide = Static<typeof ContractProvideSchema>;

/** One `requires` entry: a name a task relies on a `provides[]` for. */
export const ContractRequireSchema = Type.Object(
  { task: NonEmptyString, name: NonEmptyString },
  { additionalProperties: false },
);
export type ContractRequire = Static<typeof ContractRequireSchema>;

/**
 * One `verify.run` spec plus the task it is attributed to; the spec's
 * own keys pass through untouched. An empty spec is rejected by the
 * validator, not the form.
 */
export const ContractCheckSchema = Type.Intersect([
  Type.Object({ task: Type.Optional(NonEmptyString) }),
  Type.Record(Type.String(), Type.Unknown()),
]);
export type ContractCheck = Static<typeof ContractCheckSchema>;

/**
 * The contract between the parts of one fan-out: who owns which path,
 * who produces what, who relies on what, and which checks must pass.
 * Rendered whole into every worker's brief.
 */
export const DelegateContractSchema = Type.Object(
  {
    /** Operator's own files: every worker may edit in place, none replace. */
    inputs: Type.Optional(Type.Array(NonEmptyString, { maxItems: MAX_CONTRACT_INPUTS })),
    /** Path → task id; nobody else writes there. */
    owners: Type.Optional(Type.Record(Type.String(), NonEmptyString)),
    provides: Type.Optional(Type.Array(ContractProvideSchema, { maxItems: MAX_CONTRACT_PROVIDES })),
    requires: Type.Optional(Type.Array(ContractRequireSchema)),
    checks: Type.Optional(Type.Array(ContractCheckSchema, { maxItems: MAX_CONTRACT_CHECKS })),
  },
  { additionalProperties: false },
);
export type DelegateContract = Static<typeof DelegateContractSchema>;

/**
 * Self-declaration of a fresh worker — 4 statuses (`no_changes` is the
 * fresh-worker analogue of atomic's derived form, TD-007). The rule
 * "question is required when needs_orchestrator" is encoded IN the
 * schema (as a union split), so the host's structured validation — not
 * post-hoc parsing — refuses a report that asks for the orchestrator
 * without saying why (FR-006, M10-R3).
 */
export const WorkerReportSchema = Type.Union([
  Type.Object(
    {
      status: Type.Union([
        Type.Literal("done"),
        Type.Literal("no_changes"),
        Type.Literal("failed"),
      ]),
      question: Type.Optional(Type.String()),
      summary: Type.String(),
      filesChanged: Type.Array(Type.String()),
      evidence: Type.Array(Type.String()),
      residualRisks: Type.Array(Type.String()),
      replacedExistingFiles: Type.Optional(Type.Array(Type.String())),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      status: Type.Literal("needs_orchestrator"),
      question: Type.String(),
      summary: Type.String(),
      filesChanged: Type.Array(Type.String()),
      evidence: Type.Array(Type.String()),
      residualRisks: Type.Array(Type.String()),
      replacedExistingFiles: Type.Optional(Type.Array(Type.String())),
    },
    { additionalProperties: false },
  ),
]);
export type WorkerReport = Static<typeof WorkerReportSchema>;

/**
 * The runtime's view: a worker report widened by the seam states
 * (B7). `attempts` counts worker launches (0 = never dispatched —
 * empty rotation / drained); `turns`/`turnsObserved` absent = unknown,
 * never 0 (B4-R1).
 */
export const TaskResultSchema = Type.Object(
  {
    id: Type.String(),
    status: Type.Union([
      Type.Literal("done"),
      Type.Literal("no_changes"),
      Type.Literal("failed"),
      Type.Literal("needs_orchestrator"),
      Type.Literal("cancelled"),
    ]),
    summary: Type.String(),
    filesChanged: Type.Array(Type.String()),
    evidence: Type.Array(Type.String()),
    residualRisks: Type.Array(Type.String()),
    question: Type.Optional(Type.String()),
    /** Machine code: timeout | max_steps | schema-missing | acceptance-failed | seam-unavailable | no-available-model | host:<code> */
    error: Type.Optional(Type.String()),
    schemaMissing: Type.Optional(Type.Boolean()),
    attempts: Type.Integer({ minimum: 0 }),
    /** Σ terminal usage.turns across attempts; absent = unknown. */
    turns: Type.Optional(Type.Number()),
    /** Last :update snapshot of the final attempt; fallback for F19. */
    turnsObserved: Type.Optional(Type.Number()),
    /**
     * Role report fields (design §4.8), copied through when the report
     * carried them — scout `sources`, researcher `sources`+`unknowns`,
     * reviewer `findings`+`checksRun`+`verdict`. Absent = the role did
     * not report them; never fabricated for a worker row.
     */
    sources: Type.Optional(Type.Array(Type.String())),
    unknowns: Type.Optional(Type.Array(Type.String())),
    findings: Type.Optional(Type.Array(Type.String())),
    checksRun: Type.Optional(Type.Array(Type.String())),
    verdict: Type.Optional(Type.Union([Type.Literal("pass"), Type.Literal("fail")])),
  },
  { additionalProperties: false },
);
export type TaskResult = Static<typeof TaskResultSchema>;

/**
 * SubagentDelegationUsage of the seam, including durationMs (M7-R3).
 * Optional fields: the seam may not send usage at all; absence of data
 * is not zero (B4-R1).
 */
export const UsageTotalsSchema = Type.Object(
  {
    input: Type.Optional(Type.Number()),
    output: Type.Optional(Type.Number()),
    cacheRead: Type.Optional(Type.Number()),
    cacheWrite: Type.Optional(Type.Number()),
    cost: Type.Optional(Type.Number()),
    turns: Type.Optional(Type.Number()),
    toolCalls: Type.Optional(Type.Number()),
    durationMs: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);
export type UsageTotals = Static<typeof UsageTotalsSchema>;

/**
 * A cumulative :update snapshot of ONE attempt (SubagentDelegationUpdateUsage
 * — no cost, no toolCalls); a separate type on purpose (M7-R3).
 */
export const ProgressSnapshotSchema = Type.Object(
  {
    input: Type.Number(),
    output: Type.Number(),
    cacheRead: Type.Number(),
    cacheWrite: Type.Number(),
    turns: Type.Number(),
  },
  { additionalProperties: false },
);
export type ProgressSnapshot = Static<typeof ProgressSnapshotSchema>;

/** One clamp factor of the width chain; `noModels` = empty rotation (B-FINAL). */
export const ClampRowSchema = Type.Object(
  {
    field: Type.Union([
      Type.Literal("maxParallel"),
      Type.Literal("tasks"),
      Type.Literal("perModel"),
      Type.Literal("noModels"),
    ]),
    requested: Type.Integer(),
    applied: Type.Integer(),
    reason: Type.String(),
  },
  { additionalProperties: false },
);
export type ClampRow = Static<typeof ClampRowSchema>;

/** The fan-out result: per-task results, clamp chain, usage rollup. */
export const FanoutResultSchema = Type.Object(
  {
    results: Type.Array(TaskResultSchema),
    clamps: Type.Array(ClampRowSchema),
    usage: UsageTotalsSchema,
    /** True when at least one task has no terminal usage (FR-010). */
    usagePartial: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type FanoutResult = Static<typeof FanoutResultSchema>;

/**
 * The FusionContract form — the fusion_delegate tool arguments. The
 * schema itself lives in contract/schema.ts (design §4 file map: the
 * tool-args TypeBox schema belongs there); only the static form is
 * re-exported here, via an erased type-only import (no runtime cycle).
 */
export type FusionContract = Static<typeof FusionContractSchema>;
