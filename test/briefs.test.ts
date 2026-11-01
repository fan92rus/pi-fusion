/**
 * design.md rev.5.2 §4 Brief (briefs.ts): the text a fresh worker receives.
 * Pure functions; the brief is the only task text that reaches the seam
 * (NFR-004). The title arrives already normalised by the validator (FR-002),
 * so the raw id never reaches the brief.
 */
import { describe, expect, it } from "vitest";
import { renderBrief } from "../extensions/pi-fusion/briefs.ts";
import {
  renderContractBlock,
  type ValidatedContract,
  type ValidatedTask,
  validateFusionCall,
} from "../extensions/pi-fusion/contract/validate.ts";

function task(overrides: Partial<ValidatedTask> = {}): ValidatedTask {
  return { id: "t1", title: "Fix the thing", instructions: "Do the thing.", ...overrides };
}

const contract: ValidatedContract = {
  inputs: ["src/a.ts"],
  owners: { "src/a.ts": "t1" },
  provides: [{ task: "t1", kind: "symbol", name: "HD.Ship", in: "src/a.ts" }],
  checks: [{ task: "t1", cmd: "npm test" }],
};

describe("renderBrief sections", () => {
  it("renders the bare brief as the title heading followed by the instructions", () => {
    expect(renderBrief(task())).toBe("## Fix the thing\n\nDo the thing.");
  });

  it("keeps the lead's language in the instructions untouched", () => {
    const brief = renderBrief(task({ instructions: "Почини функцию сброса счёта." }));
    expect(brief).toBe("## Fix the thing\n\nПочини функцию сброса счёта.");
  });

  it("adds the Deliverable line after the instructions when present", () => {
    expect(renderBrief(task({ deliverable: "a unified diff" }))).toBe(
      "## Fix the thing\n\nDo the thing.\n\nDeliverable: a unified diff",
    );
  });

  it("joins the Scope files with comma and space on one line", () => {
    expect(renderBrief(task({ files: ["src/a.ts", "src/b.ts"] }))).toBe(
      "## Fix the thing\n\nDo the thing.\n\nScope files: src/a.ts, src/b.ts",
    );
  });

  it("puts Deliverable and Scope files on consecutive lines when both are present", () => {
    expect(renderBrief(task({ deliverable: "a diff", files: ["src/a.ts"] }))).toBe(
      "## Fix the thing\n\nDo the thing.\n\nDeliverable: a diff\nScope files: src/a.ts",
    );
  });

  it("omits the Scope files line for an empty files list", () => {
    const brief = renderBrief(task({ files: [] }));
    expect(brief).not.toContain("Scope files");
    expect(brief).toBe("## Fix the thing\n\nDo the thing.");
  });

  it("omits the separator and the contract when no contract is given", () => {
    const brief = renderBrief(task());
    expect(brief).not.toContain("CONTRACT");
    expect(brief).not.toContain("---");
  });
});

describe("renderBrief contract", () => {
  it("puts the whole rendered contract block before the title, then the separator", () => {
    const brief = renderBrief(task(), contract);
    expect(brief).toBe(
      `${renderContractBlock(contract)}\n\n---\n\n## Fix the thing\n\nDo the thing.`,
    );
  });

  it("renders every contract section in full, not a cut of it", () => {
    const brief = renderBrief(task(), contract);
    expect(brief).toContain("- src/a.ts → t1");
    expect(brief).toContain("- [t1] symbol HD.Ship in src/a.ts");
    expect(brief).toContain('- [t1] {"cmd":"npm test"}');
  });
});

