import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyBashCommand,
  GIT_RULES,
  isPathInsideOpenSpecTarget,
  isSingleBdInvocation,
  isSingleGitInvocation,
  isSinglePerlInvocation,
  normalizeLeadPath,
  type OpenSpecBoundaryResult,
  tokenizeShellCommand,
} from "../extensions/pi-fusion/lead-access.ts";

/* ------------------------------------------------------------------ */
/* Shared tokenizer and bd classifier (design §6.1, §6.1.7, §6.5; 8.6)  */
/* ------------------------------------------------------------------ */

const SUBCOMMAND_REASON = "argv[1] — не подкоманда из списка create/show/list/ready/update/close";
const UNIFIED_REASON = "первый токен не perl и не bd";
const HASH_REASON = 'неквотированный "#" вне кавычек (комментарий оболочки)';

/** The gate's view of one bash command: the branch it takes, and its verdict or refusal reason. */
function bashOf(command: string): { branch: string; ok: boolean; reason?: string } {
  const classified = classifyBashCommand(command);
  if (classified.branch === "other")
    return { branch: "other", ok: false, reason: classified.reason };
  return classified.verdict.ok
    ? { branch: classified.branch, ok: true }
    : { branch: classified.branch, ok: false, reason: classified.verdict.reason };
}

describe("tokenizeShellCommand (design §6.1, §6.1.7, §6.5.2)", () => {
  it("splits on space and tab only; \\v, \\f and NBSP are ordinary word characters", () => {
    expect(tokenizeShellCommand("a \t b")).toEqual({
      ok: true,
      tokens: [{ value: "a" }, { value: "b" }],
    });
    expect(tokenizeShellCommand("a\vb")).toEqual({ ok: true, tokens: [{ value: "a\vb" }] });
    expect(tokenizeShellCommand("a\fb")).toEqual({ ok: true, tokens: [{ value: "a\fb" }] });
    expect(tokenizeShellCommand("a\u00A0b")).toEqual({ ok: true, tokens: [{ value: "a\u00A0b" }] });
  });

  it("keeps quoted text literal, newlines inside single quotes included", () => {
    expect(tokenizeShellCommand("bd create 'x\ny'")).toEqual({
      ok: true,
      tokens: [{ value: "bd" }, { value: "create" }, { value: "x\ny" }],
    });
  });

  it("flags only UNQUOTED expansion characters, per token", () => {
    expect(tokenizeShellCommand(`bd create '*' "~" x*`)).toEqual({
      ok: true,
      tokens: [
        { value: "bd" },
        { value: "create" },
        { value: "*" },
        { value: "~" },
        { value: "x*", expansion: "*" },
      ],
    });
  });

  it("reports the first word only when it was read fully before the error", () => {
    expect(tokenizeShellCommand("bd list; rm")).toEqual({
      ok: false,
      reason: 'метасимвол ";" вне кавычек',
      firstWord: "bd",
    });
    expect(tokenizeShellCommand("perl -e 'x' # note")).toEqual({
      ok: false,
      reason: HASH_REASON,
      firstWord: "perl",
    });
    expect(tokenizeShellCommand("perl#x")).toEqual({ ok: false, reason: HASH_REASON });
    expect(tokenizeShellCommand('bd"x')).toEqual({
      ok: false,
      reason: "незакрытая двойная кавычка",
    });
    expect(tokenizeShellCommand("'bd")).toEqual({
      ok: false,
      reason: "незакрытая одинарная кавычка",
    });
  });
});

describe("isSingleBdInvocation (design §6.5.2, §6.5.6; tasks 8.6)", () => {
  it.each([
    "bd create 'Задача: сделать X'",
    "bd ready",
    "bd list",
    "bd show pi-fusion-8t2",
    "bd update pi-fusion-8t2 --claim",
    "bd close pi-fusion-8t2",
    "  bd   list  ",
    "bd\tlist",
    "bd create '*' \"~\"",
    '"bd" list',
    "'bd' 'list'",
    'bd "list"',
    "bd create 'line one\nline two'",
    "bd create 'a#b'",
    'bd create "a#b"',
    "bd create '[x]' '{y}' '!z'",
  ])("allows %j", (command) => {
    expect(isSingleBdInvocation(command)).toEqual({ ok: true });
  });

  it.each([
    ["bd", SUBCOMMAND_REASON],
    ["bd init", SUBCOMMAND_REASON],
    ["bd dolt push", SUBCOMMAND_REASON],
    ["bd remember 'x'", SUBCOMMAND_REASON],
    ["bd prime", SUBCOMMAND_REASON],
    ["bd --json list", SUBCOMMAND_REASON],
    ["bd -p list", SUBCOMMAND_REASON],
    ["bd --help ready", SUBCOMMAND_REASON],
    ["bd LIST", SUBCOMMAND_REASON],
    ["bd Create x", SUBCOMMAND_REASON],
    ['bd ""', SUBCOMMAND_REASON],
    ["bd create x; bd list", 'метасимвол ";" вне кавычек'],
    ["bd list | wc", 'метасимвол "|" вне кавычек'],
    ["bd list > /tmp/out", 'метасимвол ">" вне кавычек'],
    ["bd list &", 'метасимвол "&" вне кавычек'],
    ["bd 'unclosed", "незакрытая одинарная кавычка"],
    ['bd "list', "незакрытая двойная кавычка"],
    ['bd "x\\" " ; bd list', "backslash в двойных кавычках (эскейп не поддерживается)"],
    ["bd list *", 'неквотированный символ раскрытия оболочки "*"'],
    ["bd show ~", 'неквотированный символ раскрытия оболочки "~"'],
    ["bd list {a,b}", 'неквотированный символ раскрытия оболочки "{"'],
    ["bd list }", 'неквотированный символ раскрытия оболочки "}"'],
    ["bd list [a]", 'неквотированный символ раскрытия оболочки "["'],
    ["bd list x?", 'неквотированный символ раскрытия оболочки "?"'],
    ["bd list hi!", 'неквотированный символ раскрытия оболочки "!"'],
    ["bd create x*y", 'неквотированный символ раскрытия оболочки "*"'],
    ["bd list #x", HASH_REASON],
    ["bd list x # note", HASH_REASON],
  ])("refuses %j", (command, reason) => {
    expect(isSingleBdInvocation(command)).toEqual({ ok: false, reason });
  });

  it("names the first found expansion character, left to right", () => {
    expect(isSingleBdInvocation("bd list x[ {")).toEqual({
      ok: false,
      reason: 'неквотированный символ раскрытия оболочки "["',
    });
  });
});

