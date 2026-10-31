/**
 * §4 Brief (design.md rev.5.2, briefs.ts): the text one fresh worker
 * receives. Pure functions — no I/O, no clock. The brief is the only task
 * text that leaves the session for a worker (NFR-004).
 *
 * The task arrives validated: its `title` is already normalised (the
 * humanised id when none was given), so the raw id never reaches the brief.
 * The contract is rendered whole; its size limit is a validation rule
 * (`MAX_CONTRACT_RENDERED_CHARS`), not a truncation here.
 */
import {
  renderContractBlock,
  type ValidatedContract,
  type ValidatedTask,
} from "./contract/validate.ts";

/** The brief for one task, with the shared contract block in front when given. */
export function renderBrief(task: ValidatedTask, contract?: ValidatedContract): string {
  const head = contract === undefined ? "" : `${renderContractBlock(contract)}\n\n---\n\n`;
  const lines = [`## ${task.title}`, "", task.instructions];
  const tail: string[] = [];
  if (task.deliverable !== undefined) tail.push(`Deliverable: ${task.deliverable}`);
  if (task.files !== undefined && task.files.length > 0) {
    tail.push(`Scope files: ${task.files.join(", ")}`);
  }
  if (tail.length > 0) lines.push("", ...tail);
  return head + lines.join("\n");
}
