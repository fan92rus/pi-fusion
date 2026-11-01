import { describe, expect, it } from "vitest";
import {
  humaniseTaskId,
  MAX_CONTRACT_RENDERED_CHARS,
  renderContractBlock,
  validateFusionCall,
} from "../extensions/pi-fusion/contract/validate.ts";
import { MAX_INSTRUCTIONS_CHARS } from "../extensions/pi-fusion/types.ts";

function task(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "t1", instructions: "do the thing", ...overrides };
}

function call(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { tasks: [task()], ...overrides };
}

/** The offender of a refused call; fails the test when the call is accepted. */
function refusedBy(raw: unknown): { reason: string; offender: string } {
  const result = validateFusionCall(raw);
  if (result.ok) throw new Error("expected the call to be refused");
  return result.error;
}

function accepted(raw: unknown) {
  const result = validateFusionCall(raw);
  if (!result.ok) throw new Error(`expected the call to pass: ${JSON.stringify(result.error)}`);
  return result.value;
}

describe("humaniseTaskId (atomic title default)", () => {
  it("turns underscores and hyphens into single spaces", () => {
    expect(humaniseTaskId("fix_main-sync")).toBe("fix main sync");
    expect(humaniseTaskId("a__b--c")).toBe("a b c");
  });

  it("keeps any other character as written", () => {
    expect(humaniseTaskId("Ship.HUD v2")).toBe("Ship.HUD v2");
  });

  it("returns the id unchanged when nothing is left after humanising", () => {
    expect(humaniseTaskId("_-_")).toBe("_-_");
  });
});

describe("validateFusionCall: accepted call shape", () => {
  it("returns the tasks with title defaulted to the humanised id", () => {
    const value = accepted(call({ tasks: [task({ id: "fix_main-sync" })] }));
    expect(value.tasks).toEqual([
      { id: "fix_main-sync", title: "fix main sync", instructions: "do the thing", role: "worker" },
    ]);
  });

  it("keeps an explicit title, deliverable, files and budgets", () => {
    const value = accepted(
      call({
        maxWorkers: 2,
        tasks: [
          task({
            title: "Ship HUD",
            deliverable: "a working hud",
            files: ["js/hud.js"],
            maxSteps: 40,
            timeoutMs: 120000,
          }),
        ],
      }),
    );
    expect(value.maxWorkers).toBe(2);
    expect(value.tasks[0]).toEqual({
      id: "t1",
      title: "Ship HUD",
      instructions: "do the thing",
      role: "worker",
      deliverable: "a working hud",
      files: ["js/hud.js"],
      maxSteps: 40,
      timeoutMs: 120000,
    });
  });

  it("treats a blank title as no explicit title", () => {
    const value = accepted(call({ tasks: [task({ id: "b_task", title: "   " })] }));
    expect(value.tasks[0]?.title).toBe("b task");
  });

  it("omits an empty files array, like any absent one", () => {
    const value = accepted(call({ tasks: [task({ files: [] })] }));
    expect(value.tasks[0]).toEqual({
      id: "t1",
      title: "t1",
      instructions: "do the thing",
      role: "worker",
    });
  });

  it("refuses a non-string title", () => {
    expect(refusedBy(call({ tasks: [task({ title: 7 })] }))).toEqual({
      reason: expect.stringContaining("title"),
      offender: "tasks[0].title",
    });
  });

  it("accepts etaSeconds without any upper bound and drops it from the output", () => {
    const value = accepted(call({ tasks: [task({ etaSeconds: 999_999 })] }));
    expect(value.tasks[0]).not.toHaveProperty("etaSeconds");
    expect(value.tasks[0]).toEqual({
      id: "t1",
      title: "t1",
      instructions: "do the thing",
      role: "worker",
    });
  });

  it("refuses an etaSeconds that is not a number", () => {
    expect(refusedBy(call({ tasks: [task({ etaSeconds: "soon" })] }))).toEqual({
      reason: expect.stringContaining("etaSeconds"),
      offender: "tasks[0].etaSeconds",
    });
  });

  it("refuses unknown top-level and task fields", () => {
    expect(refusedBy(call({ notes: "extra" })).offender).toBe("notes");
    expect(refusedBy(call({ tasks: [task({ model: "haiku" })] })).offender).toBe("tasks[0].model");
  });
});

