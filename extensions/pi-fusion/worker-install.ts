/**
 * Installer for the fusion worker agent file (design rev.5.2 F03/F14): copies
 * the shipped `agents/fusion-worker.md` into pi's user agent directory as
 * `<agentDir>/agents/fusion-worker.md`, where the delegation seam resolves the
 * `agent: "fusion-worker"` requests of the fan-out pool.
 *
 * The copy is idempotent, keyed on the `version` line in the file header: a
 * target whose version already matches the shipped one is reported `current`
 * and left byte-identical, so calling this on every `/fusion on` and
 * `/fusion config` never rewrites the file needlessly and never clobbers a
 * hand edit that kept the version. A missing target is `installed`; a target
 * with no version header or an older one is `updated`.
 *
 * All I/O is synchronous and small (one read + at most one write); failures
 * (missing source, unwritable target) propagate to the caller, which reports
 * them to the operator.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FUSION_WORKER_AGENT_NAME = "fusion-worker";
export const FUSION_WORKER_AGENT_FILENAME = `${FUSION_WORKER_AGENT_NAME}.md`;

/** Must be bumped whenever the shipped agent file changes behaviour. */
export const FUSION_WORKER_AGENT_VERSION = "1";

/** One installed role profile: the manifest entry shape (design §4.6). */
export interface FusionRoleProfile {
  /** The agent name the seam resolves (design §4.4). */
  name: string;
  /** The shipped file name in `agents/`, installed under the same name. */
  filename: string;
  /** The version this build ships; bumped independently per profile. */
  version: string;
}

/**
 * The role profile versions — each bumps independently of the others
 * (design §4.6): a scout text change must not reinstall reviewers.
 */
export const FUSION_SCOUT_AGENT_VERSION = "1";
export const FUSION_RESEARCHER_AGENT_VERSION = "1";
export const FUSION_RESEARCHER_WEB_AGENT_VERSION = "1";
export const FUSION_RESEARCHER_CODEX_AGENT_VERSION = "1";
export const FUSION_RESEARCHER_BOTH_AGENT_VERSION = "1";
export const FUSION_REVIEWER_AGENT_VERSION = "1";

/**
 * All SEVEN profiles (design §4.6): the worker plus scout, reviewer and the
 * four researcher compositions of `researcherWeb` (§4.9.3 — exactly one
 * profile per composition). Every variant is installed, regardless of the
 * configured composition, so `/fusion config` can switch compositions
 * without a reinstall.
 */
export const FUSION_ROLE_PROFILES: readonly FusionRoleProfile[] = [
  { name: "fusion-worker", filename: "fusion-worker.md", version: FUSION_WORKER_AGENT_VERSION },
  { name: "fusion-scout", filename: "fusion-scout.md", version: FUSION_SCOUT_AGENT_VERSION },
  {
    name: "fusion-researcher",
    filename: "fusion-researcher.md",
    version: FUSION_RESEARCHER_AGENT_VERSION,
  },
  {
    name: "fusion-researcher-web",
    filename: "fusion-researcher-web.md",
    version: FUSION_RESEARCHER_WEB_AGENT_VERSION,
  },
  {
    name: "fusion-researcher-codex",
    filename: "fusion-researcher-codex.md",
    version: FUSION_RESEARCHER_CODEX_AGENT_VERSION,
  },
  {
    name: "fusion-researcher-both",
    filename: "fusion-researcher-both.md",
    version: FUSION_RESEARCHER_BOTH_AGENT_VERSION,
  },
  {
    name: "fusion-reviewer",
    filename: "fusion-reviewer.md",
    version: FUSION_REVIEWER_AGENT_VERSION,
  },
];

/** pi's user agent directory — the same root the config bridge reads fusion.json from. */
export function defaultAgentDir(): string {
  return join(homedir(), ".pi", "agent");
}

/** Where the installed worker agent lives by default. */
export function defaultWorkerAgentTargetPath(): string {
  return join(defaultAgentDir(), "agents", FUSION_WORKER_AGENT_FILENAME);
}

/**
 * The web-search extension entry the researcher `-web`/`-both` profiles are
 * delivered through (design §4.9.4): the ambient extension lives under the
 * agent dir, NOT as an npm package. The installer substitutes this absolute
 * path for the shipped placeholder; a missing file is reported by the caller
 * and the child's preflight fails honestly (agents.md:481).
 */
export function fusionWebExtensionEntryPath(agentDir: string = defaultAgentDir()): string {
  return join(agentDir, "extensions", "web-search", "index.ts");
}

/**
 * The pi-codex-search extension entry for the `-codex`/`-both` profiles:
 * an npm-installed pi package under the agent dir's npm tree, entry `index.ts`.
 * Live-smoke-proven delivery form (bd pi-fusion-8t2.2.5): an absolute path
 * to this entry loads in a foreground child and registers `codex_search`.
 */
export function fusionCodexExtensionEntryPath(agentDir: string = defaultAgentDir()): string {
  return join(agentDir, "npm", "node_modules", "pi-codex-search", "index.ts");
}

/**
 * Forward-slash absolute path form: the form the live smoke proved for
 * `subagentOnlyExtensions` values on Windows (a parsed YAML scalar, where
 * backslashes would need escaping).
 */
function forwardSlashes(p: string): string {
  return p.replaceAll("\\", "/");
}

/** Substitutes the entry placeholders for the resolved absolute paths. */
function substituteExtensionEntries(content: string, agentDir: string): string {
  return content
    .replaceAll(
      "{{FUSION_WEB_EXTENSION_ENTRY}}",
      forwardSlashes(fusionWebExtensionEntryPath(agentDir)),
    )
    .replaceAll(
      "{{FUSION_CODEX_EXTENSION_ENTRY}}",
      forwardSlashes(fusionCodexExtensionEntryPath(agentDir)),
    );
}

