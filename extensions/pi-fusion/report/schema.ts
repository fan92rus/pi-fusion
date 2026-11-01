/**
 * TypeBox schemas of the workers' terminal reports — the self-declaration
 * the seam requests as structured output (design §4 WorkerReport, FR-006;
 * role reports §4.8). The common envelope is shared by every role; the
 * role schemas add their own fields on top of it, never redefine it.
 *
 * The rule "question is required when needs_orchestrator" is encoded IN
 * the envelope as JSON-Schema if/then, so the HOST's structured validation
 * refuses a report that asks for the orchestrator without saying why and
 * answers `structured_output_failed` — the only trigger of the schema
 * retry (FR-007, M10-R3: outside the schema the rule would be unreachable,
 * completed-answers get no retry).
 *
 * CAVEAT (verified against typebox 0.34.52): Value.Check ignores if/then
 * keywords on an object schema (Kind stays "Object", they never dispatch).
 * Local validation therefore re-encodes the same rules as explicit branches
 * in report/validate.ts — violatedFields() — and must never disagree with
 * the host. test/report.test.ts pins both halves of that contract.
 */
import { type Static, type TObject, Type } from "@sinclair/typebox";
import type { FusionRole } from "../types.ts";

/**
 * The envelope fields every role reports (design §4.8). Defined once and
 * spread into each role schema: the envelope is reused, not duplicated —
 * TD-04 (a per-role schema without the shared envelope would duplicate the
 * if/then rule and break retry/mapping reuse).
 */
const REPORT_FIELDS = {
  /** done | no_changes | failed | needs_orchestrator (FR-006). */
  status: Type.Union([
    Type.Literal("done"),
    Type.Literal("no_changes"),
    Type.Literal("failed"),
    Type.Literal("needs_orchestrator"),
  ]),
  /** One-paragraph account of the outcome; lands in the result table. */
  summary: Type.String(),
  /** Paths the worker created or edited ([] when nothing changed). */
  filesChanged: Type.Array(Type.String()),
  /** Check outputs / observations backing the self-declaration. */
  evidence: Type.Array(Type.String()),
  /** What the lead should know could still bite. */
  residualRisks: Type.Array(Type.String()),
  /** Files that existed before and were replaced, not edited in place. */
  replacedExistingFiles: Type.Optional(Type.Array(Type.String())),
  /**
   * Optional everywhere, REQUIRED when status is needs_orchestrator:
   * encoded below as if/then for the host; re-checked by violatedFields.
   */
  question: Type.Optional(Type.String()),
} as const;

/**
 * The envelope's schema options — the strict form plus the if/then rule,
 * shared verbatim by every role schema. The if-branch matches a FULL report
 * (no additionalProperties:false) for then to fire.
 */
const REPORT_OPTIONS = {
  additionalProperties: false,
  // if-branch: status only, NO additionalProperties:false — it must match
  // a FULL report for then to fire.
  if: Type.Object({ status: Type.Literal("needs_orchestrator") }),
  // then-branch: forces `question` to be present (and a string).
  // biome-ignore lint/suspicious/noThenProperty: JSON-Schema if/then keyword, not a thenable
  then: Type.Object({ question: Type.String() }),
} as const;

/**
 * The worker report. Unknown fields are rejected (additionalProperties:
 * false), matching the strict forms of types.ts (TD-007(г), design §6/§14).
 */
export const WorkerReportSchema = Type.Object({ ...REPORT_FIELDS }, { ...REPORT_OPTIONS });
export type WorkerReport = Static<typeof WorkerReportSchema>;

/** Scout report: envelope + the code sources it read, each as `path:line`. */
export const ScoutReportSchema = Type.Object(
  { ...REPORT_FIELDS, sources: Type.Array(Type.String()) },
  { ...REPORT_OPTIONS },
);
export type ScoutReport = Static<typeof ScoutReportSchema>;

/**
 * Researcher report: envelope + sources (links/citations) + `unknowns` —
 * what could not be verified. Unverified claims are never dressed as
 * sources (FR-003): a composition without the web reports through
 * `unknowns`, not invented citations.
 */
export const ResearcherReportSchema = Type.Object(
  {
    ...REPORT_FIELDS,
    sources: Type.Array(Type.String()),
    unknowns: Type.Array(Type.String()),
  },
  { ...REPORT_OPTIONS },
);
export type ResearcherReport = Static<typeof ResearcherReportSchema>;

/**
 * Reviewer report: envelope + findings, the commands of its OWN check runs,
 * and the verdict. `checksRun` carries what the reviewer ran itself — a
 * worker's numbers without the reviewer's own run are not evidence (§4.4).
 */
export const ReviewerReportSchema = Type.Object(
  {
    ...REPORT_FIELDS,
    findings: Type.Array(Type.String()),
    checksRun: Type.Array(Type.String()),
    verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
  },
  { ...REPORT_OPTIONS },
);
export type ReviewerReport = Static<typeof ReviewerReportSchema>;

/** One wire report schema per role; the seam picks by the task's role. */
export const REPORT_SCHEMAS: Record<FusionRole, TObject> = {
  worker: WorkerReportSchema,
  scout: ScoutReportSchema,
  researcher: ResearcherReportSchema,
  reviewer: ReviewerReportSchema,
};

/** The wire schema a task of `role` must answer with (design §4.8). */
export function reportSchemaForRole(role: FusionRole): TObject {
  return REPORT_SCHEMAS[role];
}
