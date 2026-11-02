/**
 * Pure helpers behind the lead's two exceptions (design §5, §6): the
 * `openspec/` realpath boundary for `write`/`edit` (FR-004) and the
 * single-perl-invocation classifier for `bash` (FR-005). No I/O decisions
 * live here except the injected `fs` — the gate (restrictions.ts) owns the
 * event plumbing and the settings read.
 *
 * Boundary semantics (design §5.2, OQ-4 approved 2026-11-01):
 *  - the input is normalised EXACTLY as the host normalises it before
 *    opening (resolveToCwd: Unicode spaces, leading `@`, win32 shell-drive
 *    forms, `~`, `file://` — parity B2; checking the raw string would check
 *    a path the host never opens);
 *  - the boundary is `join(realpath(root), "openspec")`; when `openspec` is
 *    an existing link, its realpath TARGET becomes the boundary, even
 *    outside the project root; when it does not exist yet (first launch),
 *    the comparison base is the lexical path (§5.2.4) — comparing against
 *    bare `realpath(root)` would be fail-open;
 *  - existence is decided by `lstat`; every existing component (candidate,
 *    ancestors, boundary) is resolved with `realpathSync` — any throw,
 *    including a dangling link anywhere, denies (fail-closed, F2);
 *  - comparison is `path.relative` with a component check: the first
 *    segment being `..` denies, the name `..notes` does not.
 *
 * Not guaranteed (design §5.5): TOCTOU races, hardlink aliases, host-side
 * effects. This is a verifiable boundary, NOT a sandbox.
 */
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import * as pathPosix from "node:path/posix";
import * as pathWin32 from "node:path/win32";
import { fileURLToPath } from "node:url";

/** The path module shape used for splitting/joining/relativity. */
export type PathModule = typeof pathPosix;

export function pathModuleFor(platform: NodeJS.Platform | "posix" | "win32"): PathModule {
  return platform === "win32" ? pathWin32 : pathPosix;
}

export interface NormalizeOptions {
  /** Platform semantics; defaults to `process.platform`. */
  platform?: NodeJS.Platform | "posix" | "win32";
  /** Home directory for `~` expansion; defaults to `os.homedir()`. */
  home?: string;
}

export type NormalizeResult = { ok: true; path: string } | { ok: false; reason: string };

/**
 * The host's exact normalisation pipeline for write/edit inputs
 * (`resolveToCwd` = `resolvePath(input, cwd, { normalizeUnicodeSpaces,
 * stripAtPrefix })`, dist/utils/paths.js `normalizePath`): Unicode spaces,
 * leading `@`, win32 shell-drive forms, `~` expansion, `file://` — then
 * resolve against `baseDir`. Parity B2: the gate checks the path the host
 * will open, and each step is pinned by a parity test (design §11).
 */