describe("validateFusionCall: tasks", () => {
  it("refuses tasks that are not an array", () => {
    expect(refusedBy(call({ tasks: "[]" })).offender).toBe("tasks");
    expect(refusedBy(call({ tasks: {} })).offender).toBe("tasks");
  });

  it("tasks: 1..16 — 16 valid, 0 and 17 refused", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => task({ id: `t${i}` }));
    expect(accepted(call({ tasks: many(16) })).tasks).toHaveLength(16);
    expect(refusedBy(call({ tasks: [] })).offender).toBe("tasks");
    expect(refusedBy(call({ tasks: many(17) })).offender).toBe("tasks");
  });

  it("refuses a task that is not an object", () => {
    expect(refusedBy(call({ tasks: ["t1"] })).offender).toBe("tasks[0]");
  });

  it("refuses duplicate ids and names the second occurrence", () => {
    expect(refusedBy(call({ tasks: [task({ id: "dup" }), task({ id: "dup" })] }))).toEqual({
      reason: expect.stringContaining('"dup" is not unique'),
      offender: "tasks[1].id",
    });
  });

  it("id: 200 chars valid, 201 refused, empty refused", () => {
    expect(accepted(call({ tasks: [task({ id: "a".repeat(200) })] })).tasks).toHaveLength(1);
    expect(refusedBy(call({ tasks: [task({ id: "a".repeat(201) })] })).offender).toBe(
      "tasks[0].id",
    );
    expect(refusedBy(call({ tasks: [task({ id: "" })] })).offender).toBe("tasks[0].id");
  });

  it("id refuses CR and LF anywhere in the value", () => {
    expect(refusedBy(call({ tasks: [task({ id: "a\nb" })] })).offender).toBe("tasks[0].id");
    expect(refusedBy(call({ tasks: [task({ id: "a\rb" })] })).offender).toBe("tasks[0].id");
    expect(refusedBy(call({ tasks: [task({ id: "a\n" })] })).offender).toBe("tasks[0].id");
  });

  it("instructions: 32000 valid, 32001 refused with the overage, empty refused", () => {
    expect(
      accepted(call({ tasks: [task({ instructions: "a".repeat(MAX_INSTRUCTIONS_CHARS) })] })).tasks,
    ).toHaveLength(1);
    const over = refusedBy(
      call({ tasks: [task({ instructions: "a".repeat(MAX_INSTRUCTIONS_CHARS + 1) })] }),
    );
    expect(over.offender).toBe("tasks[0].instructions");
    expect(over.reason).toContain("shorten it by at least 1 chars");
    expect(refusedBy(call({ tasks: [task({ instructions: "   " })] })).offender).toBe(
      "tasks[0].instructions",
    );
  });

  it("files: 32 valid, 33 refused, empty entries refused and named by index", () => {
    const paths = (n: number) => Array.from({ length: n }, (_, i) => `f${i}.ts`);
    expect(accepted(call({ tasks: [task({ files: paths(32) })] })).tasks[0]?.files).toHaveLength(
      32,
    );
    expect(refusedBy(call({ tasks: [task({ files: paths(33) })] })).offender).toBe(
      "tasks[0].files",
    );
    expect(refusedBy(call({ tasks: [task({ files: ["ok.ts", " "] })] })).offender).toBe(
      "tasks[0].files[1]",
    );
  });

  it("refuses files that are not an array", () => {
    expect(refusedBy(call({ tasks: [task({ files: "a.ts" })] })).offender).toBe("tasks[0].files");
  });

  it("maxSteps and timeoutMs must be positive numbers", () => {
    expect(accepted(call({ tasks: [task({ maxSteps: 1, timeoutMs: 5 })] })).tasks).toHaveLength(1);
    expect(refusedBy(call({ tasks: [task({ maxSteps: 0 })] })).offender).toBe("tasks[0].maxSteps");
    expect(refusedBy(call({ tasks: [task({ timeoutMs: -1 })] })).offender).toBe(
      "tasks[0].timeoutMs",
    );
  });

  it("deliverable must be a non-empty string when present", () => {
    expect(refusedBy(call({ tasks: [task({ deliverable: "" })] })).offender).toBe(
      "tasks[0].deliverable",
    );
  });
});

