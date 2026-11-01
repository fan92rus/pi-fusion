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

/** pi's user agent directory — the same root the config bridge reads fusion.json from. */
export function defaultAgentDir(): string {
  return join(homedir(), ".pi", "agent");
}

/** Where the installed worker agent lives by default. */
export function defaultWorkerAgentTargetPath(): string {
  return join(defaultAgentDir(), "agents", FUSION_WORKER_AGENT_FILENAME);
}

/** The agent file shipped inside this package, next to this module. */
export function shippedWorkerAgentPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "agents", FUSION_WORKER_AGENT_FILENAME);
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
 * Copies the fusion worker agent into `<agentDir>/agents/`. Returns without
 * writing when the target already carries the shipped version (`current`).
 */
export function installFusionWorkerAgent(
  options: InstallWorkerAgentOptions = {},
): InstallWorkerAgentResult {
  const sourcePath = options.sourcePath ?? shippedWorkerAgentPath();
  const source = readFileSync(sourcePath, "utf8");
  const agentDir = options.agentDir ?? defaultAgentDir();
  const targetPath = join(agentDir, "agents", FUSION_WORKER_AGENT_FILENAME);

  let target: string | undefined;
  try {
    target = readFileSync(targetPath, "utf8");
  } catch {
    target = undefined; // absent; a present-but-unreadable target fails at the write below
  }
  if (target !== undefined && parseAgentVersion(target) === FUSION_WORKER_AGENT_VERSION) {
    return { outcome: "current", path: targetPath };
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, source, "utf8");
  return { outcome: target === undefined ? "installed" : "updated", path: targetPath };
}
