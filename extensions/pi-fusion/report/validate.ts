/**
 * Local validation of a worker report (FR-006/FR-007): violatedFields()
 * returns the NAMES of the fields that violate the ROLE's report schema
 * (design §4.4: worker/scout/researcher/reviewer, report/schema.ts), in a
 * stable sorted order, for the retry's corrective message
 * («Твой предыдущий отчёт нарушал схему: {fields}…», design §Report retry).
 *
 * TypeBox 0.34 Value.Check ignores if/then (see report/schema.ts), so the
 * two semantic rules are re-encoded here as explicit branches. They mirror
 * the host-side schema exactly and are envelope rules — they apply to
 * every role the same way:
 * - needs_orchestrator ⇒ `question` present (the schema's if/then);
 * - no_changes ⇒ `filesChanged` is [] (validate-only: the worker
 *   self-declares «finished, changed nothing» — FR-006).
 */
import { Value } from "@sinclair/typebox/value";
import type { FusionRole } from "../types.ts";
import { REPORT_SCHEMAS } from "./schema.ts";

/** Whether the value can carry report fields at all. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function violatedFields(report: unknown, role: FusionRole = "worker"): string[] {
  const schema = REPORT_SCHEMAS[role];
  const fields = new Set<string>();

  for (const error of Value.Errors(schema, report)) {
    // Paths are JSON pointers: "/summary", "/filesChanged/0"; a root error
    // ("") means the value is not an object — every required field is gone.
    const field = error.path.split("/")[1];
    if (field !== undefined) {
      fields.add(field);
    } else {
      for (const required of schema.required ?? []) {
        fields.add(required);
      }
    }
  }

  if (isRecord(report)) {
    // The if/then rule, validator-side: `question` must be present. An empty
    // string counts as present — same verdict as the host's then-branch.
    if (report.status === "needs_orchestrator" && typeof report.question !== "string") {
      fields.add("question");
    }
    // Fresh-worker parity rule: no_changes declares «nothing changed».
    // (Guarded by Array.isArray — a non-array filesChanged already surfaced
    // as a shape error above.)
    if (
      report.status === "no_changes" &&
      Array.isArray(report.filesChanged) &&
      report.filesChanged.length > 0
    ) {
      fields.add("filesChanged");
    }
  }

  return [...fields].sort();
}