describe("validateFusionCall: maxWorkers and contract object", () => {
  it("maxWorkers: absent ok, integer >= 1 ok, 0 and fractional refused", () => {
    expect(accepted(call()).maxWorkers).toBeUndefined();
    expect(accepted(call({ maxWorkers: 1 })).maxWorkers).toBe(1);
    expect(refusedBy(call({ maxWorkers: 0 })).offender).toBe("maxWorkers");
    expect(refusedBy(call({ maxWorkers: 1.5 })).offender).toBe("maxWorkers");
  });

  it("contract that is not an object is refused", () => {
    expect(refusedBy(call({ contract: "not an object" }))).toEqual({
      reason: expect.stringContaining("contract must be an object"),
      offender: "contract",
    });
    expect(refusedBy(call({ contract: [] })).offender).toBe("contract");
    expect(refusedBy(call({ contract: null })).offender).toBe("contract");
  });

  it("refuses unknown contract fields — including wire-supplied warnings (M4-R3: the parser computes them)", () => {
    expect(refusedBy(call({ contract: { notes: "x" } })).offender).toBe("contract.notes");
    expect(refusedBy(call({ contract: { warnings: ["no provider"] } })).offender).toBe(
      "contract.warnings",
    );
  });

  it("an empty contract object is accepted and carries no contract", () => {
    expect(accepted(call({ contract: {} })).contract).toBeUndefined();
  });
});

describe("validateFusionCall: contract.inputs", () => {
  it("trims and deduplicates, keeping first occurrence order", () => {
    const value = accepted(call({ contract: { inputs: ["  a.ts ", "a.ts", "b.ts"] } }));
    expect(value.contract?.inputs).toEqual(["a.ts", "b.ts"]);
  });

  it("at most 32 entries", () => {
    const paths = (n: number) => Array.from({ length: n }, (_, i) => `in${i}.ts`);
    expect(accepted(call({ contract: { inputs: paths(32) } })).contract?.inputs).toHaveLength(32);
    expect(refusedBy(call({ contract: { inputs: paths(33) } })).offender).toBe("contract.inputs");
  });

  it("applies the cap after trimming and deduplicating", () => {
    const same = Array.from({ length: 33 }, () => "  a.ts ");
    expect(accepted(call({ contract: { inputs: same } })).contract?.inputs).toEqual(["a.ts"]);
  });

  it("an inputs list that normalizes to nothing leaves no contract", () => {
    expect(accepted(call({ contract: { inputs: [] } })).contract).toBeUndefined();
  });

  it("refuses an empty entry and names it by index", () => {
    expect(refusedBy(call({ contract: { inputs: ["ok.ts", "  "] } })).offender).toBe(
      "contract.inputs[1]",
    );
  });

  it("refuses inputs that are not an array", () => {
    expect(refusedBy(call({ contract: { inputs: "a.ts" } }))).toEqual({
      reason: expect.stringContaining("contract.inputs must be an array"),
      offender: "contract.inputs",
    });
  });
});

describe("validateFusionCall: contract.owners", () => {
  it("maps trimmed path to a known task", () => {
    const value = accepted(
      call({
        tasks: [task({ id: "t1" }), task({ id: "t2" })],
        contract: { owners: { " a.ts ": "t2" } },
      }),
    );
    expect(value.contract?.owners).toEqual({ "a.ts": "t2" });
  });

  it("refuses an unknown task and names the path", () => {
    expect(refusedBy(call({ contract: { owners: { "a.ts": "ghost" } } }))).toEqual({
      reason: expect.stringContaining('unknown task "ghost"'),
      offender: 'contract.owners["a.ts"]',
    });
  });

  it("refuses an empty path", () => {
    expect(refusedBy(call({ contract: { owners: { "  ": "t1" } } })).reason).toContain(
      "empty path",
    );
  });

  it("refuses owners that are not an object", () => {
    expect(refusedBy(call({ contract: { owners: ["a.ts"] } })).offender).toBe("contract.owners");
  });
});