describe("the unquoted # is refused for perl and bd alike (B-NEW, design §6.1.3)", () => {
  // bash: an unquoted # starts a comment, so the next line is a second command.
  // A quote-flipping scanner reads the ' inside that comment as an opening quote
  // and hides the line break and the command after it.
  const EXPLOIT_PERL = "perl -e 'print 1' #'\nprintf MARKER\n#'";
  const EXPLOIT_BD = "bd list #'\nprintf MARKER\n#'";

  it("refuses the exploit line for perl and bd", () => {
    expect(isSinglePerlInvocation(EXPLOIT_PERL)).toEqual({ ok: false, reason: HASH_REASON });
    expect(isSingleBdInvocation(EXPLOIT_BD)).toEqual({ ok: false, reason: HASH_REASON });
  });

  it("refuses a trailing comment after a valid call", () => {
    expect(isSinglePerlInvocation("perl -e 'x' # note")).toEqual({
      ok: false,
      reason: HASH_REASON,
    });
    expect(isSingleBdInvocation("bd list x # note")).toEqual({ ok: false, reason: HASH_REASON });
  });

  it("allows a quoted # as a literal in both branches", () => {
    expect(isSinglePerlInvocation("perl 'x#y'")).toEqual({ ok: true });
    expect(isSingleBdInvocation("bd create 'a#b'")).toEqual({ ok: true });
    expect(isSingleBdInvocation('bd create "a#b"')).toEqual({ ok: true });
  });
});

describe("whitespace separators (design §6.1.7; tasks 8.6)", () => {
  it("\\v, \\f and NBSP between words are not separators: the first word is not perl or bd", () => {
    expect(isSinglePerlInvocation("perl\v-e 'x'")).toEqual({
      ok: false,
      reason: "первый токен не perl",
    });
    expect(isSinglePerlInvocation("perl\u00A0-e 'x'")).toEqual({
      ok: false,
      reason: "первый токен не perl",
    });
    expect(bashOf("bd\vlist")).toEqual({ branch: "other", ok: false, reason: UNIFIED_REASON });
    expect(bashOf("bd\u00A0list")).toEqual({ branch: "other", ok: false, reason: UNIFIED_REASON });
  });

  it("no trim: a leading \\v or a leading newline refuses", () => {
    expect(isSinglePerlInvocation("\vperl -e 'x'")).toEqual({
      ok: false,
      reason: "первый токен не perl",
    });
    expect(bashOf("\vbd list")).toEqual({ branch: "other", ok: false, reason: UNIFIED_REASON });
    expect(isSinglePerlInvocation("\nperl -e 'x'").ok).toBe(false);
  });

  it("a trailing newline is no longer trimmed away: it refuses as a line break outside quotes", () => {
    expect(isSinglePerlInvocation("perl -e 'x'\n")).toEqual({
      ok: false,
      reason: "перевод строки вне кавычек (разделитель команд)",
    });
    expect(isSinglePerlInvocation("perl -e 'x'\r")).toEqual({
      ok: false,
      reason: "перевод строки вне кавычек (разделитель команд)",
    });
  });

  it("space and tab separate words, in any count", () => {
    expect(isSinglePerlInvocation("perl\t-e\t'x'")).toEqual({ ok: true });
    expect(isSinglePerlInvocation(" \tperl \t -e 'x'\t ")).toEqual({ ok: true });
    expect(isSingleBdInvocation("bd\t\tlist")).toEqual({ ok: true });
  });

  it("a whitespace-only command and an empty command are both empty", () => {
    expect(isSinglePerlInvocation("\t \t")).toEqual({ ok: false, reason: "пустая команда" });
    expect(bashOf("   ")).toEqual({ branch: "other", ok: false, reason: "пустая команда" });
    expect(bashOf("")).toEqual({ branch: "other", ok: false, reason: "пустая команда" });
  });

  it("a multi-line quoted argument does not split the command (design §6.1 п. 3)", () => {
    expect(isSingleBdInvocation("bd create 'line one\nline two'")).toEqual({ ok: true });
    expect(isSinglePerlInvocation("perl -e 'print 1;\nprint 2'")).toEqual({ ok: true });
  });
});