/** The agent file shipped inside this package, next to this module. */
export function shippedWorkerAgentPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "agents", FUSION_WORKER_AGENT_FILENAME);
}

/** The shipped file for a manifest entry, next to this module. */
export function shippedAgentPathFor(filename: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), "agents", filename);
}

/**
 * Flat `key: value` pairs of the file's `---`-fenced frontmatter header.
 * Key/value lines after the closing fence are ignored, so a `version:` in the
 * prompt body is never mistaken for the header.
 */
export function parseAgentFrontmatter(content: string): Record<string, string> {
  const fence = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (fence?.[1] === undefined) return {};
  const fields: Record<string, string> = {};
  for (const line of fence[1].split(/\r?\n/)) {
    const entry = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line);
    if (entry?.[1] !== undefined && entry[2] !== undefined) fields[entry[1]] = entry[2].trim();
  }
  return fields;
}

/** The `version` header value, or undefined when the header does not carry one. */
export function parseAgentVersion(content: string): string | undefined {
  const version = parseAgentFrontmatter(content).version;
  return version === undefined || version.length === 0 ? undefined : version;
}

export type InstallWorkerAgentOutcome = "installed" | "updated" | "current";

export interface InstallWorkerAgentResult {
  outcome: InstallWorkerAgentOutcome;
  /** Absolute path the agent file now lives at. */
  path: string;
}

export interface InstallWorkerAgentOptions {
  /** pi's user agent directory; defaults to `~/.pi/agent`. */
  agentDir?: string;
  /** The agent file to install; defaults to the one shipped with this package. */
  sourcePath?: string;
}

/**
 * Copies one shipped agent file into `<agentDir>/agents/`, keyed on the
 * target's `version` header (design §4.6): `current` targets are returned
 * without a write; a missing target is `installed`; an older or version-less
 * target is `updated`. `transform` is applied to the shipped content at the
 * write (the entry-path substitution for researcher variants) — never to the
 * version comparison, which stays literal.
 */
function installAgentFile(
  sourcePath: string,
  targetPath: string,
  version: string,
  transform: (content: string) => string = (content) => content,
): InstallWorkerAgentResult {
  const source = readFileSync(sourcePath, "utf8");

  let target: string | undefined;
  try {
    target = readFileSync(targetPath, "utf8");
  } catch {
    target = undefined; // absent; a present-but-unreadable target fails at the write below
  }
  if (target !== undefined && parseAgentVersion(target) === version) {
    return { outcome: "current", path: targetPath };
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, transform(source), "utf8");
  return { outcome: target === undefined ? "installed" : "updated", path: targetPath };
}

/**
 * Copies the fusion worker agent into `<agentDir>/agents/`. Returns without
 * writing when the target already carries the shipped version (`current`).
 * Signature and outcomes preserved as-is (design §4.6 B6): the worker is one
 * manifest entry, and its install path is unchanged.
 */
export function installFusionWorkerAgent(
  options: InstallWorkerAgentOptions = {},
): InstallWorkerAgentResult {
  const sourcePath = options.sourcePath ?? shippedWorkerAgentPath();
  const agentDir = options.agentDir ?? defaultAgentDir();
  const targetPath = join(agentDir, "agents", FUSION_WORKER_AGENT_FILENAME);
  return installAgentFile(sourcePath, targetPath, FUSION_WORKER_AGENT_VERSION);
}

/**
 * Installs ALL role profiles from the manifest (design §4.6): one pass over
 * the seven entries, idempotent per entry, each result carrying the profile
 * name. The researcher `-web`/`-codex`/`-both` files get their extension
 * entry placeholders substituted at the write (§4.9.4); `current` targets
 * are left untouched — including a stale substitution from an older install.
 */
export function installFusionRoleAgents(
  options: InstallWorkerAgentOptions = {},
): Array<InstallWorkerAgentResult & { name: string }> {
  const agentDir = options.agentDir ?? defaultAgentDir();
  return FUSION_ROLE_PROFILES.map((profile) => {
    const targetPath = join(agentDir, "agents", profile.filename);
    const result = installAgentFile(
      shippedAgentPathFor(profile.filename),
      targetPath,
      profile.version,
      (content) => substituteExtensionEntries(content, agentDir),
    );
    return { ...result, name: profile.name };
  });
}

/** Per-profile install state, as the command paths report it (design §4.6 B6). */
export type RoleProfileStatus = "absent" | "stale" | "current";

export interface RoleProfileStatusRow {
  name: string;
  status: RoleProfileStatus;
  /** Absolute target path the status refers to. */
  path: string;
}

/**
 * The manifest-wide staleness view (design §4.6): absent = the target is
 * missing; stale = the target's `version:` header differs from the manifest
 * (an existsSync check would miss this — the B6 defect); current = matches.
 */
export function roleProfileStatuses(
  options: InstallWorkerAgentOptions = {},
): RoleProfileStatusRow[] {
  const agentDir = options.agentDir ?? defaultAgentDir();
  return FUSION_ROLE_PROFILES.map((profile) => {
    const path = join(agentDir, "agents", profile.filename);
    let target: string | undefined;
    try {
      target = readFileSync(path, "utf8");
    } catch {
      target = undefined;
    }
    const status: RoleProfileStatus =
      target === undefined
        ? "absent"
        : parseAgentVersion(target) === profile.version
          ? "current"
          : "stale";
    return { name: profile.name, status, path };
  });
}
