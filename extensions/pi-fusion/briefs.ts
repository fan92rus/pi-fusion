/**
 * §4 Brief (design.md rev.5.2, briefs.ts): the text one fresh worker
 * receives. Pure functions — no I/O, no clock. The brief is the only task
 * text that leaves the session for a worker (NFR-004).
 *
 * The task arrives validated: its `title` is already normalised (the
 * humanised id when none was given), so the raw id never reaches the brief.
 * The contract is rendered whole; its size limit is a validation rule
 * (`MAX_CONTRACT_RENDERED_CHARS`), not a truncation here.
 *
 * The operator's request is quoted into every brief of the fan-out
 * (atomic-agent `worker-prompt.ts` precedent): a brief is a summary, and
 * thin summaries sent a worker building a landing page when the operator
 * asked for a game. The request is the one text every part of the job must
 * agree with, so every worker gets it — labelled as context, its own task
 * below. Bounded because every worker pays for it in its slot's context:
 * 16,000 chars ≈ 4K tokens, a real spec with room to spare.
 */
import {
  renderContractBlock,
  type ValidatedContract,
  type ValidatedTask,
} from "./contract/validate.ts";

/** How much of the operator's request a brief quotes (≈4K tokens). */
export const ORIGINAL_REQUEST_CHAR_BUDGET = 16_000;

/**
 * A turn-starting user message shorter than this is read as a follow-up
 * («continue», «fix the failing test») and merged with the previous request
 * instead of replacing it — the same threshold as the atomic-agent precedent.
 * Quoted alone, such a message IS the thin brief this feature exists to
 * prevent.
 */
export const FOLLOW_UP_MAX_CHARS = 280;

/**
 * The quoted-request block: a context-only label, the text between explicit
 * markers, and a truncation note when the budget clipped it. Empty request
 * → empty string, so a run with no captured prompt renders the brief exactly
 * as before.
 */
export function quoteOriginalRequest(request: string): string {
  const text = request.trim();
  if (text.length === 0) return "";
  let clipped = text.slice(0, ORIGINAL_REQUEST_CHAR_BUDGET);
  // Never end the body on a lone high surrogate: clipping counts UTF-16
  // units, and half an emoji decodes to U+FFFD.
  const last = clipped.charCodeAt(clipped.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) clipped = clipped.slice(0, -1);
  const lines = [
    "ORIGINAL REQUEST — context only; your task is below. This is the operator's job, which the lead split across several workers. Use it for the names, formats, constraints and look your part must agree with, and do only your TASK.",
    "---",
    clipped,
    "---",
  ];
  if (clipped.length < text.length) {
    lines.push(
      `(truncated: the original request is ${text.length.toLocaleString("en-US")} chars; only the first ${ORIGINAL_REQUEST_CHAR_BUDGET.toLocaleString("en-US")} are quoted above.)`,
    );
  }
  return lines.join("\n");
}

/** The brief for one task: quoted request, contract, then the task itself. */
export function renderBrief(
  task: ValidatedTask,
  contract?: ValidatedContract,
  originalRequest?: string,
): string {
  const head: string[] = [];
  const request = quoteOriginalRequest(originalRequest ?? "");
  if (request.length > 0) head.push(request);
  if (contract !== undefined) head.push(renderContractBlock(contract));
  const lines = [`## ${task.title}`, "", task.instructions];
  const tail: string[] = [];
  if (task.deliverable !== undefined) tail.push(`Deliverable: ${task.deliverable}`);
  if (task.files !== undefined && task.files.length > 0) {
    tail.push(`Scope files: ${task.files.join(", ")}`);
  }
  if (tail.length > 0) lines.push("", ...tail);
  // The request block closes itself with its own `---`; the single trailing
  // separator delimits the prelude from the task (and sits after the
  // contract when one is present).
  const prelude = head.length > 0 ? `${head.join("\n\n")}\n\n---\n\n` : "";
  return prelude + lines.join("\n");
}