describe("the first word decides the branch (design §6.5.1; tasks 8.6)", () => {
  it.each([
    // argv[0] after unquoting: the same command as the plain form
    ['"bd" list', "bd", true],
    ["'bd' 'list'", "bd", true],
    ["'perl' -e 'x'", "perl", true],
    // the perl branch keeps its text: the reason is the tokenizer's
    ['"perl" -e x && make', "perl", false, 'метасимвол "&" вне кавычек'],
    ["perl -e 'x' && make", "perl", false, 'метасимвол "&" вне кавычек'],
    ["perl -e 'x' # note", "perl", false, HASH_REASON],
    // the bd branch: the tokenizer, then argv[1], then expansions
    ["bd 'unclosed", "bd", false, "незакрытая одинарная кавычка"],
    ["bd list #x", "bd", false, HASH_REASON],
    ["bd create x; bd list", "bd", false, 'метасимвол ";" вне кавычек'],
    ["bd", "bd", false, SUBCOMMAND_REASON],
    // not perl and not bd: the merged formula
    ['"BD" list', "other", false, UNIFIED_REASON],
    ['"bd"x list', "other", false, UNIFIED_REASON],
    ['"" list', "other", false, UNIFIED_REASON],
    ["BD list", "other", false, UNIFIED_REASON],
    ["bdx list", "other", false, UNIFIED_REASON],
    ["command bd list", "other", false, UNIFIED_REASON],
    ["/usr/bin/bd list", "other", false, UNIFIED_REASON],
    ["echo x && bd list", "other", false, UNIFIED_REASON],
    ["cat x | perl -e 'y'", "other", false, UNIFIED_REASON],
    ["ls", "other", false, UNIFIED_REASON],
    // the first word is not read fully: the tokenizer's reason
    ["perl#x", "other", false, HASH_REASON],
    ["'perl", "other", false, "незакрытая одинарная кавычка"],
  ])("%j → %s", (command: string, branch: string, ok: boolean, reason?: string) => {
    const expected = reason === undefined ? { branch, ok } : { branch, ok, reason };
    expect(bashOf(command)).toEqual(expected);
  });

  it('the empty token "" is a token, not an empty command', () => {
    expect(bashOf('""')).toEqual({ branch: "other", ok: false, reason: UNIFIED_REASON });
  });
});

describe("expansion characters: bd refuses them unquoted, perl keeps its behaviour (design §6.1.7)", () => {
  it("perl accepts unquoted expansion characters after its one call (accepted divergence)", () => {
    for (const command of [
      "perl -e 'x' *",
      "perl -e 'x' {a,b}",
      "perl -e 'x' ~",
      "perl -e 'x' ?",
      "perl -e 'x' !",
      "perl -pi -e 's/a/b/' openspec/*.md",
    ]) {
      expect(isSinglePerlInvocation(command), command).toEqual({ ok: true });
    }
  });

  it("bd: an unquoted expansion character in any token refuses; quoted ones are literals", () => {
    expect(isSingleBdInvocation("bd create '*' \"~\"")).toEqual({ ok: true });
    expect(isSingleBdInvocation("bd list *")).toEqual({
      ok: false,
      reason: 'неквотированный символ раскрытия оболочки "*"',
    });
  });
});

/* ------------------------------------------------------------------ */
/* Perl classifier — the §6.4 table                                    */
/* ------------------------------------------------------------------ */

