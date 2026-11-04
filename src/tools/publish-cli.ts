#!/usr/bin/env node
/**
 * The project-publisher role's tool. Editing happens in the Studio; publishing
 * puts a whole project, as an example any project can start from, into the
 * community library, agent-loop-community, under `projects/<name>/`: every loop
 * and role of the project that the framework does not give every project as it
 * is, and `reference.json`, which says what the project is and which task loop
 * it runs with which values. Its data, keys, task and run records stay here. A
 * project publishes once at least one of its tasks has finished, and only what
 * its owner approved: `plan` lists exactly what would leave and binds it to a
 * digest, which `publish` requires. Each publication is one pull request, which
 * the community's maintainers review.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createCli, runCli } from "../lib/cli.js";
import {
  contributionsDir,
  installationFile,
  installedLibrary,
  installedRole,
  libraryRoots,
  sidesOf,
  COMMUNITY_LIBRARY,
  COMMUNITY_URL,
  type Role,
} from "./installation.js";
import { checkLoop, checkRoles, type LoopReport, type RoleReport } from "./loop-check.js";
import {
  frontmatter,
  listLoops,
  loopDefinitionPath,
  loopScriptPath,
  rolesDir,
  selectedLoopPath,
} from "./loops.js";
import {
  hasManifest,
  loadExtension,
  readManifest,
  type ProjectExtension,
  type ProjectManifest,
} from "./project-manifest.js";
import { projectSlug } from "./project-settings.js";
import { writeStateJsonAtomic } from "./state-file.js";
import { scanForThreats } from "./threat-scan.js";
import { A1Error, failA1, isRecord } from "./validate.js";

type State =
  /** Sent: the community's copy of the project does not have it yet. */
  | "new"
  /** Sent: this project changed it since it last published it. */
  | "changed"
  /** Not sent: the community's copy was changed by someone else since this project published it, or another project is published under this name. */
  | "conflict"
  /** Not sent: the framework gives every project this base loop or role, and this project left it as it was installed. */
  | "unchanged"
  /** Not sent: the community's copy already has exactly this. */
  | "in-library"
  /** Not sent: an earlier publication of this project already carries exactly this. */
  | "already-sent"
  /** Not sent: seeded by a release that kept no baseline, so what the project changed is unknown. */
  | "unknown-base"
  /** Not sent: not in the form of a role or loop, or its check fails. */
  | "invalid"
  /** Not sent: it serves a side this project does not receive. */
  | "wrong-side"
  /** Not sent: it holds a key, a token, a hidden path or an injection pattern. */
  | "blocked"
  /** Not sent: the owner left it out. */
  | "excluded";
const SENDABLE: readonly State[] = ["new", "changed"];

interface PlanFile {
  source: string;
  target: string;
  sha256: string;
  /** The exact text that would leave. */
  preview?: string;
}
interface PlanUnit {
  kind: "role" | "loop" | "project";
  name: string;
  side: string | null;
  /** The library it goes to, by name, once it has a side. */
  library: string | null;
  description: string;
  state: State;
  reason?: string;
  warnings: string[];
  files: PlanFile[];
}
interface ResolvedView {
  available: true;
  name: string;
  checkout: string;
  remote: string | null;
  base_branch: string;
  base_commit: string;
  note: string | null;
}
type LibraryView = ResolvedView | { available: false; reason: string; upstream: string | null };
interface PublicPlan {
  project: string;
  side: Role;
  /** The name the project is published under: `projects/<name>/` in the community library. */
  name: string;
  /** What reference.json would say, or why it cannot be written yet. */
  metadata: { file: string; problem: string | null };
  /** Files of the community's copy of this project that the project no longer has; publishing removes them. */
  removed: string[];
  /** At least one task finished, as the project counts them (a run of its task loop, unless it says otherwise). */
  eligible: boolean;
  finished_tasks: string[];
  /** Where it is published: the community library. */
  library: LibraryView;
  /** The libraries this project knows: the checkout it was installed from, and the community's. */
  libraries: ResolvedView[];
  selected: PlanUnit[];
  not_selected: PlanUnit[];
  unchanged: number;
  /** Exactly what the pull request will show. */
  changes_file: string | null;
  library_check: { ok: boolean; defects: string[] } | null;
  /** The project's own check of what leaves, when it has one, on this plan's digest. */
  check: "not-needed" | "required" | "passed" | "failed";
  digest: string | null;
}
interface LibrarySource {
  /** The repository's name: `agent-loop-studio`, `agent-loop-community`, or the package's. */
  name: string;
  checkout: string;
  remote: string | null;
  branch: string;
  ref: string;
  commit: string;
  note: string | null;
}

interface Ran {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  missing: boolean;
}
function run(command: string, args: string[], cwd?: string): Ran {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 300_000,
    // Nothing here may wait for someone to type a password.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: (result.stderr || String(result.error ?? "")).trim(),
    missing: (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT",
  };
}
const git = (cwd: string, ...args: string[]): Ran => run("git", ["-C", cwd, ...args]);

/** Line endings differ by platform and say nothing about what a role or loop does. */
const normal = (text: string): string => text.replace(/\r\n/g, "\n");
const readText = (file: string): string | null =>
  fs.existsSync(file) ? normal(fs.readFileSync(file, "utf8")) : null;
const sha256 = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");
const readJson = (file: string): unknown => {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  } catch {
    return null;
  }
};

/** `.claude/agents/x.md`, as the installer seeded it. */
const seededFile = (root: string, source: string): string =>
  path.join(root, ".contrejour", "seeded", ...source.split("/").slice(1));
const clonePath = (root: string): string => path.join(contributionsDir(root), "library-checkout");
/** The framework's library, as a project package carries it. */
const FRAMEWORK_LIBRARY = "agent-loop-studio";
const communityClonePath = (root: string): string =>
  path.join(contributionsDir(root), "community-checkout");
const logPath = (root: string): string => path.join(contributionsDir(root), "log.json");
const checkPath = (root: string): string => path.join(contributionsDir(root), "check.json");
const previewDir = (root: string): string => path.join(contributionsDir(root), "preview");

/**
 * The tasks of this project that finished. The project's extension says what
 * counts; otherwise a task is a run of the project's task loop that a role of it
 * finished, as the trajectory index records.
 */