describe("validateFusionCall: contract.provides", () => {
  it("accepts the seven kinds and rejects anything else", () => {
    const kinds = ["symbol", "file", "id", "endpoint", "env", "flag", "other"];
    const provides = kinds.map((kind) => ({ task: "t1", kind, name: `n-${kind}`, in: "x.ts" }));
    expect(accepted(call({ contract: { provides } })).contract?.provides).toHaveLength(7);
    expect(
      refusedBy(call({ contract: { provides: [{ task: "t1", kind: "widget", name: "x" }] } })),
    ).toEqual({
      reason: expect.stringContaining("kind must be one of"),
      offender: "contract.provides[0].kind",
    });
  });

  it("at most 64 entries", () => {
    const provide = { task: "t1", kind: "symbol", name: "HD.Ship", in: "js/ship.js" };
    expect(
      accepted(call({ contract: { provides: Array.from({ length: 64 }, () => provide) } })).contract
        ?.provides,
    ).toHaveLength(64);
    expect(
      refusedBy(call({ contract: { provides: Array.from({ length: 65 }, () => provide) } }))
        .offender,
    ).toBe("contract.provides");
  });

  it("refuses provides that are not an array", () => {
    expect(refusedBy(call({ contract: { provides: { task: "t1" } } }))).toEqual({
      reason: expect.stringContaining("contract.provides must be an array"),
      offender: "contract.provides",
    });
  });

  it("refuses an unknown task reference", () => {
    expect(
      refusedBy(call({ contract: { provides: [{ task: "ghost", kind: "file", name: "a.ts" }] } }))
        .offender,
    ).toBe("contract.provides[0].task");
  });

  it("refuses an empty name and an empty in", () => {
    expect(
      refusedBy(call({ contract: { provides: [{ task: "t1", kind: "file", name: " " }] } }))
        .offender,
    ).toBe("contract.provides[0].name");
    expect(
      refusedBy(
        call({ contract: { provides: [{ task: "t1", kind: "file", name: "a.ts", in: "" }] } }),
      ).offender,
    ).toBe("contract.provides[0].in");
  });

  it("truncates a shape over 200 chars to 200 with an ellipsis, not a refusal", () => {
    const shape = "s".repeat(250);
    const value = accepted(
      call({ contract: { provides: [{ task: "t1", kind: "file", name: "a.ts", shape }] } }),
    );
    const kept = value.contract?.provides?.[0]?.shape;
    expect(kept).toBe(`${"s".repeat(199)}…`);
    expect(kept?.length).toBe(200);
  });

  it("warns on the contract when a shape is truncated, naming the provide", () => {
    const shape = "s".repeat(250);
    const value = accepted(
      call({ contract: { provides: [{ task: "t1", kind: "file", name: "a.ts", shape }] } }),
    );
    expect(value.contract?.warnings).toEqual(['provides "a.ts" (task t1) shape cut to 200 chars']);
  });

  it("keeps a shape of exactly 200 chars whole, with no warning", () => {
    const shape = "s".repeat(200);
    const value = accepted(
      call({ contract: { provides: [{ task: "t1", kind: "file", name: "a.ts", shape }] } }),
    );
    expect(value.contract?.provides?.[0]?.shape).toBe(shape);
    expect(value.contract?.warnings).toBeUndefined();
  });

  it("puts the shape warnings before the requires warnings", () => {
    const value = accepted(
      call({
        contract: {
          provides: [{ task: "t1", kind: "file", name: "a.ts", shape: "s".repeat(201) }],
          requires: [{ task: "t1", name: "ghost" }],
        },
      }),
    );
    expect(value.contract?.warnings).toEqual([
      'provides "a.ts" (task t1) shape cut to 200 chars',
      'requires "ghost" (task t1) has no provider — nothing produces it',
    ]);
  });

  it("refuses an empty shape", () => {
    expect(
      refusedBy(
        call({ contract: { provides: [{ task: "t1", kind: "file", name: "a.ts", shape: "  " }] } }),
      ).offender,
    ).toBe("contract.provides[0].shape");
  });
});

describe("validateFusionCall: contract.requires", () => {
  it("accepts a known task and a non-empty name", () => {
    const value = accepted(
      call({
        contract: {
          provides: [{ task: "t1", kind: "symbol", name: "HD.Ship", in: "js/ship.js" }],
          requires: [{ task: "t1", name: "HD.Ship" }],
        },
      }),
    );
    expect(value.contract?.requires).toEqual([{ task: "t1", name: "HD.Ship" }]);
  });

  it("refuses an unknown task and an empty name", () => {
    expect(
      refusedBy(call({ contract: { requires: [{ task: "ghost", name: "x" }] } })).offender,
    ).toBe("contract.requires[0].task");
    expect(refusedBy(call({ contract: { requires: [{ task: "t1", name: "" }] } })).offender).toBe(
      "contract.requires[0].name",
    );
  });

  it("refuses requires that are not an array", () => {
    expect(refusedBy(call({ contract: { requires: "x" } }))).toEqual({
      reason: expect.stringContaining("contract.requires must be an array"),
      offender: "contract.requires",
    });
  });

  it("refuses an entry with unknown fields", () => {
    expect(
      refusedBy(call({ contract: { requires: [{ task: "t1", name: "x", extra: 1 }] } })).offender,
    ).toBe("contract.requires[0].extra");
  });
});