describe("isSinglePerlInvocation (design §6.1, §6.4)", () => {
  const verdictOf = (command: string) => isSinglePerlInvocation(command);

  it("allows a lone perl call with quoted arguments", () => {
    expect(verdictOf("perl -0777 -i -pe 's/foo/bar/g' openspec/config.yaml")).toEqual({ ok: true });
    expect(verdictOf("perl -e 'print 42'")).toEqual({ ok: true });
    expect(verdictOf("  perl   -e   'x'  ")).toEqual({ ok: true });
    expect(verdictOf("perl 'a;b|c' 'x$y'")).toEqual({ ok: true }); // quotes are literals
  });

  it("refuses anything that is not exactly one perl call", () => {
    expect(verdictOf("echo x | perl -e 'y'").ok).toBe(false);
    expect(verdictOf("perl -e 'x' && rm -rf /").ok).toBe(false);
    expect(verdictOf("perl -e 'a'; perl -e 'b'").ok).toBe(false);
    expect(verdictOf("perl -e 'x'\nrm -rf /").ok).toBe(false);
    expect(verdictOf("perl -e 'x'\rm -rf /").ok).toBe(false);
    expect(verdictOf("`ls`").ok).toBe(false);
    expect(verdictOf("perl -e 'x' > /tmp/out").ok).toBe(false);
    expect(verdictOf("perl -e 'x' < in").ok).toBe(false);
    expect(verdictOf("perl -e 'x' $(cmd)").ok).toBe(false);
  });

  it("refuses shell substitution inside double quotes ($, backtick, backslash)", () => {
    expect(verdictOf('perl -e "print $ENV{HOME}"').ok).toBe(false);
    expect(verdictOf('perl -e "print `id`"').ok).toBe(false);
    // B1 bypass reproduction (§6.1.2): bash treats \" as an escaped quote and
    // executes the tail; the quote-flipper scanner would hide it. Backslash
    // inside double quotes refuses outright.
    const bypass = verdictOf('perl -e "x\\" " ; echo SHELL_CHAIN_EXECUTED; #"');
    expect(bypass.ok).toBe(false);
    if (!bypass.ok) expect(bypass.reason).toContain("backslash в двойных кавычках");
  });

  it("refuses unclosed quotes and empty commands", () => {
    expect(verdictOf("perl -e 'unclosed").ok).toBe(false);
    expect(verdictOf('perl -e "unclosed').ok).toBe(false);
    expect(verdictOf("").ok).toBe(false);
    expect(verdictOf("   ").ok).toBe(false);
  });

  it("refuses when the first token is not exactly perl (FR-005)", () => {
    for (const command of [
      "perl5 -e 'x'",
      "/usr/bin/perl -e 'x'",
      "env perl -e 'x'",
      "xperl -e",
      "perlfoo",
      "echo perl",
    ]) {
      const verdict = verdictOf(command);
      expect(verdict.ok, command).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toContain("первый токен не perl");
    }
  });

  it("names the metacharacter in the refusal", () => {
    const verdict = verdictOf("perl -e 'x' & make");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('"&"');
  });
});

/* ------------------------------------------------------------------ */
/* Path normalization — host parity (B2, design §5.2.2)                */
/* ------------------------------------------------------------------ */