export function normalizeLeadPath(
  input: string,
  baseDir: string,
  options: NormalizeOptions = {},
): NormalizeResult {
  const pm = pathModuleFor(options.platform ?? process.platform);
  const isWin32 = pm === pathWin32;
  const home = options.home ?? homedir();

  try {
    // normalizePath(input, { normalizeUnicodeSpaces: true, stripAtPrefix: true })
    // (no trim — resolveToCwd does not trim the tool input)
    let normalized = input;
    normalized = normalized.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
    if (normalized.startsWith("@")) normalized = normalized.slice(1);
    if (isWin32) normalized = normalizeWindowsShellPath(normalized);
    // expandTilde defaults to true
    if (normalized === "~") normalized = home;
    else if (normalized.startsWith("~/") || (isWin32 && normalized.startsWith("~\\"))) {
      normalized = pm.join(home, normalized.slice(2));
    }
    if (/^file:\/\//.test(normalized)) {
      normalized = fileURLToPath(normalized); // unparseable file:// throws → caught below
    }
    // resolvePath: the base is normalised too (no unicode/at options).
    let base = baseDir;
    if (isWin32) base = normalizeWindowsShellPath(base);
    if (base === "~") base = home;
    return {
      ok: true,
      path: pm.isAbsolute(normalized) ? pm.resolve(normalized) : pm.resolve(base, normalized),
    };
  } catch (error) {
    return {
      ok: false,
      reason: `путь не удалось нормализовать как хост (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

/** `normalizeWindowsShellPath` (dist/utils/paths.js): /c/…, /mnt/c/…, /cygdrive/c/… → C:\…. */
function normalizeWindowsShellPath(filePath: string): string {
  if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) {
    return filePath;
  }
  const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(filePath);
  if (!match?.[1]) return filePath;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${match[1].toUpperCase()}:\\${suffix ?? ""}`;
}

export interface OpenSpecBoundaryOptions {
  /** The session root (ctx.cwd of the main session). */
  projectRoot: string;
  platform?: NodeJS.Platform | "posix" | "win32";
  home?: string;
  /** Injectable fs for tests; defaults to the real one. */
  fs?: { lstatSync: typeof lstatSync; realpathSync: typeof realpathSync };
}

export type OpenSpecBoundaryResult =
  | { allowed: true; candidateReal: string; boundaryReal: string }
  | { allowed: false; reason: string };

interface FsLike {
  lstatSync: typeof lstatSync;
  realpathSync: typeof realpathSync;
}

/**
 * Resolves the candidate to its real path walking from the root side: every
 * EXISTING component (lstat) is realpath'ed — a throw anywhere (dangling
 * link/junction in the candidate, an ancestor, or the boundary) denies;
 * missing components carry the lexical tail from the nearest existing
 * ancestor (§5.2.3).
 */
function resolveCandidateReal(
  candidate: string,
  pm: PathModule,
  fs: FsLike,
): { ok: true; real: string } | { ok: false; reason: string } {
  const absolute = pm.resolve(candidate);
  // Split into root + segments in a platform-correct way.
  const parsed = isWin32Module(pm) ? pathWin32.parse(absolute) : pathPosix.parse(absolute);
  const parts = absolute
    .slice(parsed.root.length)
    .split(/[\\/]/)
    .filter((segment) => segment.length > 0 && segment !== ".");

  let current = parsed.root;
  let lexical = false;
  for (const part of parts) {
    const probe = pm.join(current, part);
    if (lexical) {
      // Under a missing ancestor nothing can exist; carry the lexical tail.
      current = probe;
      continue;
    }
    try {
      fs.lstatSync(probe);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // A plain missing component: a new file or directory (§5.2.3).
        lexical = true;
        current = probe;
        continue;
      }
      return {
        ok: false,
        reason: `проверка пути не удалась (${error instanceof Error ? error.message : String(error)})`,
      };
    }
    try {
      current = fs.realpathSync(probe);
    } catch {
      // Exists by lstat but cannot be resolved: a dangling link/junction in
      // the candidate path — fail-closed (F2, §5.2.3).
      return { ok: false, reason: `висячая ссылка в пути: ${probe} — запись запрещена` };
    }
  }
  return { ok: true, real: current };
}

function isWin32Module(pm: PathModule): boolean {
  return pm === pathWin32;
}

/**
 * The openspec/ boundary decision (design §5.2). Allowed only when the
 * candidate's canonical path sits strictly inside the boundary's canonical
 * path (`..`-free, non-empty, non-absolute relative tail). The boundary
 * follows a symlinked/junctioned `openspec` to its real target (OQ-4);
 * when `openspec` does not exist yet, the lexical `join(realpath(root),
 * "openspec")` is the comparison base (first launch, §5.2.4).
 */
export function isPathInsideOpenSpecTarget(
  input: string,
  options: OpenSpecBoundaryOptions,
): OpenSpecBoundaryResult {
  const fs: FsLike = options.fs ?? { lstatSync, realpathSync };
  const pm = pathModuleFor(options.platform ?? process.platform);

  const normalized = normalizeLeadPath(input, options.projectRoot, {
    platform: options.platform,
    home: options.home,
  });
  if (!normalized.ok) return { allowed: false, reason: normalized.reason };

  let rootReal: string;
  try {
    rootReal = fs.realpathSync(pm.resolve(options.projectRoot));
  } catch (error) {
    return {
      allowed: false,
      reason: `корень проекта не читается (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  const boundaryLexical = pm.join(rootReal, "openspec");

  let boundaryReal: string;
  let boundaryExists = true;
  try {
    fs.lstatSync(boundaryLexical);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      boundaryExists = false; // first launch: the lexical base is the boundary (§5.2.4)
    } else {
      return {
        allowed: false,
        reason: `каталог openspec не читается (${error instanceof Error ? error.message : String(error)})`,
      };
    }
  }
  if (boundaryExists) {
    try {
      boundaryReal = fs.realpathSync(boundaryLexical);
    } catch {
      // The boundary itself is a dangling link — fail-closed (OQ-4 does not
      // allow dangling targets).
      return { allowed: false, reason: "каталог openspec — висячая ссылка; запись запрещена" };
    }
  } else {
    boundaryReal = boundaryLexical;
  }

  const candidate = resolveCandidateReal(normalized.path, pm, fs);
  if (!candidate.ok) return { allowed: false, reason: candidate.reason };

  const rel = pm.relative(boundaryReal, candidate.real);
  const firstSegment = rel.split(/[\\/]/)[0] ?? "";
  if (rel === "" || firstSegment === ".." || pm.isAbsolute(rel)) {
    return {
      allowed: false,
      reason:
        "вне каталога документации OpenSpec код пишут воркеры; исключение лида ограничено целевым каталогом openspec/",
    };
  }
  return { allowed: true, candidateReal: candidate.real, boundaryReal };
}

/** The verdict of one command classifier: allowed, or the reason it is not. */
export type CommandVerdict = { ok: true } | { ok: false; reason: string };

/** The perl classifier's verdict (design §6.1). */
export type PerlVerdict = CommandVerdict;

/** The bd classifier's verdict (design §6.5.2). */
export type BdVerdict = CommandVerdict;

/** One argv word after the shared tokenizer: the value with quotes removed, and the first unquoted expansion character in it (design §6.1.7). */
export interface ShellToken {
  value: string;
  expansion?: string;
}

/** The shared tokenizer's result. `firstWord` is set only when the first word was read completely before the error (design §6.5.1). */
export type TokenizeResult =
  | { ok: true; tokens: ShellToken[] }
  | { ok: false; reason: string; firstWord?: string };

/** The reason every classifier gives for an unquoted `#` outside quotes (design §6.1.3, B-NEW). */
export const HASH_REASON = 'неквотированный "#" вне кавычек (комментарий оболочки)';

/** Unquoted characters bash expands before the program runs (glob, brace, tilde, history; design §6.1.7). */
const EXPANSION_CHARS = "*?[]{}~!";

/** Unquoted characters that end a word and join or redirect commands (design §6.1 п. 3). */
const WORD_ENDING_METACHARS = ";|&()<>";

/** Unquoted characters bash substitutes inside a word: refused, and they do not end the word. */
const SUBSTITUTION_CHARS = "`$";

/**
 * The shared tokenizer of the perl and bd classifiers (design §6.1, §6.1.7,
 * §6.5.2). Left to right, the first error wins; each refusal text is the rev.3
 * text, plus the `#` refusal (B-NEW):
 *  - only a space and a tab separate words, and no trim is applied: `\v`, `\f`
 *    and NBSP are ordinary word characters;
 *  - `'…'` is a literal, newlines included; `"…"` refuses `$`, backtick and
 *    backslash (bash expands them, §6.1.2);
 *  - outside quotes a line break, CR, `#`, `; | & ( ) < >`, `` ` `` `$` and `\`
 *    refuse; every unquoted `* ? [ ] { } ~ !` is flagged on its token;
 *  - an unclosed quote refuses.
 */
export function tokenizeShellCommand(command: string): TokenizeResult {
  const tokens: ShellToken[] = [];
  let value = "";
  let expansion: string | undefined;
  let haveToken = false;

  const endToken = (): void => {
    if (haveToken) tokens.push(expansion === undefined ? { value } : { value, expansion });
    value = "";
    expansion = undefined;
    haveToken = false;
  };

  // The first word is known only when it was read completely: a closed token
  // already exists, or the error is a word-ending character right after it.
  const refuse = (reason: string, endsWord: boolean): TokenizeResult => {
    const closed = tokens[0];
    if (closed !== undefined) return { ok: false, reason, firstWord: closed.value };
    if (endsWord && haveToken) return { ok: false, reason, firstWord: value };
    return { ok: false, reason };
  };

  let i = 0;
  while (i < command.length) {
    const ch = command[i] as string;
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return refuse("незакрытая одинарная кавычка", false);
      value += command.slice(i + 1, end);
      haveToken = true;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      i += 1;
      let closed = false;
      while (i < command.length) {
        const inner = command[i] as string;
        if (inner === "\\")
          return refuse("backslash в двойных кавычках (эскейп не поддерживается)", false);
        if (inner === "$") return refuse("$ в двойных кавычках (подстановка shell)", false);
        if (inner === "`") return refuse("backtick в двойных кавычках", false);
        if (inner === '"') {
          closed = true;
          i += 1;
          break;
        }
        value += inner;
        i += 1;
      }
      if (!closed) return refuse("незакрытая двойная кавычка", false);
      haveToken = true;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      return refuse("перевод строки вне кавычек (разделитель команд)", true);
    }
    if (ch === " " || ch === "\t") {
      endToken();
      i += 1;
      continue;
    }
    if (ch === "#") return refuse(HASH_REASON, false);
    if (WORD_ENDING_METACHARS.includes(ch)) {
      return refuse(`метасимвол ${JSON.stringify(ch)} вне кавычек`, true);
    }
    if (SUBSTITUTION_CHARS.includes(ch)) {
      return refuse(`метасимвол ${JSON.stringify(ch)} вне кавычек`, false);
    }
    if (ch === "\\")
      return refuse("backslash вне кавычек (экранирование не поддерживается)", false);
    if (expansion === undefined && EXPANSION_CHARS.includes(ch)) expansion = ch;
    value += ch;
    haveToken = true;
    i += 1;
  }
  endToken();
  return { ok: true, tokens };
}

/**
 * The single-perl-invocation classifier (design §6.1): exactly one `perl` call
 * as the FIRST word, POSIX-like quoting, no shell interpreter in the chain.
 * Conservative by construction (TD-07): every refusal of the shared tokenizer
 * applies (§6.1.2, §6.1.3), and the first word must be exactly `perl`
 * (`perl5`, `/usr/bin/perl`, `env perl` all refuse; FR-005). Unquoted
 * expansion characters are NOT refused for perl (§6.1.7, accepted divergence).
 */
export function isSinglePerlInvocation(command: string): PerlVerdict {
  const tokenized = tokenizeShellCommand(command);
  if (!tokenized.ok) return { ok: false, reason: tokenized.reason };
  const first = tokenized.tokens[0];
  if (first === undefined) return { ok: false, reason: "пустая команда" };
  if (first.value !== "perl") return { ok: false, reason: "первый токен не perl" };
  return { ok: true };
}

/** The bd subcommands the lead may run (design §6.5.2). */
export const BD_SUBCOMMANDS: readonly string[] = [
  "create",
  "show",
  "list",
  "ready",
  "update",
  "close",
];

/**
 * The single-bd-invocation classifier (design §6.5.2). On top of the shared
 * tokenizer: argv[0] is exactly `bd`; argv[1] is exactly one subcommand from
 * BD_SUBCOMMANDS (case-sensitive, quotes removed; a flag before it refuses);
 * and no token carries an unquoted expansion character. Arguments after the
 * subcommand are not interpreted further (§6.5.4).
 */
export function isSingleBdInvocation(command: string): BdVerdict {
  const tokenized = tokenizeShellCommand(command);
  if (!tokenized.ok) return { ok: false, reason: tokenized.reason };
  const [head, subcommand] = tokenized.tokens;
  if (head === undefined) return { ok: false, reason: "пустая команда" };
  if (head.value !== "bd") return { ok: false, reason: "первый токен не bd" };
  if (subcommand === undefined || !BD_SUBCOMMANDS.includes(subcommand.value)) {
    return {
      ok: false,
      reason: "argv[1] — не подкоманда из списка create/show/list/ready/update/close",
    };
  }
  for (const token of tokenized.tokens) {
    if (token.expansion !== undefined) {
      return {
        ok: false,
        reason: `неквотированный символ раскрытия оболочки ${JSON.stringify(token.expansion)}`,
      };
    }
  }
  return { ok: true };
}

/** The git classifier's verdict (design §2): allowed, or the reason it is refused. */
export type GitVerdict = CommandVerdict;

/**
 * One row of the git denylist (design §2, FR-002..FR-005). Matching is case-sensitive.
 * The denylist is closed: a subcommand or form without a matching row is allowed.
 */
export interface GitRule {
  /** The subcommand the row covers (argv[1]). */
  readonly sub: string;
  /** The refusal reason every match of this row carries. */
  readonly reason: string;
  /** The whole subcommand is refused, whatever its arguments (design §2 step 5). */
  readonly refuseAll?: true;
  /** Short letters (`-f`), long names (`--force`) and bare words (`drop`) that refuse. */
  readonly forbid?: readonly string[];
  /** Raw-token prefixes that refuse (`+` refspec, `:` deletion). */
  readonly forbidPrefix?: readonly string[];
  /** At least one of these FLAGS must be present; values and arguments after `--` do not count. */
  readonly requireAny?: readonly string[];
  /** argv[2] must be one of these words (the `notes` action). */
  readonly requireAction?: readonly string[];
  /** Options that consume the next token, or the rest of their cluster, as their value. */
  readonly valueOpts?: readonly string[];
  /** Long names exempt from prefix matching against `forbid` (`--all` vs `--allow-empty`). */
  readonly allowLong?: readonly string[];
}

const GIT_WHOLE_REASON = (sub: string, why: string): string => `${sub} запрещён целиком: ${why}`;

/** The git denylist (design §2). Rows are normative; tests are generated from them (design §3). */
export const GIT_RULES: readonly GitRule[] = [
  {
    sub: "push",
    reason: "push с force, удалением ref, +refspec, обходом хуков или удалённой командой запрещён",
    forbid: [
      "-f",
      "--force",
      "--force-with-lease",
      "--force-if-includes",
      "-d",
      "--delete",
      "--mirror",
      "--prune",
      "--all",
      "--no-verify",
      "-n",
      "--receive-pack",
      "--exec",
    ],
    forbidPrefix: ["+", ":"],
    valueOpts: ["--receive-pack", "--exec"],
  },
  {
    sub: "pull",
    reason: "pull с force, prune или +refspec запрещён",
    forbid: ["-f", "--force", "-p", "--prune", "--prune-tags", "--upload-pack"],
    forbidPrefix: ["+"],
    valueOpts: ["--upload-pack"],
  },
  {
    sub: "fetch",
    reason: "fetch с force, prune или +refspec запрещён",
    forbid: ["-f", "--force", "-p", "--prune", "--prune-tags", "--upload-pack"],
    forbidPrefix: ["+"],
    valueOpts: ["--upload-pack"],
  },
  {
    sub: "reset",
    reason: "reset --hard, --merge, --keep и интерактивный -p запрещены",
    forbid: ["--hard", "--merge", "--keep", "-p", "--patch"],
  },
  {
    sub: "checkout",
    reason: "checkout с force, -B, --discard-changes, путём (--) или -p запрещён",
    forbid: ["-f", "--force", "-B", "--discard-changes", "--", "-p", "--patch"],
    valueOpts: ["-b", "-B", "-c", "-C", "--orphan"],
  },
  {
    sub: "switch",
    reason: "switch с force, -C или --discard-changes запрещён",
    forbid: ["-f", "--force", "-C", "--force-create", "--discard-changes"],
    valueOpts: ["-c", "-C", "--create", "--force-create"],
  },
  {
    sub: "restore",
    reason: "restore без --staged или с --worktree и -p запрещён",
    forbid: ["--worktree", "-W", "-p", "--patch"],
    requireAny: ["--staged", "-S"],
    valueOpts: ["-s", "--source"],
  },
  {
    sub: "clean",
    reason: "clean без -n/--dry-run или с -i запрещён",
    forbid: ["-i", "--interactive"],
    requireAny: ["-n", "--dry-run"],
    valueOpts: ["-e", "--exclude"],
  },
  {
    sub: "stash",
    reason: "stash drop, clear, pop и -p запрещены",
    forbid: ["drop", "clear", "pop", "-p", "--patch"],
  },
  {
    sub: "worktree",
    reason: "worktree remove, prune и force запрещены",
    forbid: ["remove", "prune", "-f", "--force"],
  },
  {
    sub: "submodule",
    reason: "submodule с -f/--force и foreach запрещён",
    forbid: ["-f", "--force", "foreach"],
  },
  {
    sub: "branch",
    reason: "удаление и принудительное изменение веток запрещены",
    forbid: ["-d", "-D", "--delete", "-f", "--force", "-M", "-C"],
  },
  {
    sub: "tag",
    reason: "удаление и force тегов запрещены",
    forbid: ["-d", "--delete", "-f", "--force"],
  },
  {
    sub: "remote",
    reason: "remote remove, rm, set-url, prune и rename запрещены",
    forbid: ["remove", "rm", "set-url", "prune", "rename"],
  },
  {
    sub: "symbolic-ref",
    reason: "удаление symbolic-ref запрещено",
    forbid: ["-d", "--delete"],
  },
  { sub: "update-ref", reason: "update-ref -d запрещён", forbid: ["-d"] },
  {
    sub: "reflog",
    reason: "reflog delete и expire запрещены",
    forbid: ["delete", "expire"],
  },
  {
    sub: "notes",
    reason: "notes: разрешены только list и show",
    requireAction: ["list", "show"],
  },
  {
    sub: "commit",
    reason:
      "commit без -m/--message или с редактором, обходом хуков, амендом или чужим сообщением запрещён",
    forbid: [
      "--amend",
      "--no-verify",
      "-n",
      "-e",
      "--edit",
      "-p",
      "--patch",
      "--interactive",
      "-F",
      "--file",
      "-C",
      "-c",
      "--reuse-message",
      "--reedit-message",
      "--fixup",
      "--squash",
      "--template",
      "-t",
      "--allow-empty",
      "--allow-empty-message",
    ],
    requireAny: ["-m", "--message"],
    valueOpts: [
      "-m",
      "-F",
      "-C",
      "-c",
      "-t",
      "--message",
      "--file",
      "--reuse-message",
      "--reedit-message",
      "--fixup",
      "--squash",
      "--template",
      "--author",
      "--date",
    ],
    allowLong: ["--all"],
  },
  {
    sub: "rebase",
    reason: "rebase -i, -x и --exec запрещён",
    forbid: ["-i", "--interactive", "-x", "--exec"],
    valueOpts: ["-x", "--exec"],
  },
  {
    sub: "add",
    reason: "add -i, -p и -e (интерактивный режим) запрещён",
    forbid: ["-i", "--interactive", "-p", "--patch", "-e", "--edit"],
  },
  {
    sub: "rm",
    refuseAll: true,
    reason: GIT_WHOLE_REASON("rm", "удаляет файлы из индекса и дерева"),
  },
  {
    sub: "gc",
    refuseAll: true,
    reason: GIT_WHOLE_REASON("gc", "очищает объекты и reflog"),
  },
  {
    sub: "prune",
    refuseAll: true,
    reason: GIT_WHOLE_REASON("prune", "удаляет объекты"),
  },
  {
    sub: "repack",
    refuseAll: true,
    reason: GIT_WHOLE_REASON("repack", "переупаковывает и очищает объекты"),
  },
  {
    sub: "maintenance",
    refuseAll: true,
    reason: GIT_WHOLE_REASON("maintenance", "фоновая очистка репозитория"),
  },
  {
    sub: "filter-branch",
    refuseAll: true,
    reason: GIT_WHOLE_REASON("filter-branch", "переписывает историю"),
  },
  {
    sub: "filter-repo",
    refuseAll: true,
    reason: GIT_WHOLE_REASON("filter-repo", "переписывает историю"),
  },
  {
    sub: "replace",
    refuseAll: true,
    reason: GIT_WHOLE_REASON("replace", "подменяет объекты истории"),
  },
  {
    sub: "alias",
    refuseAll: true,
    reason: GIT_WHOLE_REASON("alias", "обходит правила через собственные имена"),
  },
  {
    sub: "config",
    refuseAll: true,
    reason: GIT_WHOLE_REASON("config", "задаёт хуки и оболочку, которыми обходятся правила"),
  },
];

/**
 * Whether a token (raw or canonical flag) hits a row's `forbid` or `forbidPrefix`
 * (design §2 step 7). A long name matches by exact name or by prefix, the `=`
 * value is not part of the name, and an `allowLong` name is matched exactly only.
 */
function matchesForbid(token: string, rule: GitRule): boolean {
  const forbid = rule.forbid ?? [];
  if (forbid.includes(token)) return true;
  if ((rule.forbidPrefix ?? []).some((prefix) => token.startsWith(prefix))) return true;
  if (!token.startsWith("--")) return false;
  const eq = token.indexOf("=");
  const name = token.slice(2, eq === -1 ? undefined : eq);
  if (name === "" || (rule.allowLong ?? []).includes(`--${name}`)) return false;
  return forbid.some((entry) => entry.startsWith(`--${name}`));
}

/**
 * The canonical flags of argv[2..] (design §2 step 6). A value consumed by a
 * value-taking option is not a flag; a short cluster is read letter by letter
 * until a value-taking letter; `--name=value` is the flag `--name`; a long name
 * that is a prefix of a value-taking long option takes the value too (closed:
 * it can only hide a flag, never invent one); tokens after `--` are positional.
 */
function canonicalFlags(words: readonly string[], rule: GitRule): string[] {
  const valueOpts = rule.valueOpts ?? [];
  const longValueOpts = valueOpts.filter((opt) => opt.startsWith("--"));
  const flags: string[] = [];
  let expectValue = false;
  let positional = false;
  for (const word of words) {
    if (expectValue) {
      expectValue = false;
      continue;
    }
    if (positional) continue;
    if (word === "--") {
      flags.push(word);
      positional = true;
      continue;
    }
    if (word.startsWith("--")) {
      const eq = word.indexOf("=");
      const name = eq === -1 ? word : word.slice(0, eq);
      flags.push(name);
      if (eq === -1 && name.length > 2 && longValueOpts.some((opt) => opt.startsWith(name))) {
        expectValue = true;
      }
      continue;
    }
    if (word.length > 1 && word.startsWith("-")) {
      for (let i = 1; i < word.length; i += 1) {
        const letter = `-${word[i]}`;
        flags.push(letter);
        if (valueOpts.includes(letter)) {
          expectValue = i === word.length - 1;
          break;
        }
      }
    }
  }
  return flags;
}

/**
 * The single-git-invocation classifier (design §2, FR-001..FR-005). On top of the
 * shared tokenizer: argv[0] is exactly `git`; argv[1] is not a global option; no
 * token carries an unquoted expansion character; a subcommand without a GIT_RULES
 * row is allowed (FR-002); a row refuses by its forbidden words, its prefixes and
 * its required flags, after token canonicalization.
 */
export function isSingleGitInvocation(command: string): GitVerdict {
  const tokenized = tokenizeShellCommand(command);
  if (!tokenized.ok) return { ok: false, reason: tokenized.reason };
  const argv = tokenized.tokens;
  const [head, subcommand] = argv;
  if (head === undefined) return { ok: false, reason: "пустая команда" };
  if (head.value !== "git") return { ok: false, reason: "первый токен не git" };
  if (subcommand?.value.startsWith("-")) {
    return { ok: false, reason: "глобальные опции git до подкоманды запрещены" };
  }
  for (const token of argv) {
    if (token.expansion !== undefined) {
      return {
        ok: false,
        reason: `неквотированный символ раскрытия оболочки ${JSON.stringify(token.expansion)}`,
      };
    }
  }
  if (subcommand === undefined) return { ok: true };
  const rule = GIT_RULES.find((row) => row.sub === subcommand.value);
  if (rule === undefined) return { ok: true };
  if (rule.refuseAll === true) return { ok: false, reason: rule.reason };

  const words = argv.slice(2).map((token) => token.value);
  if (rule.requireAction !== undefined && !rule.requireAction.includes(words[0] ?? "")) {
    return { ok: false, reason: rule.reason };
  }
  if (words.some((word) => matchesForbid(word, rule))) return { ok: false, reason: rule.reason };
  const flags = canonicalFlags(words, rule);
  if (flags.some((flag) => matchesForbid(flag, rule))) return { ok: false, reason: rule.reason };
  if (rule.requireAny !== undefined && !flags.some((flag) => rule.requireAny?.includes(flag))) {
    return { ok: false, reason: rule.reason };
  }
  return { ok: true };
}

/** The bash branch the gate takes (design §6.5.1, §2): perl, bd, git, or none. */
export type BashClassification =
  | { branch: "perl"; verdict: PerlVerdict }
  | { branch: "bd"; verdict: BdVerdict }
  | { branch: "git"; verdict: GitVerdict }
  | { branch: "other"; reason: string };

/**
 * Chooses the branch by the first word with quotes removed (design §6.5.1).
 * The word is argv[0] when the line tokenizes; otherwise the first word read
 * completely before the tokenizer's error. Neither perl nor bd: the merged
 * formula, whose reason is the tokenizer's when the first word is not read.
 */
export function classifyBashCommand(command: string): BashClassification {
  const tokenized = tokenizeShellCommand(command);
  const word = tokenized.ok ? tokenized.tokens[0]?.value : tokenized.firstWord;
  if (word === "perl") return { branch: "perl", verdict: isSinglePerlInvocation(command) };
  if (word === "bd") return { branch: "bd", verdict: isSingleBdInvocation(command) };
  if (word === "git") return { branch: "git", verdict: isSingleGitInvocation(command) };
  if (word !== undefined) return { branch: "other", reason: "первый токен не perl и не bd" };
  return { branch: "other", reason: tokenized.ok ? "пустая команда" : tokenized.reason };
}
