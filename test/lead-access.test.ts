import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isPathInsideOpenSpecTarget,
  isSinglePerlInvocation,
  normalizeLeadPath,
  type OpenSpecBoundaryResult,
} from "../extensions/pi-fusion/lead-access.ts";

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
