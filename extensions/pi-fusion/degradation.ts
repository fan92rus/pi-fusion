/**
 * Honest degradation (design rev.5.2 §4 Degradation; FR-009). The pool
 * (pool/fanout.ts) detects the two seam-loss shapes and keeps the call
 * honest: a pre-flight `available() === false` refuses the WHOLE call as a
 * DegradationRefusal before any worker exists; a mid-run
 * `unavailableContext` fails just that task (seam-unavailable), the call
 * continues and returns its partial result — and never excludes the child's
 * model, because switching models cannot fix a dead seam.
 *
 * This module carries the lead-facing surfaces of that behavior: the
 * refusal type guard and the one explicit order the lead falls back to
 * (design §7: «один явный приказ "делай работу сам"»), zero workers.
 */
import type { DegradationRefusal } from "./pool/fanout.ts";
import type { FanoutResult } from "./types.ts";

/** The FR-009 refusal, word for word: one explicit order, zero workers. */
export const SEAM_UNAVAILABLE_ORDER = "fusion недоступен — делай работу сам";

/** Discriminates the pool's two outcomes: the refusal vs. the aggregate. */
export function isDegradationRefusal(
  value: FanoutResult | DegradationRefusal,
): value is DegradationRefusal {
  return "seamUnavailable" in value;
}

/** The text the tool returns when the seam is down before the fan-out. */
export function renderDegradationRefusal(_refusal: DegradationRefusal): string {
  return SEAM_UNAVAILABLE_ORDER;
}