describe("renderBrief title normalisation through the validator", () => {
  it("renders the humanised id as the title and never the raw id", () => {
    const result = validateFusionCall({
      tasks: [{ id: "fix_main-sync", instructions: "Sync the main branch." }],
    });
    if (!result.ok) throw new Error(`expected the call to pass: ${JSON.stringify(result.error)}`);
    const brief = renderBrief(result.value.tasks[0] as ValidatedTask);
    expect(brief).toBe("## fix main sync\n\nSync the main branch.");
    expect(brief).not.toContain("fix_main-sync");
  });

  it("keeps an explicit title as written", () => {
    const result = validateFusionCall({
      tasks: [{ id: "fix_main-sync", title: "Sync main", instructions: "Sync the main branch." }],
    });
    if (!result.ok) throw new Error(`expected the call to pass: ${JSON.stringify(result.error)}`);
    expect(renderBrief(result.value.tasks[0] as ValidatedTask)).toBe(
      "## Sync main\n\nSync the main branch.",
    );
  });
});

describe("renderBrief purity and seam payload", () => {
  it("is deterministic and does not mutate its inputs", () => {
    const t = task({ deliverable: "a diff", files: ["src/a.ts"] });
    const c = structuredClone(contract);
    const tBefore = structuredClone(t);
    const first = renderBrief(t, c);
    expect(renderBrief(t, c)).toBe(first);
    expect(t).toEqual(tBefore);
    expect(c).toEqual(contract);
  });

  it("carries only the brief text: budgets and the raw id stay out of it", () => {
    const t = {
      ...task({ id: "zz_secret_id", title: "Visible title" }),
      maxSteps: 7_777,
      timeoutMs: 123_456,
    };
    const brief = renderBrief(t, contract);
    expect(brief).not.toContain("zz_secret_id");
    expect(brief).not.toContain("7777");
    expect(brief).not.toContain("123456");
  });
});

describe("renderBrief original request (mechanical quote)", () => {
  it("quotes the request as a context-only block before the title", () => {
    const brief = renderBrief(task(), undefined, "Build a turn-based game");
    const lines = brief.split("\n");
    expect(lines[0]).toContain("ORIGINAL REQUEST — context only; your task is below");
    expect(lines[0]).toContain("do only your TASK");
    expect(brief).toContain("---\nBuild a turn-based game\n---");
    // The request is context: the task still follows it.
    expect(brief.indexOf("ORIGINAL REQUEST")).toBeLessThan(brief.indexOf("## Fix the thing"));
  });

  it("omits the block entirely when no request was captured", () => {
    expect(renderBrief(task())).toBe("## Fix the thing\n\nDo the thing.");
    expect(renderBrief(task(), undefined, "")).toBe("## Fix the thing\n\nDo the thing.");
  });

  it("treats a whitespace-only request as none", () => {
    expect(renderBrief(task(), undefined, "   \n\t ")).toBe("## Fix the thing\n\nDo the thing.");
  });

  it("clips the request at the 16,000-char budget and says so", () => {
    const big = "x".repeat(17_000);
    const brief = renderBrief(task(), undefined, big);
    expect(brief).toContain("(truncated: the original request is 17,000 chars");
    // The quoted body between the block's own markers — nothing beyond the budget.
    const start = brief.indexOf("---\n") + 4;
    const body = brief.slice(start, brief.indexOf("\n---", start));
    expect(body).toHaveLength(16_000);
  });

  it("does not split a surrogate pair at the clip boundary", () => {
    // Position 15999 is the high half of an emoji: clipping to 16,000 UTF-16
    // units would end the body on a lone high surrogate (U+FFFD on encode).
    const brief = renderBrief(task(), undefined, `${"a".repeat(15_999)}😀`);
    const start = brief.indexOf("---\n") + 4;
    const body = brief.slice(start, brief.indexOf("\n---", start));
    expect(body).toHaveLength(15_999);
    expect(body.endsWith("a")).toBe(true);
    const last = body.charCodeAt(body.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });

  it("places the request before the contract when both are present", () => {
    const brief = renderBrief(task(), contract, "The whole job");
    const requestAt = brief.indexOf("ORIGINAL REQUEST");
    const contractAt = brief.indexOf("CONTRACT");
    expect(requestAt).toBeGreaterThanOrEqual(0);
    expect(contractAt).toBeGreaterThan(requestAt);
    expect(brief.indexOf("## Fix the thing")).toBeGreaterThan(contractAt);
  });
});
