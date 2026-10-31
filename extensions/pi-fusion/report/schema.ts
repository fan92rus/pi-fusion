/**
 * TypeBox schema of the worker's terminal report — the self-declaration
 * the seam requests as structured output (design §4 WorkerReport, FR-006).
 *
 * The rule "question is required when needs_orchestrator" is encoded IN
 * this schema as JSON-Schema if/then, so the HOST's structured validation
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
import { type Static, Type } from "@sinclair/typebox";

/**
 * The worker report. Unknown fields are rejected (additionalProperties:
 * false), matching the strict forms of types.ts (TD-007(г), design §6/§14).
 */
export const WorkerReportSchema = Type.Object(
  {
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
  },
  {
    additionalProperties: false,
    // if-branch: status only, NO additionalProperties:false — it must match
    // a FULL report for then to fire.
    if: Type.Object({ status: Type.Literal("needs_orchestrator") }),
    // then-branch: forces `question` to be present (and a string).
    // biome-ignore lint/suspicious/noThenProperty: JSON-Schema if/then keyword, not a thenable
    then: Type.Object({ question: Type.String() }),
  },
);
export type WorkerReport = Static<typeof WorkerReportSchema>;