describe("validateFusionCall: contract.checks", () => {
  it("keeps the spec and the optional task attribution", () => {
    const value = accepted(
      call({ contract: { checks: [{ task: "t1", cmd: "npm test" }, { cmd: "npm run lint" }] } }),
    );
    expect(value.contract?.checks).toEqual([
      { task: "t1", cmd: "npm test" },
      { cmd: "npm run lint" },
    ]);
  });

  it("at most 16 checks", () => {
    const spec = { cmd: "npm test" };
    expect(
      accepted(call({ contract: { checks: Array.from({ length: 16 }, () => spec) } })).contract
        ?.checks,
    ).toHaveLength(16);
    expect(
      refusedBy(call({ contract: { checks: Array.from({ length: 17 }, () => spec) } })).offender,
    ).toBe("contract.checks");
  });

  it("refuses an empty spec, even when attributed to a task", () => {
    expect(refusedBy(call({ contract: { checks: [{ task: "t1" }] } })).reason).toContain(
      "no verify.run arguments",
    );
    expect(refusedBy(call({ contract: { checks: [{}] } })).offender).toBe("contract.checks[0]");
  });

  it("refuses checks that are not an array", () => {
    expect(refusedBy(call({ contract: { checks: { cmd: "npm test" } } }))).toEqual({
      reason: expect.stringContaining("contract.checks must be an array"),
      offender: "contract.checks",
    });
  });

  it("refuses an unknown task attribution and a non-string task", () => {
    expect(refusedBy(call({ contract: { checks: [{ task: "ghost", cmd: "x" }] } })).offender).toBe(
      "contract.checks[0].task",
    );
    expect(refusedBy(call({ contract: { checks: [{ task: 7, cmd: "x" }] } })).offender).toBe(
      "contract.checks[0].task",
    );
  });
});

describe("validateFusionCall: warnings (semantic unsatisfiability is not a refusal)", () => {
  it("a require no provide satisfies becomes a warning on the contract", () => {
    const value = accepted(
      call({
        tasks: [task({ id: "t1" }), task({ id: "t2" })],
        contract: { requires: [{ task: "t2", name: "organized_files" }] },
      }),
    );
    expect(value.contract?.warnings).toEqual([
      'requires "organized_files" (task t2) has no provider — nothing produces it',
    ]);
  });

  it("a non-file provide with nowhere to be looked for becomes a warning", () => {
    const value = accepted(
      call({
        contract: { provides: [{ task: "t1", kind: "symbol", name: "HD.Ship" }] },
      }),
    );
    expect(value.contract?.warnings).toEqual([
      'provides "HD.Ship" (task t1) cannot be checked: no `in`, no owned path, no declared files',
    ]);
  });

  it("a provide is checkable through its task's owned path or declared files", () => {
    const provides = [{ task: "t1", kind: "symbol", name: "HD.Ship" }];
    expect(
      accepted(call({ contract: { provides, owners: { "js/ship.js": "t1" } } })).contract?.warnings,
    ).toBeUndefined();
    expect(
      accepted(call({ tasks: [task({ id: "t1", files: ["js/ship.js"] })], contract: { provides } }))
        .contract?.warnings,
    ).toBeUndefined();
  });

  it("a glob owner or declared file does not make a provide checkable", () => {
    const provides = [{ task: "t1", kind: "symbol", name: "HD.Ship" }];
    expect(
      accepted(call({ contract: { provides, owners: { "js/*.js": "t1" } } })).contract?.warnings,
    ).toEqual([expect.stringContaining("cannot be checked")]);
  });

  it("a file-kind provide never warns about its location", () => {
    const value = accepted(
      call({ contract: { provides: [{ task: "t1", kind: "file", name: "js/hud.js" }] } }),
    );
    expect(value.contract?.warnings).toBeUndefined();
  });
});