describe("normalizeLeadPath (resolveToCwd parity)", () => {
  it("replaces Unicode spaces, strips a leading @ and resolves", () => {
    const result = normalizeLeadPath("@openspec/\u00A0changes\u2003x.md", "/proj", {
      platform: "posix",
    });
    expect(result).toEqual({ ok: true, path: "/proj/openspec/ changes x.md" });
  });

  it("expands ~ and resolves absolute forms", () => {
    expect(normalizeLeadPath("~", "/proj", { platform: "posix", home: "/home/u" })).toEqual({
      ok: true,
      path: "/home/u",
    });
    expect(
      normalizeLeadPath("~/notes.md", "/proj", { platform: "posix", home: "/home/u" }),
    ).toEqual({
      ok: true,
      path: "/home/u/notes.md",
    });
    expect(normalizeLeadPath("/etc/hosts", "/proj", { platform: "posix" })).toEqual({
      ok: true,
      path: "/etc/hosts",
    });
    // .. is neutralized lexically by resolve.
    expect(normalizeLeadPath("/proj/openspec/../secret", "/proj", { platform: "posix" })).toEqual({
      ok: true,
      path: "/proj/secret",
    });
  });

  it("translates win32 shell-drive forms exactly like the host", () => {
    expect(normalizeLeadPath("/c/proj/openspec/x.md", "C:/proj", { platform: "win32" })).toEqual({
      ok: true,
      path: "C:\\proj\\openspec\\x.md",
    });
    expect(normalizeLeadPath("/mnt/c/proj/x", "C:/proj", { platform: "win32" })).toEqual({
      ok: true,
      path: "C:\\proj\\x",
    });
    // //unc and backslash paths are left alone.
    expect(normalizeLeadPath("//srv/share/x", "C:/proj", { platform: "win32" })).toEqual({
      ok: true,
      path: "\\\\srv\\share\\x",
    });
  });

  it("parses file:// URLs and refuses unparseable ones", () => {
    // fileURLToPath is host-OS-shaped: the URL form must match process.platform
    // (the same way the host tool resolves it).
    if (process.platform === "win32") {
      const windows = normalizeLeadPath("file:///C:/proj/openspec/a.md", "C:/proj", {
        platform: "win32",
      });
      expect(windows).toEqual({ ok: true, path: "C:\\proj\\openspec\\a.md" });
    } else {
      const posix = normalizeLeadPath("file:///proj/openspec/a.md", "/proj", { platform: "posix" });
      expect(posix).toEqual({ ok: true, path: "/proj/openspec/a.md" });
    }
    const bad = normalizeLeadPath("file://%zz", "/proj", { platform: "posix" });
    expect(bad.ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Boundary — real-fs POSIX cases (symlinks work in temp dirs)          */
/* ------------------------------------------------------------------ */

describe("isPathInsideOpenSpecTarget — POSIX real fs (design §5.2/§5.4)", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fusion-lead-access-"));
    mkdirSync(join(root, "openspec"), { recursive: true });
    writeFileSync(join(root, "openspec", "config.yaml"), "x");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const check = (input: string): OpenSpecBoundaryResult =>
    isPathInsideOpenSpecTarget(input, { projectRoot: root });

  it("allows inside, denies outside; new files ride the nearest existing ancestor", () => {
    expect(check(join(root, "openspec", "config.yaml")).allowed).toBe(true);
    expect(check(join(root, "openspec", "changes", "new", "deep.md")).allowed).toBe(true);
    expect(check(join(root, "src", "a.ts")).allowed).toBe(false);
    expect(check("src/a.ts").allowed).toBe(false);
  });

  it('denies the boundary directory itself (rel === "")', () => {
    expect(check(join(root, "openspec")).allowed).toBe(false);
  });

  it("allows ..notes as a name but denies lexical .. escapes", () => {
    expect(check(join(root, "openspec", "..notes.md")).allowed).toBe(true);
    expect(check(join(root, "openspec", "..", "secret.txt")).allowed).toBe(false);
  });

  it("denies a nested link that escapes the boundary", () => {
    const outside = mkdtempSync(join(tmpdir(), "fusion-escape-"));
    try {
      symlinkSync(outside, join(root, "openspec", "escape"));
      expect(check(join(root, "openspec", "escape", "x.md")).allowed).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("allows an outside link whose target sits inside the boundary", () => {
    symlinkSync(join(root, "openspec", "config.yaml"), join(root, "in-link"));
    expect(check(join(root, "in-link")).allowed).toBe(true);
  });

  it("denies a dangling link in the candidate and in an ancestor (F2)", () => {
    symlinkSync(join(root, "nope"), join(root, "openspec", "dang.md"));
    expect(check(join(root, "openspec", "dang.md")).allowed).toBe(false);
    symlinkSync(join(root, "nope-dir"), join(root, "openspec", "dangdir"));
    expect(check(join(root, "openspec", "dangdir", "new.md")).allowed).toBe(false);
  });

  it("denies everything when the openspec boundary itself is a dangling link", () => {
    rmSync(join(root, "openspec"), { recursive: true, force: true });
    symlinkSync(join(root, "nope"), join(root, "openspec"));
    const result = check(join(root, "openspec", "config.yaml"));
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toContain("висячая ссылка");
  });

  it("first launch: no openspec/ yet — the lexical join(realpath(root), openspec) is the base (§5.2.4)", () => {
    rmSync(join(root, "openspec"), { recursive: true, force: true });
    expect(check(join(root, "openspec", "fresh.md")).allowed).toBe(true);
    expect(check(join(root, "elsewhere.md")).allowed).toBe(false);
  });

  it("OQ-4: a top-level openspec link is followed; its realpath target becomes the boundary", () => {
    const target = mkdtempSync(join(tmpdir(), "fusion-ospec-target-"));
    try {
      rmSync(join(root, "openspec"), { recursive: true, force: true });
      symlinkSync(target, join(root, "openspec"));
      // Inside the real target — allowed even though it is outside the root.
      expect(check(join(target, "changes", "a.md")).allowed).toBe(true);
      expect(check(join(root, "openspec", "b.md")).allowed).toBe(true);
      // Beside the target — outside the boundary.
      expect(check(join(`${target}-sibling`, "c.md")).allowed).toBe(false);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ */
/* Boundary — win32 semantics via platform injection + memory fs        */
/* ------------------------------------------------------------------ */

/**
 * In-memory fs (case-insensitive like NTFS): `existing` answers lstat;
 * `real` maps to realpath targets — an entry that exists for lstat but has
 * no real target is a DANGLING link (realpath throws ENOENT, F2).
 */
function memoryFs(existing: string[], real: Record<string, string> = {}) {
  const clean = (p: string): string => p.replaceAll("\\", "/").replace(/\/+$/, "") || "/";
  const byLower = new Map<string, string>();
  for (const entry of existing) {
    const path = clean(entry);
    byLower.set(path.toLowerCase(), path);
  }
  const realLower = new Map<string, string>();
  for (const [from, to] of Object.entries(real)) {
    realLower.set(clean(from).toLowerCase(), clean(to));
  }
  const enoent = (): NodeJS.ErrnoException => {
    const error = new Error("ENOENT") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    return error;
  };
  return {
    lstatSync(p: string): unknown {
      if (!byLower.has(clean(p).toLowerCase())) throw enoent();
      return {};
    },
    realpathSync(p: string): string {
      const key = clean(p).toLowerCase();
      const stored = byLower.get(key);
      if (stored === undefined) throw enoent();
      const mapped = realLower.get(key) ?? stored;
      // A resolved target that does not exist itself = dangling link (F2).
      if (!byLower.has(mapped.toLowerCase())) throw enoent();
      return mapped;
    },
  };
}

describe("isPathInsideOpenSpecTarget — win32 semantics (platform injection, §11)", () => {
  const ROOT = "C:/proj";
  const OSPEC = "C:/proj/openspec";

  it("resolves case-insensitively and different separators (win32.relative)", () => {
    const fs = memoryFs([ROOT, OSPEC, `${OSPEC}/config.yaml`], {
      [ROOT]: ROOT,
      [OSPEC]: OSPEC,
      [`${OSPEC}/config.yaml`]: `${OSPEC}/config.yaml`,
    });
    const result = isPathInsideOpenSpecTarget("C:/PROJ/OPENSPEC/CHANGES/X.MD", {
      projectRoot: ROOT.toLowerCase(),
      platform: "win32",
      fs: fs as never,
    });
    expect(result.allowed).toBe(true);
  });

  it("denies another drive (relative returns an absolute path on win32)", () => {
    const fs = memoryFs(["D:/data", "D:/data/x.md"]);
    const result = isPathInsideOpenSpecTarget("D:/data/x.md", {
      projectRoot: ROOT,
      platform: "win32",
      fs: fs as never,
    });
    expect(result.allowed).toBe(false);
  });

  it("follows a junctioned openspec to its target (OQ-4) and denies outside it", () => {
    const target = "E:/docs-store";
    const fs = memoryFs([ROOT, OSPEC, target, `${target}/a.md`], {
      [ROOT]: ROOT,
      [OSPEC]: target, // openspec is a junction to another volume
      [target]: target,
      [`${target}/a.md`]: `${target}/a.md`,
    });
    const inside = isPathInsideOpenSpecTarget(`${target}/changes/a.md`, {
      projectRoot: ROOT,
      platform: "win32",
      fs: fs as never,
    });
    expect(inside.allowed).toBe(true);
    const beside = isPathInsideOpenSpecTarget("E:/elsewhere.md", {
      projectRoot: ROOT,
      platform: "win32",
      fs: fs as never,
    });
    expect(beside.allowed).toBe(false);
  });

  it("denies a dangling junction in an ancestor (fail-closed)", () => {
    // openspec/escape is a junction to a target that does not exist:
    // lstat sees it, realpath throws ENOENT (probe-verified Windows behavior).
    const dangling = memoryFs([ROOT, OSPEC, `${OSPEC}/escape`], {
      [ROOT]: ROOT,
      [OSPEC]: OSPEC,
      [`${OSPEC}/escape`]: "C:/proj/missing-target",
    });
    const result = isPathInsideOpenSpecTarget(`${OSPEC}/escape/x.md`, {
      projectRoot: ROOT,
      platform: "win32",
      fs: dangling as never,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toContain("висячая ссылка");
  });

  it("first launch on win32: lexical base without realpath", () => {
    const fs = memoryFs([ROOT], { [ROOT]: ROOT });
    const allowed = isPathInsideOpenSpecTarget("C:/proj/openspec/new.md", {
      projectRoot: ROOT,
      platform: "win32",
      fs: fs as never,
    });
    expect(allowed.allowed).toBe(true);
    const denied = isPathInsideOpenSpecTarget("C:/proj/src/a.ts", {
      projectRoot: ROOT,
      platform: "win32",
      fs: fs as never,
    });
    expect(denied.allowed).toBe(false);
  });

  it("checks the path the host will open: @-strip and shell-drive parity through the gate", () => {
    const fs = memoryFs([ROOT, OSPEC, `${OSPEC}/a.md`], {
      [ROOT]: ROOT,
      [OSPEC]: OSPEC,
      [`${OSPEC}/a.md`]: `${OSPEC}/a.md`,
    });
    const viaAt = isPathInsideOpenSpecTarget("@openspec/a.md", {
      projectRoot: ROOT,
      platform: "win32",
      fs: fs as never,
    });
    expect(viaAt.allowed).toBe(true);
    const viaShellDrive = isPathInsideOpenSpecTarget("/c/proj/openspec/a.md", {
      projectRoot: ROOT,
      platform: "win32",
      fs: fs as never,
    });
    expect(viaShellDrive.allowed).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Git classifier (fusion-git-gate; design §1, §2, §3.1–§3.6)          */
/* ------------------------------------------------------------------ */

/** True when the git gate allows the command. */
function gitAllowed(command: string): boolean {
  return isSingleGitInvocation(command).ok;
}

/** The rule row for one subcommand (design §2). */
function gitRule(sub: string) {
  const rule = GIT_RULES.find((r) => r.sub === sub);
  if (rule === undefined) throw new Error(`no GIT_RULES row for ${sub}`);
  return rule;
}

describe("isSingleGitInvocation: forbid rows generated from GIT_RULES (design §3.1)", () => {
  const forbidCases: string[] = [];
  for (const rule of GIT_RULES) {
    for (const element of rule.forbid ?? []) {
      forbidCases.push(`git ${rule.sub} ${element} origin main`);
      if (/^-[A-Za-z]$/.test(element)) {
        forbidCases.push(`git ${rule.sub} ${element}x origin main`);
      } else if (element.startsWith("--") && element !== "--") {
        const name = element.slice(2);
        forbidCases.push(`git ${rule.sub} ${element}=1 origin main`);
        for (let length = 3; length <= name.length; length += 1) {
          const prefix = `--${name.slice(0, length)}`;
          if (rule.allowLong?.includes(prefix)) continue;
          forbidCases.push(`git ${rule.sub} ${prefix} origin main`);
        }
      }
    }
  }

  it("generates a case for every forbid row", () => {
    expect(forbidCases.length).toBeGreaterThan(100);
  });

  it.each(forbidCases)("refuses %s", (command) => {
    expect(gitAllowed(command), command).toBe(false);
  });
});

describe("isSingleGitInvocation: forbidPrefix rows generated from GIT_RULES (design §3.2)", () => {
  const prefixCases = GIT_RULES.flatMap((rule) =>
    (rule.forbidPrefix ?? []).map((prefix) => `git ${rule.sub} origin ${prefix}main`),
  );

  it.each(prefixCases)("refuses %s", (command) => {
    expect(gitAllowed(command), command).toBe(false);
  });

  it.each([
    "git push origin +main",
    "git fetch origin +main:main",
    "git pull origin +main",
    "git push origin :main",
  ])("refuses the explicit refspec form %s", (command) => {
    expect(gitAllowed(command), command).toBe(false);
  });
});

describe("isSingleGitInvocation: refused subcommands entirely (design §2 step 5)", () => {
  const wholeCases = GIT_RULES.filter((rule) => rule.refuseAll === true).map(
    (rule) => `git ${rule.sub} origin main`,
  );

  it("covers rm, gc, prune, repack, maintenance, filter-branch, filter-repo, replace, alias, config", () => {
    expect(wholeCases.map((c) => c.split(" ")[1])).toEqual([
      "rm",
      "gc",
      "prune",
      "repack",
      "maintenance",
      "filter-branch",
      "filter-repo",
      "replace",
      "alias",
      "config",
    ]);
  });

  it.each(wholeCases)("refuses %s with any arguments", (command) => {
    expect(gitAllowed(command), command).toBe(false);
    expect(gitAllowed(command.replace("origin main", "")), command).toBe(false);
  });
});

describe("isSingleGitInvocation: requireAny needs a real flag (design §3.3)", () => {
  it.each([
    "git commit",
    "git commit -a",
    "git restore f",
    "git restore --staged --worktree f",
    "git restore --source --staged f",
    "git restore --source HEAD f",
    "git clean -f",
    "git clean -e -n",
    "git clean -fd",
    "git notes add",
    "git notes add -m list",
    "git notes --ref=x list",
  ])("refuses %s", (command) => {
    expect(gitAllowed(command), command).toBe(false);
  });

  it.each([
    "git commit -m x",
    "git commit -am x",
    "git commit --message=x",
    "git commit --all -m x",
    "git restore --staged f",
    "git restore -S f",
    "git restore --staged --source HEAD f",
    "git restore --source HEAD --staged f",
    "git clean -n",
    "git clean --dry-run",
    "git notes list",
    "git notes show",
  ])("allows %s", (command) => {
    expect(gitAllowed(command), command).toBe(true);
  });
});

describe("isSingleGitInvocation: values, clusters and = forms (design §3.4)", () => {
  it.each([
    "git commit -nm x",
    "git commit -F/tmp/m",
    "git commit -CHEAD",
    "git commit --file=m",
    "git commit --amen -m x",
    "git clean -fd",
    "git push -fu origin main",
    "git add -Ap",
    "git rebase --exec 'git reset --hard'",
    "git rebase -x cmd",
    "git submodule foreach 'x'",
    "git push --force-w origin main",
  ])("refuses %s", (command) => {
    expect(gitAllowed(command), command).toBe(false);
  });

  it.each(["git commit -mn", "git clean -fn"])(
    "allows %s: the letter n is a message or a clean flag, not -n",
    (command) => {
      expect(gitAllowed(command), command).toBe(true);
    },
  );

  it("a value consumed by -m never counts as a flag; a raw forbidden value refuses (closed, design §2 step 7)", () => {
    expect(gitAllowed("git commit -m x -n")).toBe(false);
    expect(gitAllowed("git commit -m x --amend")).toBe(false);
    expect(gitAllowed("git commit -m --amend")).toBe(false);
    expect(gitAllowed("git commit -m 'a b' -a")).toBe(true);
  });

  it("an abbreviated value-taking option consumes the next token as its value", () => {
    expect(gitAllowed("git clean --exc -n")).toBe(false);
  });

  it("the refusal reason of a rule is the rule's reason (design §2)", () => {
    expect(isSingleGitInvocation("git push -f origin main")).toEqual({
      ok: false,
      reason: gitRule("push").reason,
    });
    expect(isSingleGitInvocation("git reset --hard")).toEqual({
      ok: false,
      reason: gitRule("reset").reason,
    });
  });
});

describe("isSingleGitInvocation: false refusals that must stay allowed (design §3.5)", () => {
  it.each([
    "git status",
    "git log --oneline -5",
    "git log -p -1",
    "git diff HEAD",
    "git diff --cached",
    "git show HEAD -p",
    "git add extensions/a.ts",
    "git add .",
    "git add -A",
    'git commit -m "feat: x"',
    "git commit -a -m x",
    "git commit -m x -- path",
    "git push origin main",
    "git push -u origin main",
    "git push --set-upstream origin main",
    "git pull --rebase",
    "git pull --ff-only",
    "git fetch origin",
    "git checkout -b feat",
    "git switch -c feat",
    "git stash push -m x",
    "git stash list",
    "git stash apply",
    "git remote -v",
    "git restore --staged f",
    "git branch",
    "git worktree list",
    "git merge --no-edit main",
  ])("allows %s", (command) => {
    expect(gitAllowed(command), command).toBe(true);
  });
});

describe("isSingleGitInvocation: shell syntax and global options (design §3.6, FR-001)", () => {
  it.each([
    "git status; rm -rf x",
    "git status $(id)",
    "git status > f",
    "git status && x",
    "git -C /tmp status",
    "git -c core.pager=x log",
    "git --git-dir=x status",
    "git --work-tree=x status",
    'git show "HEAD~1" ~',
    "git log *",
    "git status `id`",
    "git status\nrm -rf x",
  ])("refuses %s", (command) => {
    expect(gitAllowed(command), command).toBe(false);
  });

  it("names the reason of each FR-001 refusal", () => {
    expect(isSingleGitInvocation("git -C /tmp status")).toEqual({
      ok: false,
      reason: "глобальные опции git до подкоманды запрещены",
    });
    expect(isSingleGitInvocation("ls -la")).toEqual({ ok: false, reason: "первый токен не git" });
  });
});

describe("classifyBashCommand: the git branch (design §1, §2)", () => {
  it("the first word git takes the git branch, and allowed forms pass it", () => {
    expect(bashOf("git status")).toEqual({ branch: "git", ok: true });
    expect(bashOf("git commit -m 'x'")).toEqual({ branch: "git", ok: true });
  });

  it("a rule refusal keeps the git branch with the rule reason", () => {
    expect(bashOf("git push --force origin main")).toEqual({
      branch: "git",
      ok: false,
      reason: gitRule("push").reason,
    });
  });

  it("a chain that starts with git keeps the git branch and the tokenizer reason", () => {
    expect(bashOf("git status; rm -rf x")).toEqual({
      branch: "git",
      ok: false,
      reason: 'метасимвол ";" вне кавычек',
    });
  });

  it("the other first words keep the perl and bd branches unchanged", () => {
    expect(classifyBashCommand("perl -e 'x'").branch).toBe("perl");
    expect(classifyBashCommand("bd list").branch).toBe("bd");
    expect(bashOf("echo git status")).toEqual({
      branch: "other",
      ok: false,
      reason: UNIFIED_REASON,
    });
  });
});

/* ------------------------------------------------------------------ */
/* Pinned FR forms (static, NOT derived from GIT_RULES)                */
/* ------------------------------------------------------------------ */

describe("pinned FR forms (static, не из GIT_RULES)", () => {
  // Literal list of refused commands from FR-003 / FR-004 / FR-005
  // (openspec/changes/fusion-git-gate/requirements.md). Deliberately NOT built from
  // GIT_RULES: deleting a table row (for example `-B` from the checkout forbid)
  // must fail here, not silently remove its generated case.
  // Commands with `{`, `~` are quoted so the rule (not the expansion check) refuses them.
  const pinnedRefusals = [
    // push (FR-003, FR-004, FR-005)
    "git push origin main --force",
    "git push --force-with-lease origin main",
    "git push origin +main",
    "git push origin main -f",
    "git push origin :main",
    "git push --delete origin main",
    "git push --mirror origin",
    "git push --prune origin",
    "git push --no-verify origin main",
    "git push --receive-pack=x origin main",
    // fetch / pull
    "git fetch --prune origin",
    "git fetch origin +main:main",
    "git pull --prune origin main",
    // reset
    "git reset --hard",
    "git reset --merge",
    "git reset --keep HEAD",
    // checkout
    "git checkout -f main",
    "git checkout -B feat",
    "git checkout --discard-changes main",
    "git checkout -- f",
    // switch
    "git switch -C feat",
    "git switch -f main",
    // restore
    "git restore f",
    "git restore --worktree --staged f",
    "git restore -W f",
    // clean
    "git clean -fd",
    "git clean -f",
    "git clean -i",
    // stash
    "git stash drop",
    "git stash clear",
    "git stash pop",
    // worktree
    "git worktree remove x",
    "git worktree prune",
    "git worktree add -f x",
    // submodule
    "git submodule foreach x",
    "git submodule update --force",
    // branch / tag / remote / refs
    "git branch -D x",
    "git branch -d x",
    "git branch -M x y",
    "git branch -C x y",
    "git tag -d v1",
    "git tag -f v1",
    "git remote remove x",
    "git remote rename a b",
    "git remote set-url x y",
    "git symbolic-ref -d HEAD",
    "git update-ref -d refs/x",
    "git reflog expire --all",
    "git reflog delete 'HEAD@{0}'",
    // rebase
    "git rebase -i 'HEAD~2'",
    "git rebase --exec 'x' main",
    "git rebase -x x",
    // interactive / patch forms
    "git add -i",
    "git add -p",
    "git add -e f",
    "git checkout -p",
    "git restore -p f",
    "git stash -p",
    "git reset -p",
    // commit (hook bypass, amend, editor, foreign message sources, no -m)
    "git commit --amend -m x",
    "git commit -n -m x",
    "git commit --no-verify -m x",
    "git commit -m x --allow-empty",
    "git commit -F m",
    "git commit -C HEAD",
    "git commit -m x -e",
    "git commit -p",
    "git commit -a",
    "git commit -m x --edit",
    "git commit",
    // notes
    "git notes add -m x",
    "git notes remove HEAD",
    // refused subcommands entirely
    "git rm f",
    "git config x y",
    "git alias x",
    "git gc",
    "git filter-branch x",
    "git replace x y",
    "git maintenance run",
  ];

  it("pins at least one case per FR-003/FR-004/FR-005 family", () => {
    expect(pinnedRefusals.length).toBeGreaterThanOrEqual(79);
  });

  it.each(pinnedRefusals)("refuses %s", (command) => {
    expect(gitAllowed(command), command).toBe(false);
  });
});