function finishedTasks(root: string, side: Role, extension: ProjectExtension): string[] {
  if (extension.finishedTasks) return extension.finishedTasks(root, side);
  const chosen = readJson(selectedLoopPath(root));
  const loop = isRecord(chosen) && typeof chosen.loop === "string" ? chosen.loop : null;
  if (!loop) return [];
  const script = readText(loopScriptPath(root, loop)) ?? "";
  const description = /description:\s*(['"`])((?:(?!\1).)*)\1/.exec(script)?.[2];
  const names = new Set([loop, ...(description ? [description] : [])]);
  const index = readText(path.join(root, ".contrejour", "trajectories", "index.jsonl")) ?? "";
  const runs = new Set<string>();
  for (const line of index.split("\n")) {
    try {
      const entry: unknown = JSON.parse(line);
      if (!isRecord(entry) || !Array.isArray(entry.workflows)) continue;
      for (const workflow of entry.workflows)
        if (
          isRecord(workflow) &&
          names.has(String(workflow.name)) &&
          typeof workflow.id === "string"
        )
          runs.add(workflow.id);
    } catch {
      // A line being written is skipped.
    }
  }
  return [...runs].sort();
}

/** A directory that is a Git repository of its own, not a folder of the one around it. */
function isOwnRepository(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  const top = git(dir, "rev-parse", "--show-toplevel");
  return top.ok && fs.realpathSync(top.stdout.trim()) === fs.realpathSync(dir);
}
function checkoutOf(root: string): string | null {
  for (const candidate of [installedLibrary(root), clonePath(root)])
    if (candidate && isOwnRepository(candidate)) return candidate;
  return null;
}
/**
 * The libraries a unit of this project can go back to: the checkout it was
 * installed from (or the clone made for it), then the framework's and the
 * community's, which a project package's checkout carries as submodules.
 */
function checkoutsOf(root: string): { name: string; checkout: string }[] {
  const found: { name: string; checkout: string }[] = [];
  const main = checkoutOf(root);
  if (main) {
    const remote = git(main, "config", "--get", "remote.origin.url").stdout.trim();
    found.push({
      name: (remote && githubRepo(remote)?.name) || path.basename(main),
      checkout: main,
    });
    // The framework's library a package carries, and the community library beside the checkout.
    const framework = path.join(main, FRAMEWORK_LIBRARY);
    if (fs.existsSync(path.join(framework, "library")) && isOwnRepository(framework))
      found.push({ name: FRAMEWORK_LIBRARY, checkout: framework });
    const community = path.join(main, COMMUNITY_LIBRARY);
    if (isOwnRepository(community)) found.push({ name: COMMUNITY_LIBRARY, checkout: community });
  }
  // A project whose checkout carries no community library may have fetched one to share with.
  if (
    !found.some((entry) => entry.name === COMMUNITY_LIBRARY) &&
    isOwnRepository(communityClonePath(root))
  )
    found.push({ name: COMMUNITY_LIBRARY, checkout: communityClonePath(root) });
  return found;
}

/**
 * The branch a contribution starts from and asks to merge into: the remote's
 * default branch, as of now. A repository whose default branch has no library yet
 * falls back to the branch this checkout is on, and says so.
 */
function resolveLibrary(name: string, checkout: string): LibrarySource {
  const remote = git(checkout, "config", "--get", "remote.origin.url").stdout.trim() || null;
  const notes: string[] = [];
  if (remote) {
    const fetched = git(checkout, "fetch", "--quiet", "origin");
    if (!fetched.ok)
      notes.push(
        `could not fetch origin, so this is what the checkout last saw: ${fetched.stderr}`,
      );
  }
  // The community library keeps its published projects; another library, its loops and roles.
  const marker = name === COMMUNITY_LIBRARY ? "projects" : "library/roles";
  const hasLibrary = (ref: string) => git(checkout, "cat-file", "-e", `${ref}:${marker}`).ok;
  const remoteDefault = (): string | null => {
    if (!remote) return null;
    const known = git(checkout, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
    if (known.ok) return known.stdout.trim().replace(/^origin\//, "");
    const asked = git(checkout, "ls-remote", "--symref", "origin", "HEAD");
    return /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(asked.stdout)?.[1] ?? null;
  };
  const candidates: { branch: string; ref: string }[] = [];
  const defaultBranch = remoteDefault();
  if (defaultBranch) candidates.push({ branch: defaultBranch, ref: `origin/${defaultBranch}` });
  const current = git(checkout, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
  if (current && current !== "HEAD") {
    if (remote && git(checkout, "rev-parse", "--verify", "--quiet", `origin/${current}`).ok)
      candidates.push({ branch: current, ref: `origin/${current}` });
    candidates.push({ branch: current, ref: current });
  }
  const base = candidates.find((candidate) => hasLibrary(candidate.ref));
  if (!base)
    failA1(
      "LIBRARY_UNAVAILABLE",
      `no branch of ${checkout} holds ${marker}: neither the default branch nor the branch it is on`,
    );
  if (defaultBranch && base.branch !== defaultBranch)
    notes.push(
      `the default branch ${defaultBranch} has no library yet, so this publication targets ${base.branch}`,
    );
  return {
    name,
    checkout,
    remote,
    branch: base.branch,
    ref: base.ref,
    commit: git(checkout, "rev-parse", base.ref).stdout.trim(),
    note: notes.join("; ") || null,
  };
}

/** What earlier contributions from this project carried, by library path. */
function sentHashes(root: string): Map<string, Set<string>> {
  const log = readJson(logPath(root));
  const sent = new Map<string, Set<string>>();
  const entries = isRecord(log) && Array.isArray(log.contributions) ? log.contributions : [];
  for (const entry of entries)
    if (isRecord(entry) && Array.isArray(entry.files))
      for (const file of entry.files)
        if (isRecord(file) && typeof file.target === "string" && typeof file.sha256 === "string")
          sent.set(file.target, (sent.get(file.target) ?? new Set<string>()).add(file.sha256));
  return sent;
}

/** How a file of the project relates to its baseline and to the library's current version. */
/** How the community's published copy of a file relates to this project's text. */
function stateAgainstPublished(
  ours: string,
  theirs: string | null,
  sent: Set<string>,
): { state: State; reason?: string } {
  if (theirs === null) return { state: "new" };
  if (theirs === ours) return { state: "in-library" };
  // The community holds what this project published earlier: only this project moved since.
  if (sent.has(sha256(theirs))) return { state: "changed" };
  return {
    state: "conflict",
    reason:
      "the community's copy of it changed since this project published it: bring that change into this project's copy by hand, then plan again",
  };
}

const KEY_SHAPES: readonly [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\bsk-[A-Za-z0-9_-]{20,}/, "an API key"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, "a GitHub token"],
  [/\bhf_[A-Za-z0-9]{20,}/, "a Hugging Face token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS key"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}/, "a bearer token"],
];
const MACHINE_PATH = /(?:\/home\/[\w.-]+|\/Users\/[\w.-]+|[A-Za-z]:\\Users\\[^\s\\]+)[^\s`'")]*/g;

/** The keys and tokens this project holds, which must never leave in a role or loop. */
function secretsOf(root: string): { label: string; value: string }[] {
  const secrets: { label: string; value: string }[] = [];
  const add = (label: string, value: unknown) => {
    if (typeof value === "string" && value.length >= 6) secrets.push({ label, value });
  };
  const environment = readJson(path.join(root, ".contrejour", "environment.json"));
  if (isRecord(environment))
    for (const [name, value] of Object.entries(environment))
      add(`the environment secret ${name}`, value);
  const mcp = readJson(path.join(root, ".mcp.json"));
  const servers = isRecord(mcp) && isRecord(mcp.mcpServers) ? mcp.mcpServers : {};
  for (const [name, server] of Object.entries(servers))
    if (isRecord(server) && isRecord(server.headers))
      for (const value of Object.values(server.headers))
        add(`the token of the ${name} server`, String(value).replace(/^Bearer\s+/, ""));
  // And what the project itself knows to be secret, such as a service's token.
  for (const secret of extensionOf(root).secrets?.(root, installedRole(root)) ?? [])
    add(secret.label, secret.value);
  return secrets;
}
function hiddenPathsOf(root: string, side: Role): string[] {
  return extensionOf(root).hiddenPaths?.(root, side) ?? [];
}

/** The project's extension, loaded once when a command starts. */
let loadedExtension: ProjectExtension = {};
const extensionOf = (_root: string): ProjectExtension => loadedExtension;

/** Why a file may not leave at all, naming what it holds and never repeating it. */
function blockingProblems(
  text: string,
  secrets: { label: string; value: string }[],
  hidden: string[],
): string[] {
  const problems = secrets
    .filter((secret) => text.includes(secret.value))
    .map((secret) => `it holds ${secret.label}`);
  for (const [shape, label] of KEY_SHAPES)
    if (shape.test(text)) problems.push(`it holds what looks like ${label}`);
  for (const hiddenPath of hidden)
    if (text.includes(hiddenPath)) problems.push("it names a hidden path");
  for (const threat of scanForThreats(text, "strict"))
    problems.push(`it matches the injection pattern ${threat}`);
  return problems;
}

interface Classified extends PlanUnit {
  /** The text that would leave, by its path in the community library. */
  finals: Map<string, string>;
  /** The community's current text, by path, where it has one. */
  before: Map<string, string>;
}

interface PlanContext {
  root: string;
  side: Role;
  /** The library sides this project receives, `framework` first. */
  sides: string[];
  /** The name the project is published under. */
  name: string;
  community: LibrarySource;
  /** The library checkouts holding the framework's base loops and roles. */
  frameworkRoots: string[];
  /** The files the project got from the example it started from, which are its own to publish. */
  fromExample: Set<string>;
  /** Whether another project is published under this name. */
  taken: boolean;
  sent: Map<string, Set<string>>;
  seeded: Set<string>;
}

function showAtBase(library: LibrarySource, target: string): string | null {
  const shown = git(library.checkout, "show", `${library.ref}:${target}`);
  return shown.ok ? normal(shown.stdout) : null;
}
/** The framework's own text of a base loop or role, when the framework has one of that name. */
function frameworkText(context: PlanContext, kind: "loops" | "roles", file: string): string | null {
  for (const library of context.frameworkRoots) {
    const text = readText(path.join(library, "library", kind, "framework", file));
    if (text !== null) return text;
  }
  return null;
}

/**
 * Whether a file the framework also has is the project's to publish: one the
 * project changed, or got from the example it started from, is; one it left as
 * the framework installed it is not, since every project gets that.
 */
function leftAsInstalled(
  context: PlanContext,
  source: string,
  ours: string,
  base: string | null,
  framework: string | null,
): "yes" | "no" | "unknown" {
  if (framework === null || context.fromExample.has(source)) return "no";
  if (base !== null) return ours === base ? "yes" : "no";
  if (ours === framework) return "yes";
  return context.seeded.has(source) ? "unknown" : "no";
}
const UNKNOWN_BASE =
  "this project was installed before baselines were kept, so what it changed cannot be told: install into a fresh project to publish it";

function classifyRole(context: PlanContext, name: string): Classified {
  const { root, side } = context;
  const source = `.claude/agents/${name}.md`;
  const ours = readText(path.join(rolesDir(root), `${name}.md`)) ?? "";
  const fields = frontmatter(ours);
  const base = readText(seededFile(root, source));
  const unit: Classified = {
    kind: "role",
    name,
    side: fields.side ?? null,
    library: COMMUNITY_LIBRARY,
    description: fields.description ?? "",
    state: "unchanged",
    warnings: [],
    files: [],
    finals: new Map(),
    before: new Map(),
  };
  const left = leftAsInstalled(
    context,
    source,
    ours,
    base,
    frameworkText(context, "roles", `${name}.md`),
  );
  if (left === "yes") return unit;
  if (left === "unknown") return { ...unit, state: "unknown-base", reason: UNKNOWN_BASE };
  const defects = checkRoles(root, [name])[0]?.defects ?? [];
  if (defects.length)
    return {
      ...unit,
      state: "invalid",
      reason: `not in the form of a role, so it stays in this project: ${defects.join("; ")}`,
    };
  if (!context.sides.includes(fields.side ?? ""))
    return {
      ...unit,
      state: "wrong-side",
      reason: `it serves the ${fields.side} side, and this ${side} project receives ${context.sides.join(" and ")}`,
    };
  const target = `projects/${context.name}/roles/${name}.md`;
  const theirs = showAtBase(context.community, target);
  const sent = context.sent.get(target) ?? new Set<string>();
  let { state, reason } = context.taken
    ? { state: "conflict" as State, reason: TAKEN(context.name) }
    : stateAgainstPublished(ours, theirs, sent);
  if (SENDABLE.includes(state) && sent.has(sha256(ours))) {
    state = "already-sent";
    reason = "an earlier publication of this project already carries exactly this";
  }
  return {
    ...unit,
    state,
    ...(reason ? { reason } : {}),
    files: [{ source, target, sha256: sha256(ours) }],
    finals: new Map([[target, ours]]),
    before: new Map(theirs === null ? [] : [[target, theirs]]),
  };
}
const TAKEN = (name: string) =>
  `another project is published as ${name}: publish this one under another name`;

async function classifyLoop(context: PlanContext, name: string): Promise<Classified> {
  const { root, side } = context;
  const definitionSource = `.claude/loops/${name}.md`;
  const scriptSource = `.claude/workflows/${name}.js`;
  const definition = readText(loopDefinitionPath(root, name)) ?? "";
  const script = readText(loopScriptPath(root, name)) ?? "";
  const fields = frontmatter(definition);
  const unit: Classified = {
    kind: "loop",
    name,
    side: fields.side ?? null,
    library: COMMUNITY_LIBRARY,
    description: fields.description ?? "",
    state: "unchanged",
    warnings: [],
    files: [],
    finals: new Map(),
    before: new Map(),
  };
  const lefts = [
    leftAsInstalled(
      context,
      definitionSource,
      definition,
      readText(seededFile(root, definitionSource)),
      frameworkText(context, "loops", `${name}.md`),
    ),
    leftAsInstalled(
      context,
      scriptSource,
      script,
      readText(seededFile(root, scriptSource)),
      frameworkText(context, "loops", `${name}.js`),
    ),
  ];
  if (lefts.every((left) => left === "yes")) return unit;
  if (lefts.includes("unknown")) return { ...unit, state: "unknown-base", reason: UNKNOWN_BASE };
  if (!context.sides.includes(fields.side ?? ""))
    return {
      ...unit,
      state: "wrong-side",
      reason: `it serves the ${fields.side ?? "unnamed"} side, and this ${side} project receives ${context.sides.join(" and ")}`,
    };
  const report = await checkLoop(root, name);
  if (!report.ok)
    return {
      ...unit,
      state: "invalid",
      reason: `its check fails, so have loop-editor fix it first: ${[
        ...(report.stale ? ["the script is stale"] : []),
        ...report.defects,
      ].join("; ")}`,
    };
  const pairs = [
    { source: definitionSource, ours: definition, ext: "md" },
    { source: scriptSource, ours: script, ext: "js" },
  ].map((pair) => {
    const target = `projects/${context.name}/loops/${name}.${pair.ext}`;
    const theirs = showAtBase(context.community, target);
    const sent = context.sent.get(target) ?? new Set<string>();
    return {
      ...pair,
      target,
      theirs,
      sent,
      verdict: stateAgainstPublished(pair.ours, theirs, sent),
    };
  });
  const whole = {
    ...unit,
    files: pairs.map((pair) => ({
      source: pair.source,
      target: pair.target,
      sha256: sha256(pair.ours),
    })),
    finals: new Map(pairs.map((pair) => [pair.target, pair.ours])),
    before: new Map(
      pairs.flatMap((pair) =>
        pair.theirs === null ? [] : ([[pair.target, pair.theirs]] as [string, string][]),
      ),
    ),
  };
  if (context.taken) return { ...whole, state: "conflict", reason: TAKEN(context.name) };
  if (pairs.every((pair) => pair.verdict.state === "in-library"))
    return { ...whole, state: "in-library" };
  const stuck = pairs.find((pair) => pair.verdict.state === "conflict");
  if (stuck) return { ...whole, state: "conflict", reason: stuck.verdict.reason! };
  if (pairs.every((pair) => pair.sent.has(sha256(pair.ours))))
    return {
      ...whole,
      state: "already-sent",
      reason: "an earlier publication of this project already carries exactly this",
    };
  return { ...whole, state: pairs[0]!.theirs === null ? "new" : "changed" };
}

const inWorktree = async <T>(
  root: string,
  source: LibrarySource,
  how: string[],
  action: (dir: string) => Promise<T> | T,
): Promise<T> => {
  const dir = path.join(contributionsDir(root), "worktrees", String(process.pid));
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const added = git(source.checkout, "worktree", "add", "--quiet", ...how, dir, source.ref);
  if (!added.ok)
    failA1(
      "LIBRARY_UNAVAILABLE",
      `cannot make a working copy of ${source.checkout}: ${added.stderr}`,
    );
  try {
    return await action(dir);
  } finally {
    git(source.checkout, "worktree", "remove", "--force", dir);
    fs.rmSync(dir, { recursive: true, force: true });
    git(source.checkout, "worktree", "prune");
  }
};

function writeFinals(dir: string, units: Classified[]): void {
  for (const unit of units)
    for (const [target, text] of unit.finals) {
      const file = path.join(dir, ...target.split("/"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
}

/**
 * Check a library as a project of each side sees it, each file against the side
 * it declares. `manifest` is the package whose library it is: it names the hook
 * actions its loops may declare. A library without one (the shared one) may use
 * only the framework's.
 */
export async function checkLibrary(
  library: string,
  manifest?: ProjectManifest,
): Promise<{
  ok: boolean;
  reports: Record<string, { check: LoopReport[]; roles: RoleReport[] }>;
}> {
  const reports: Record<string, { check: LoopReport[]; roles: RoleReport[] }> = {};
  const files = (dir: string, extension: string) =>
    fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((file) => file.endsWith(extension))
          .sort()
      : [];
  const declaredSide = (file: string) => frontmatter(fs.readFileSync(file, "utf8")).side;
  let ok = true;
  const sidesIn = (kind: string) =>
    fs.existsSync(path.join(library, kind))
      ? fs
          .readdirSync(path.join(library, kind))
          .filter((entry) => fs.statSync(path.join(library, kind, entry)).isDirectory())
      : [];
  const sides = [...new Set([...sidesIn("loops"), ...sidesIn("roles")])]
    .filter((side) => side !== "framework")
    .sort();
  // A library with only the framework's files is checked as one project of its own.
  for (const side of sides.length ? sides : ["framework"]) {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), `contrejour-library-${side}-`));
    try {
      const declared: ProjectManifest = {
        format: 1,
        name: manifest?.name ?? "library",
        profiles: {
          [side]: { entry_role: "task-manager", sides: side === "framework" ? [] : [side] },
        },
        hook_actions: manifest?.hook_actions ?? {},
      };
      fs.mkdirSync(path.join(project, ".contrejour"), { recursive: true });
      fs.writeFileSync(path.join(project, ".contrejour", "project.json"), JSON.stringify(declared));
      for (const [from, to, extension] of [
        ["roles/framework", "agents", ".md"],
        [`roles/${side}`, "agents", ".md"],
        ["loops/framework", "loops", ".md"],
        [`loops/${side}`, "loops", ".md"],
        ["loops/framework", "workflows", ".js"],
        [`loops/${side}`, "workflows", ".js"],
      ] as const) {
        const source = path.join(library, from);
        fs.mkdirSync(path.join(project, ".claude", to), { recursive: true });
        for (const file of files(source, extension))
          fs.copyFileSync(path.join(source, file), path.join(project, ".claude", to, file));
      }
      const check: LoopReport[] = [];
      for (const name of listLoops(project)) {
        const report = await checkLoop(project, name);
        const directory = fs.existsSync(path.join(library, "loops", side, `${name}.md`))
          ? side
          : "framework";
        const declared = declaredSide(loopDefinitionPath(project, name));
        if (declared !== directory) {
          report.defects.push(`it declares side ${declared}, but lives under ${directory}`);
          report.ok = false;
        }
        check.push(report);
      }
      const roles = checkRoles(project);
      for (const report of roles) {
        const file = `${report.role}.md`;
        const directory = fs.existsSync(path.join(library, "roles", side, file))
          ? side
          : "framework";
        if (
          side !== "framework" &&
          fs.existsSync(path.join(library, "roles", "framework", file)) &&
          directory === side
        )
          report.defects.push("the same role name is also under framework");
        const declared = declaredSide(path.join(rolesDir(project), file));
        if ([...sides, "framework"].includes(declared ?? "") && declared !== directory)
          report.defects.push(`it declares side ${declared}, but lives under ${directory}`);
        report.ok = !report.defects.length;
      }
      reports[side] = { check, roles };
      if (check.some((entry) => !entry.ok) || roles.some((entry) => !entry.ok)) ok = false;
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  }
  return { ok, reports };
}

/** The defects, in the library this contribution would produce, of what it carries. */
/**
 * The defects of what the publication carries, checked as a project started from
 * it gets it: the framework's library, with the published loops and roles laid
 * over it by the sides they declare.
 */
async function checkPublication(
  root: string,
  context: PlanContext,
  selected: Classified[],
): Promise<{ ok: boolean; defects: string[] }> {
  const merged = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-publish-check-"));
  try {
    // The first root's version is the one a project gets, so it is laid last.
    for (const library of [...context.frameworkRoots].reverse())
      if (fs.existsSync(path.join(library, "library")))
        fs.cpSync(path.join(library, "library"), path.join(merged, "library"), {
          recursive: true,
          filter: (file) => path.basename(file) !== ".gitkeep",
        });
    for (const unit of selected) {
      if (unit.kind === "project" || !unit.side) continue;
      for (const [target, text] of unit.finals) {
        const file = path.join(
          merged,
          "library",
          unit.kind === "loop" ? "loops" : "roles",
          unit.side,
          target.split("/").pop()!,
        );
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
      }
    }
    const { reports } = await checkLibrary(
      path.join(merged, "library"),
      hasManifest(root) ? readManifest(root) : undefined,
    );
    const names = new Set(selected.map((unit) => `${unit.kind}:${unit.name}`));
    const defects = new Set<string>();
    for (const report of Object.values(reports)) {
      for (const loop of report.check)
        if (names.has(`loop:${loop.loop}`) && !loop.ok)
          for (const defect of loop.stale ? ["the script is stale", ...loop.defects] : loop.defects)
            defects.add(`loop ${loop.loop}: ${defect}`);
      for (const role of report.roles)
        if (names.has(`role:${role.role}`))
          for (const defect of role.defects) defects.add(`role ${role.role}: ${defect}`);
    }
    return { ok: !defects.size, defects: [...defects] };
  } finally {
    fs.rmSync(merged, { recursive: true, force: true });
  }
}

/** The exact text that would leave, and the diff the pull request will show. */
function writePreview(root: string, selected: Classified[]): string | null {
  const dir = previewDir(root);
  fs.rmSync(dir, { recursive: true, force: true });
  if (!selected.length) return null;
  const after = path.join(dir, "after");
  const before = path.join(dir, "before");
  fs.mkdirSync(after, { recursive: true });
  fs.mkdirSync(before, { recursive: true });
  for (const unit of selected) {
    // Each library's files under its name: each gets its own pull request.
    const library = unit.library ?? "library";
    writeFinals(path.join(after, library), [unit]);
    for (const [target, text] of unit.before) {
      const file = path.join(before, library, ...target.split("/"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
    for (const file of unit.files)
      file.preview = path.join(after, library, ...file.target.split("/"));
  }
  const changes = path.join(dir, "changes.diff");
  fs.writeFileSync(
    changes,
    run("git", ["diff", "--no-index", "--no-color", "before", "after"], dir).stdout,
  );
  return changes;
}

/** The project's own check of what leaves, if its extension asks for one, on the plan with this digest. */
function checkState(root: string, side: Role, digest: string | null): PublicPlan["check"] {
  if (!extensionOf(root).needsContributionCheck?.(root, side)) return "not-needed";
  const recorded = readJson(checkPath(root));
  if (!digest || !isRecord(recorded) || recorded.digest !== digest) return "required";
  return recorded.verdict === "pass" ? "passed" : "failed";
}

/** Why this project has no community library to contribute to yet, and where one comes from; null when it has one. */
function missingLibrary(checkouts: { name: string; checkout: string }[]): {
  reason: string;
  upstream: string;
} | null {
  if (checkouts.some((entry) => entry.name === COMMUNITY_LIBRARY)) return null;
  return {
    reason: `no checkout of the community library is recorded for this project: \`publish-cli.js clone\` fetches one from ${COMMUNITY_URL}`,
    upstream: COMMUNITY_URL,
  };
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const metadataPath = (root: string): string =>
  path.join(path.resolve(root), ".contrejour", "publish", "reference.json");
const publishedPath = (root: string): string =>
  path.join(path.resolve(root), ".contrejour", "published.json");

/** The files a project got from the example it started from, which are its own to publish. */
function exampleFiles(root: string): Set<string> {
  const recorded = readJson(path.join(root, ".contrejour", "reference.json"));
  return new Set(
    isRecord(recorded) && Array.isArray(recorded.files)
      ? recorded.files.filter((file): file is string => typeof file === "string")
      : [],
  );
}

/** What the published reference.json says: the owner's title and description, and the task loop with its values. */
function publishedReference(
  root: string,
  name: string,
): { text: string | null; problem: string | null } {
  const drafted = readJson(metadataPath(root));
  const texts = (value: unknown) =>
    isRecord(value) &&
    typeof value.zh === "string" &&
    value.zh.trim() !== "" &&
    typeof value.en === "string" &&
    value.en.trim() !== "";
  if (!isRecord(drafted) || !texts(drafted.title) || !texts(drafted.description))
    return {
      text: null,
      problem:
        "write .contrejour/publish/reference.json first: a title and a description, each in zh and en",
    };
  const chosen = readJson(selectedLoopPath(root));
  if (!isRecord(chosen) || typeof chosen.loop !== "string" || !isRecord(chosen.params))
    return { text: null, problem: "the project has no task loop yet: set it up first (setup)" };
  const reference = {
    name,
    title: drafted.title,
    description: drafted.description,
    task_loop: chosen.loop,
    params: chosen.params,
  };
  return { text: `${JSON.stringify(reference, null, 2)}\n`, problem: null };
}

/** The files the community's copy of a published project has, as of the community's base. */
function filesAtBase(library: LibrarySource, dir: string): string[] {
  return git(library.checkout, "ls-tree", "-r", "--name-only", library.ref, "--", dir)
    .stdout.split("\n")
    .filter(Boolean);
}

async function makePlan(
  root: string,
  exclude: string[],
  chosenName?: string,
): Promise<{ plan: PublicPlan; selected: Classified[]; community: LibrarySource | null }> {
  const side = installedRole(root);
  const finished = finishedTasks(root, side, extensionOf(root));
  const name = chosenName || projectSlug(root);
  if (!NAME.test(name))
    failA1(
      "INVALID_VALUE",
      "a published name is lowercase letters, digits, dots, dashes or underscores",
    );
  const shared = {
    project: projectSlug(root),
    side,
    name,
    eligible: finished.length > 0,
    finished_tasks: finished,
  };
  const checkouts = checkoutsOf(root);
  const missing = missingLibrary(checkouts);
  if (missing)
    return {
      plan: {
        ...shared,
        metadata: { file: metadataPath(root), problem: null },
        removed: [],
        library: { available: false, ...missing },
        libraries: [],
        selected: [],
        not_selected: [],
        unchanged: 0,
        changes_file: null,
        library_check: null,
        check: checkState(root, side, null),
        digest: null,
      },
      selected: [],
      community: null,
    };
  const libraries = checkouts.map(({ name: library, checkout }) =>
    resolveLibrary(library, checkout),
  );
  const community = libraries.find((library) => library.name === COMMUNITY_LIBRARY)!;
  const sent = sentHashes(root);
  const dir = `projects/${name}`;
  const existing = filesAtBase(community, dir);
  const record = readJson(publishedPath(root));
  const ours =
    (isRecord(record) && record.name === name) ||
    existing.some((file) => {
      const text = showAtBase(community, file);
      return text !== null && (sent.get(file)?.has(sha256(text)) ?? false);
    });
  const installed = readJson(installationFile(root));
  const context: PlanContext = {
    root,
    side,
    sides: sidesOf(root),
    name,
    community,
    frameworkRoots: libraryRoots(root).filter(
      (library) => path.basename(library) !== COMMUNITY_LIBRARY,
    ),
    fromExample: exampleFiles(root),
    taken: existing.length > 0 && !ours,
    sent,
    seeded: new Set(
      isRecord(installed) && Array.isArray(installed.seeded) ? (installed.seeded as string[]) : [],
    ),
  };
  const units: Classified[] = [];
  const roles = rolesDir(root);
  if (fs.existsSync(roles))
    for (const file of fs.readdirSync(roles).sort())
      if (file.endsWith(".md")) units.push(classifyRole(context, file.slice(0, -3)));
  for (const loop of listLoops(root)) units.push(await classifyLoop(context, loop));

  // What the project is: reference.json, which a new project started from it reads.
  const reference = publishedReference(root, name);
  const referenceTarget = `${dir}/reference.json`;
  if (reference.text !== null) {
    const theirs = showAtBase(community, referenceTarget);
    const verdict = context.taken
      ? { state: "conflict" as State, reason: TAKEN(name) }
      : stateAgainstPublished(reference.text, theirs, sent.get(referenceTarget) ?? new Set());
    units.push({
      kind: "project",
      name,
      side: null,
      library: COMMUNITY_LIBRARY,
      description: "what the project is, and the task loop it runs with which values",
      ...verdict,
      warnings: [],
      files: [
        {
          source: ".contrejour/publish/reference.json",
          target: referenceTarget,
          sha256: sha256(reference.text),
        },
      ],
      finals: new Map([[referenceTarget, reference.text]]),
      before: new Map(theirs === null ? [] : [[referenceTarget, theirs]]),
    });
  }

  const secrets = secretsOf(root);
  const hidden = hiddenPathsOf(root, side);
  const home = os.homedir();
  for (const unit of units) {
    if (!SENDABLE.includes(unit.state)) continue;
    const texts = [...unit.finals.values()];
    const problems = [...new Set(texts.flatMap((text) => blockingProblems(text, secrets, hidden)))];
    if (problems.length) {
      unit.state = "blocked";
      unit.reason = problems.join("; ");
      continue;
    }
    const paths = new Set(texts.flatMap((text) => text.match(MACHINE_PATH) ?? []));
    for (const known of [root, ...libraries.map((library) => library.checkout), home])
      if (texts.some((text) => text.includes(known))) paths.add(known);
    if (paths.size)
      unit.warnings.push(`it names paths of this machine: ${[...paths].sort().join(", ")}`);
    if (unit.kind !== "project" && exclude.includes(unit.name)) {
      unit.state = "excluded";
      unit.reason = "the owner left it out";
    }
  }
  const selected = units.filter((unit) => SENDABLE.includes(unit.state));
  // What the community's copy has that the project no longer does: a loop or role it removed, or one it now leaves as the framework gives it.
  // A loop or role the project still has keeps its published copy, even while it fails its check or is left out.
  const kept = new Set(
    units
      .filter((unit) => unit.state !== "unchanged" && unit.kind !== "project")
      .flatMap((unit) =>
        unit.kind === "role"
          ? [`${dir}/roles/${unit.name}.md`]
          : [`${dir}/loops/${unit.name}.md`, `${dir}/loops/${unit.name}.js`],
      ),
  );
  kept.add(referenceTarget);
  const removed = context.taken ? [] : existing.filter((file) => !kept.has(file)).sort();
  const leaving = selected
    .flatMap((unit) => unit.files.map((file) => ({ target: file.target, sha256: file.sha256 })))
    .sort((a, b) => a.target.localeCompare(b.target));
  const digest =
    reference.problem === null && (leaving.length || removed.length)
      ? sha256(JSON.stringify({ name, leaving, removed }))
      : null;
  const changesFile = writePreview(root, selected);
  const present = (unit: Classified): PlanUnit => {
    const { finals: _finals, before: _before, ...shown } = unit;
    return shown;
  };
  const view = (library: LibrarySource): ResolvedView => ({
    available: true,
    name: library.name,
    checkout: library.checkout,
    remote: library.remote,
    base_branch: library.branch,
    base_commit: library.commit,
    note: library.note,
  });
  return {
    plan: {
      ...shared,
      metadata: { file: metadataPath(root), problem: reference.problem },
      removed,
      library: view(community),
      libraries: libraries.map(view),
      selected: selected.map(present),
      not_selected: units
        .filter((unit) => !SENDABLE.includes(unit.state) && unit.state !== "unchanged")
        .map(present),
      unchanged: units.filter((unit) => unit.state === "unchanged").length,
      changes_file: changesFile,
      library_check: selected.length ? await checkPublication(root, context, selected) : null,
      check: checkState(root, side, digest),
      digest,
    },
    selected,
    community,
  };
}

/**
 * Record the verdict of the project's own check (such as its leak reviewer's) on
 * one plan: a contribution that needs it leaves only with a pass on exactly what
 * leaves.
 */
function recordCheck(
  root: string,
  digest: string,
  verdict: string,
  findings: string[],
): { digest: string; verdict: string } {
  if (!extensionOf(root).needsContributionCheck?.(root, installedRole(root)))
    failA1("NO_CHECK", "this project's contributions need no check of their own");
  if (!/^[0-9a-f]{64}$/.test(digest))
    failA1("INVALID_VALUE", "the digest is the plan's 64 hexadecimal digest");
  if (verdict !== "pass" && verdict !== "fail")
    failA1("INVALID_VALUE", "the verdict is pass or fail");
  if (verdict === "fail" && !findings.length)
    failA1("INVALID_VALUE", "a failed check needs at least one finding");
  fs.mkdirSync(contributionsDir(root), { recursive: true });
  writeStateJsonAtomic(checkPath(root), {
    digest,
    verdict,
    findings,
    at: new Date().toISOString(),
  });
  return { digest, verdict };
}

/**
 * Fetch the community library: beside the Studio's checkout, where the Studio and
 * every project installed from it find it, or in this project when it has none.
 */
function cloneLibrary(root: string): { checkout: string; cloned: boolean } {
  const known = checkoutsOf(root).find((entry) => entry.name === COMMUNITY_LIBRARY);
  if (known) return { checkout: known.checkout, cloned: false };
  const library = installedLibrary(root);
  const target =
    library && isOwnRepository(library)
      ? path.join(library, COMMUNITY_LIBRARY)
      : communityClonePath(root);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const cloned = run("git", ["clone", "--quiet", COMMUNITY_URL, target]);
  if (!cloned.ok)
    failA1("LIBRARY_UNAVAILABLE", `could not clone ${COMMUNITY_URL}: ${cloned.stderr}`);
  return { checkout: target, cloned: true };
}

function githubRepo(url: string): { owner: string; name: string } | null {
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  return match ? { owner: match[1]!, name: match[2]! } : null;
}
function ghProblem(): string | null {
  const version = run("gh", ["--version"]);
  if (version.missing || !version.ok) return "the GitHub CLI (gh) is not installed";
  return run("gh", ["auth", "status"]).ok
    ? null
    : "the GitHub CLI (gh) is not signed in (gh auth login)";
}
/** Push with gh's sign-in, for a machine where gh is signed in and git is not. */
const GH_CREDENTIAL = [
  "-c",
  "credential.helper=",
  "-c",
  "credential.helper=!gh auth git-credential",
];

interface Published {
  pushed: boolean;
  remote: string | null;
  pull_request: string | null;
  compare_url: string | null;
  reason: string | null;
}

/**
 * Push the branch and open the pull request. Someone without write access to the
 * repository goes through a fork of it. Whatever cannot be done is reported, with
 * what is still needed, and never worked around.
 */
function pushAndOpen(
  source: LibrarySource,
  branch: string,
  title: string,
  body: string,
): Published {
  const { checkout, remote, branch: base } = source;
  const stopped = (reason: string, pushed = false, to: string | null = null): Published => ({
    pushed,
    remote: to,
    pull_request: null,
    compare_url: null,
    reason,
  });
  if (!remote) return stopped(`this checkout has no remote; the branch ${branch} stays local`);
  const repo = githubRepo(remote);
  const problem = repo ? ghProblem() : null;
  const push = (...args: string[]) => git(checkout, ...args, "--no-verify", "--quiet", branch);
  let head = branch;
  let pushedTo = remote;
  const direct = git(checkout, "push", "--no-verify", "--quiet", "origin", branch);
  if (!direct.ok) {
    if (!repo) return stopped(`git push failed: ${direct.stderr}`);
    if (problem)
      return stopped(
        `git push failed: ${direct.stderr}. Without write access a contribution goes through a fork, but ${problem}`,
      );
    const slug = `${repo.owner}/${repo.name}`;
    const canPush = run("gh", ["api", `repos/${slug}`, "--jq", ".permissions.push"]);
    if (canPush.stdout.trim() === "true") {
      const again = git(
        checkout,
        ...GH_CREDENTIAL,
        "push",
        "--no-verify",
        "--quiet",
        "origin",
        branch,
      );
      if (!again.ok) return stopped(`git push failed: ${again.stderr}`);
    } else {
      const login = run("gh", ["api", "user", "--jq", ".login"]).stdout.trim();
      if (!login) return stopped("gh could not tell which account is signed in");
      const fork = run("gh", ["repo", "fork", slug, "--clone=false", "--remote=false"]);
      if (!fork.ok) return stopped(`could not fork ${slug}: ${fork.stderr}`);
      pushedTo = `https://github.com/${login}/${repo.name}.git`;
      // A new fork takes a moment to accept pushes.
      let pushed = push(...GH_CREDENTIAL, "push", pushedTo);
      for (let attempt = 0; !pushed.ok && attempt < 5; attempt += 1) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
        pushed = push(...GH_CREDENTIAL, "push", pushedTo);
      }
      if (!pushed.ok) return stopped(`could not push to the fork ${pushedTo}: ${pushed.stderr}`);
      head = `${login}:${branch}`;
    }
  }
  if (!repo)
    return stopped(
      `this remote is not on GitHub: open a pull request from ${branch} into ${base} by hand`,
      true,
      pushedTo,
    );
  const slug = `${repo.owner}/${repo.name}`;
  const compare = `https://github.com/${slug}/compare/${base}...${head}?expand=1`;
  const opened = problem
    ? null
    : run("gh", [
        "pr",
        "create",
        "--repo",
        slug,
        "--base",
        base,
        "--head",
        head,
        "--title",
        title,
        "--body-file",
        body,
      ]);
  if (!opened?.ok)
    return {
      pushed: true,
      remote: pushedTo,
      pull_request: null,
      compare_url: compare,
      reason: `${opened ? `gh pr create failed: ${opened.stderr}` : problem}; open the pull request at this address`,
    };
  return {
    pushed: true,
    remote: pushedTo,
    pull_request: opened.stdout.trim().split("\n").at(-1) ?? null,
    compare_url: null,
    reason: null,
  };
}

function pullRequestText(plan: PublicPlan, units: Classified[]): { title: string; body: string } {
  const project = units.find((unit) => unit.kind === "project");
  const reference = project
    ? (JSON.parse([...project.finals.values()][0]!) as Record<string, any>)
    : null;
  const update = units.some((unit) => unit.state === "changed") || plan.removed.length > 0;
  const title = `project: ${plan.name}${reference?.title?.en ? ` — ${reference.title.en}` : ""}${update ? " (update)" : ""}`;
  const rows = units
    .filter((unit) => unit.kind !== "project")
    .map(
      (unit) =>
        `| ${unit.kind} | \`${unit.name}\` | ${unit.side} | ${unit.state} | ${unit.description.replace(/\|/g, "\\|")} |`,
    );
  const body = [
    `Published from the Studio by a ${plan.side} project after ${plan.finished_tasks.length} finished task(s), with its owner's approval: \`projects/${plan.name}/\`, an example any project can start from.`,
    "",
    ...(reference
      ? [
          `**${reference.title?.en ?? plan.name}** — ${reference.description?.en ?? ""}`,
          "",
          `Task loop \`${reference.task_loop}\`, with ${JSON.stringify(reference.params)}.`,
          "",
        ]
      : []),
    ...(rows.length
      ? [
          "| Kind | Name | Side | Change | What it is |",
          "| --- | --- | --- | --- | --- |",
          ...rows,
          "",
        ]
      : []),
    ...(plan.removed.length
      ? [`Removed: ${plan.removed.map((file) => `\`${file}\``).join(", ")}.`, ""]
      : []),
    `The project's data, keys, task and run records are not in it. \`publish-cli.js\` checked its loops and roles over the framework's library and found no key or token of the project in these files.${
      plan.check === "passed"
        ? " The project's own check of what leaves passed exactly this text."
        : ""
    }`,
    "",
  ].join("\n");
  return { title, body };
}

/** Publish exactly the plan with this digest: one pull request to the community library. */
async function publish(
  root: string,
  digest: string,
  exclude: string[],
  chosenName?: string,
): Promise<
  Published & {
    status: "pushed" | "local-only";
    name: string;
    branch: string;
    base: string;
    files: string[];
    removed: string[];
  }
> {
  const { plan, selected, community } = await makePlan(root, exclude, chosenName);
  if (!plan.library.available || !community)
    failA1("LIBRARY_UNAVAILABLE", plan.library.available ? "" : plan.library.reason);
  if (!plan.eligible)
    failA1(
      "NO_FINISHED_TASK",
      "a project publishes once at least one of its tasks has finished, as its rules count them (by default, a run of its task loop)",
    );
  if (plan.metadata.problem) failA1("NO_DESCRIPTION", plan.metadata.problem);
  if (!plan.digest)
    failA1("NOTHING_TO_PUBLISH", "the community library already has exactly this project");
  if (digest !== plan.digest)
    failA1(
      "PLAN_CHANGED",
      `what would leave is no longer what was approved (the digest is now ${plan.digest}): show the owner the new plan`,
    );
  if (plan.library_check && !plan.library_check.ok)
    failA1("LIBRARY_CHECK_FAILED", plan.library_check.defects.join("; "));
  if (plan.check === "required")
    failA1(
      "CHECK_REQUIRED",
      "this project checks exactly these files before they leave: its check records its verdict on this digest first",
    );
  if (plan.check === "failed")
    failA1("CHECK_FAILED", "the project's check found something in these files that may not leave");

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const stem = `publish/${plan.name}-${stamp}`;
  const taken = (name: string) =>
    git(community.checkout, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`).ok ||
    (community.remote !== null &&
      git(
        community.checkout,
        "ls-remote",
        "--heads",
        "origin",
        `refs/heads/${name}`,
      ).stdout.trim() !== "");
  let branch = stem;
  for (let attempt = 2; taken(branch); attempt += 1) branch = `${stem}-${attempt}`;
  const { title, body } = pullRequestText(plan, selected);
  let failure: string | null = null;
  await inWorktree(root, community, ["-b", branch], (dir) => {
    writeFinals(dir, selected);
    for (const file of plan.removed) git(dir, "rm", "--quiet", "--", file);
    const added = git(dir, "add", "--all", "--", `projects/${plan.name}`);
    // The checkout's own hooks need its dependencies, and the helper's checks already ran on this text.
    const commit = added.ok
      ? git(dir, "commit", "--no-verify", "--quiet", "-m", title, "-m", body)
      : added;
    if (!commit.ok) {
      git(community.checkout, "worktree", "remove", "--force", dir);
      git(community.checkout, "branch", "-D", branch);
      failure = `git could not commit in ${community.checkout}: ${commit.stderr}`;
    }
  });
  if (failure !== null) failA1("COMMIT_FAILED", failure);
  const bodyFile = path.join(contributionsDir(root), "pull-request.md");
  fs.writeFileSync(bodyFile, body);
  const published = pushAndOpen(community, branch, title, bodyFile);
  const files = selected.flatMap((unit) => unit.files);
  if (published.pushed) {
    const log = readJson(logPath(root));
    const entries = isRecord(log) && Array.isArray(log.contributions) ? log.contributions : [];
    writeStateJsonAtomic(logPath(root), {
      schema_version: 1,
      contributions: [
        ...entries,
        {
          at: new Date().toISOString(),
          name: plan.name,
          branch,
          base: community.branch,
          remote: published.remote,
          pull_request: published.pull_request,
          files: files.map((file) => ({ target: file.target, sha256: file.sha256 })),
          removed: plan.removed,
        },
      ],
    });
    // The project's published state: where its latest publication is.
    writeStateJsonAtomic(publishedPath(root), {
      schema_version: 1,
      name: plan.name,
      at: new Date().toISOString(),
      branch,
      pull_request: published.pull_request,
      compare_url: published.compare_url,
    });
  }
  fs.rmSync(previewDir(root), { recursive: true, force: true });
  return {
    status: published.pushed ? "pushed" : "local-only",
    name: plan.name,
    branch,
    base: community.branch,
    ...published,
    files: files.map((file) => file.target),
    removed: plan.removed,
  };
}

function cli(): void {
  const program = createCli("publish", "Publish this project to the community library");
  const names = (value: string | undefined) =>
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  const action = (work: () => unknown | Promise<unknown>) => async () => {
    try {
      // The project's extension decides what counts as a finished task, what is secret and what is checked.
      const project = program.commands
        .map((command) => command.opts() as { project?: string })
        .find((options) => options.project)?.project;
      if (project) loadedExtension = await loadExtension(path.resolve(project));
      const result = await work();
      console.log(JSON.stringify(result, null, 2));
      // Something approved did not leave: the owner hears why.
      if (isRecord(result) && ["local-only", "partly-pushed"].includes(String(result.status)))
        process.exitCode = 1;
    } catch (error) {
      console.error(
        JSON.stringify(
          {
            status: "failed",
            reason: error instanceof A1Error ? error.code : "library_command_failed",
            message: (error as Error).message,
          },
          null,
          2,
        ),
      );
      process.exitCode = 1;
    }
  };
  program
    .command("plan")
    .description(
      "List what publishing this project would put in the community library, with the digest publish requires",
    )
    .requiredOption("--project <dir>")
    .option("--name <name>", "the name to publish it under (default: the project's folder name)")
    .option("--exclude <names>", "comma-separated loops and roles the owner leaves out")
    .action((options: { project: string; name?: string; exclude?: string }) =>
      action(
        async () =>
          (await makePlan(path.resolve(options.project), names(options.exclude), options.name))
            .plan,
      )(),
    );
  program
    .command("clone")
    .description("Fetch a checkout of the community library, for a project without one")
    .requiredOption("--project <dir>")
    .action((options: { project: string }) =>
      action(() => cloneLibrary(path.resolve(options.project)))(),
    );
  program
    .command("record-check")
    .description("Record the verdict of the project's own check on one plan of what would leave")
    .requiredOption("--project <dir>")
    .requiredOption("--digest <sha256>")
    .requiredOption("--verdict <verdict>", "pass or fail")
    .option("--finding <text...>", "where each problem is and what kind, without its content")
    .action((options: { project: string; digest: string; verdict: string; finding?: string[] }) =>
      action(() =>
        recordCheck(
          path.resolve(options.project),
          options.digest,
          options.verdict,
          options.finding ?? [],
        ),
      )(),
    );
  program
    .command("publish")
    .description(
      "Publish exactly the plan with this digest, as a pull request to the community library",
    )
    .requiredOption("--project <dir>")
    .requiredOption("--digest <sha256>", "the digest of the plan the owner approved")
    .option("--name <name>", "the same name the plan was made with")
    .option("--exclude <names>", "the same list the plan was made with")
    .action((options: { project: string; digest: string; name?: string; exclude?: string }) =>
      action(() =>
        publish(
          path.resolve(options.project),
          options.digest,
          names(options.exclude),
          options.name,
        ),
      )(),
    );
  runCli(program);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli();