describe("validateFusionCall: rendered contract ceiling (refusal, not clamp)", () => {
  /** One provide whose name is padded so the rendered block has an exact length. */
  function providesNamed(nameChars: number) {
    return [{ task: "t1", kind: "symbol" as const, name: "N".repeat(nameChars), in: "js/ship.js" }];
  }

  /** Name length that makes the block of `provides` exactly `target` chars. */
  function nameLengthFor(target: number): number {
    const base = renderContractBlock({ provides: providesNamed(1) }).length;
    return 1 + (target - base);
  }

  it("a block of exactly 8000 chars is accepted", () => {
    const provides = providesNamed(nameLengthFor(MAX_CONTRACT_RENDERED_CHARS));
    const value = accepted(call({ contract: { provides } }));
    expect(renderContractBlock(value.contract ?? {}).length).toBe(MAX_CONTRACT_RENDERED_CHARS);
  });

  it("a block of 8001 chars is refused, the offender is the contract", () => {
    const provides = providesNamed(nameLengthFor(MAX_CONTRACT_RENDERED_CHARS + 1));
    expect(refusedBy(call({ contract: { provides } }))).toEqual({
      reason: expect.stringMatching(
        /renders to 8,001 chars; the limit is 8,000 — shorten it by at least 1 chars/,
      ),
      offender: "contract",
    });
  });

  it("the measured block includes the warnings: 8000 plain, refused once a warning lands", () => {
    const provides = providesNamed(nameLengthFor(MAX_CONTRACT_RENDERED_CHARS));
    expect(accepted(call({ contract: { provides } })).contract).toBeDefined();
    const refused = refusedBy(
      call({ contract: { provides, requires: [{ task: "t1", name: "nothing-provides-this" }] } }),
    );
    expect(refused.offender).toBe("contract");
    expect(refused.reason).toContain("renders to");
  });

  it("the ceiling is measured after the 200-char shape truncation", () => {
    const provides = Array.from({ length: 10 }, (_, i) => ({
      task: "t1",
      kind: "symbol",
      name: `HD.Ship.member${i}`,
      in: "js/ship.js",
      shape: "s".repeat(5000),
    }));
    const value = accepted(call({ contract: { provides } }));
    expect(value.contract?.provides?.every((p) => p.shape?.length === 200)).toBe(true);
    expect(value.contract?.warnings).toHaveLength(10);
  });
});

describe("renderContractBlock", () => {
  it("renders inputs, owners, provides, provided requires, checks and warnings in that order", () => {
    const block = renderContractBlock({
      inputs: ["src/a.ts"],
      owners: { "js/ship.js": "t1" },
      provides: [{ task: "t1", kind: "symbol", name: "HD.Ship", in: "js/ship.js", shape: "class" }],
      requires: [
        { task: "t2", name: "HD.Ship" },
        { task: "t2", name: "ghost" },
      ],
      checks: [{ task: "t1", cmd: "npm test" }],
      warnings: ['requires "ghost" (task t2) has no provider — nothing produces it'],
    });
    expect(
      block.split("\n").filter((line) => !line.startsWith("- src") && line.length > 0),
    ).toEqual(
      expect.arrayContaining([
        "OWNERS (path → task; write only in paths you own):",
        "PROVIDES:",
        "- [t1] symbol HD.Ship in js/ship.js — class",
        "REQUIRES:",
        "- [t2] HD.Ship",
        "CHECKS (run after the fan-out; a failing check fails its task):",
        '- [t1] {"cmd":"npm test"}',
        'contract: requires "ghost" (task t2) has no provider — nothing produces it',
      ]),
    );
    expect(block).not.toContain("- [t2] HD.Ship, ghost");
  });
});

describe("validateFusionCall: role normalization (design §4.2)", () => {
  it("absent role normalises to worker", () => {
    const call = { tasks: [task()] };
    const result = validateFusionCall(call);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.tasks[0]?.role).toBe("worker");
  });

  it("each exact role passes through to ValidatedTask", () => {
    for (const role of ["worker", "scout", "researcher", "reviewer"] as const) {
      const result = validateFusionCall({ tasks: [task({ role })] });
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) throw new Error("unreachable");
      expect(result.value.tasks[0]?.role).toBe(role);
    }
  });

  it("refuses an unknown role before the fan-out, naming tasks[i].role", () => {
    for (const role of ["lead", "Worker", "helper"]) {
      expect(refusedBy({ tasks: [task({ role })] })).toEqual({
        reason: "role must be one of worker, scout, researcher, reviewer",
        offender: "tasks[0].role",
      });
    }
  });
});
