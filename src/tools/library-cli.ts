#!/usr/bin/env node
/**
 * The library-contributor role's tool. When the owner decides to contribute, the
 * loops and roles of this project the owner chooses, the ones it made and its own
 * versions of the ones it was given, go to the community library,
 * agent-loop-community, once at least one of the project's tasks has finished.
 * What a project improves stays in the project until its owner contributes it.
 *
 * The installer keeps a copy of every file it seeded in `.contrejour/seeded/`:
 * against that baseline, a file the project left alone is never sent, and one it
 * changed is merged three ways with what the community library holds of it, so a
 * contribution cannot undo anyone else's work. `plan` lists what would leave and
 * binds it to a digest, which `contribute` requires, so what leaves is what the
 * owner approved.
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
  sidesOf,
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
  /** Sent: the library does not have it. */
  | "new"
  /** Sent: the project changed it and the library did not. */
  | "changed"
  /** Sent: both changed it, in different places, and the two merge cleanly. */
  | "merged"
  /** Not sent: both changed it in a way that needs a person, or the library holds another file of this name. */
  | "conflict"
  /** Not sent: the project left it as seeded, whatever the library did since. */
  | "unchanged"
  /** Not sent: the library already has exactly this. */
  | "in-library"
  /** Not sent: an earlier contribution already carries exactly this. */
  | "already-contributed"
  /** Not sent: seeded by a release that kept no baseline, so what the project changed is unknown. */
  | "unknown-base"
  /** Not sent: not in the form of a Contrejour role or loop, or its check fails. */
  | "invalid"
  /** Not sent: it serves the other side. */
  | "wrong-side"
  /** Not sent: it holds a key, a token, a hidden path or an injection pattern. */
  | "blocked"
  /** Not sent: the owner left it out. */
  | "excluded";
const SENDABLE: readonly State[] = ["new", "changed", "merged"];

interface PlanFile {
  source: string;
  target: string;
  sha256: string;
  /** The exact text that would leave. */
  preview?: string;
}
interface PlanUnit {
  kind: "role" | "loop";
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
  /** At least one task finished, as the project counts them (a run of its task loop, unless it says otherwise). */
  eligible: boolean;
  finished_tasks: string[];
  /** The library a contribution goes to: the community's. */
  library: LibraryView;
  /** Every library a unit can go to: that checkout's, then the framework's and the community's it carries. */
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
/** The framework's library and the community's, as a project package carries them. */
const FRAMEWORK_LIBRARY = "agent-loop-studio";
const COMMUNITY_LIBRARY = "agent-loop-community";
/** Where the community library is, for a project whose checkout does not carry it. */
const COMMUNITY_URL = "https://github.com/justforyou16007/agent-loop-community.git";
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
    for (const name of [FRAMEWORK_LIBRARY, COMMUNITY_LIBRARY]) {
      const checkout = path.join(main, name);
      if (fs.existsSync(path.join(checkout, "library")) && isOwnRepository(checkout))
        found.push({ name, checkout });
    }
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
  const hasLibrary = (ref: string) => git(checkout, "cat-file", "-e", `${ref}:library/roles`).ok;
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
      `no branch of ${checkout} holds library/roles: neither the default branch nor the branch it is on`,
    );
  if (defaultBranch && base.branch !== defaultBranch)
    notes.push(
      `the default branch ${defaultBranch} has no library yet, so this contribution targets ${base.branch}`,
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
function compare(
  ours: string,
  base: string | null,
  theirs: string | null,
  sent: Set<string>,
  seeded: boolean,
): { state: State | "both-moved"; reason?: string } {
  if (theirs !== null && ours === theirs) return { state: "in-library" };
  // Seeded by a release that kept no baseline: what the project changed cannot be told.
  if (base === null && seeded)
    return {
      state: "unknown-base",
      reason:
        "this project was installed before baselines were kept, so what it changed cannot be told: install into a fresh project to contribute it",
    };
  // The community library has no file of this name: it is new there, whatever the project started from.
  if (theirs === null) return { state: "new" };
  // The community holds what this project started from, or what it sent earlier: only this project moved since.
  if (base === theirs || sent.has(sha256(theirs))) return { state: "changed" };
  if (base !== null) return { state: "both-moved" };
  return {
    state: "conflict",
    reason: "the community library already has a different file of this name",
  };
}

/** The three-way merge of a role both sides changed, or null when it needs a person. */
function merged(ours: string, base: string, theirs: string): string | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "contrejour-merge-"));
  try {
    const files = { ours, base, theirs };
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
    const result = run("git", ["merge-file", "-p", "ours", "base", "theirs"], dir);
    return result.ok ? normal(result.stdout) : null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  /** The text that would leave, by library path. */
  finals: Map<string, string>;
  /** The library's current text, by library path, where it has one. */
  before: Map<string, string>;
}

interface PlanContext {
  root: string;
  side: Role;
  /** The library sides this project receives, `framework` first. */
  sides: string[];
  /** The libraries a unit can go to, the checkout the project was installed from first. */
  libraries: LibrarySource[];
  sent: Map<string, Set<string>>;
  seeded: Set<string>;
}

function showAtBase(library: LibrarySource, target: string): string | null {
  const shown = git(library.checkout, "show", `${library.ref}:${target}`);
  return shown.ok ? normal(shown.stdout) : null;
}
/** The side folders a library has under `library/loops` or `library/roles`, as of its base. */
function sidesAt(library: LibrarySource, directory: string): string[] {
  const listed = git(
    library.checkout,
    "ls-tree",
    "--name-only",
    "-d",
    `${library.ref}:library/${directory}`,
  );
  return listed.stdout.split("\n").filter(Boolean);
}

/** The community library, where every contribution goes; a plan has one before it classifies anything. */
const communityOf = (context: PlanContext): LibrarySource =>
  context.libraries.find((library) => library.name === COMMUNITY_LIBRARY)!;

/**
 * A side's project receives the loops and roles any project can use (`framework`)
 * and its side's; a name must stay unique across them, in every library. One any
 * project can use may share its name only with the framework's own of that name,
 * which the community's version takes the place of; one of a side may not share
 * its name with one any project can use.
 */
function nameTakenElsewhere(
  context: PlanContext,
  destination: LibrarySource,
  directory: string,
  unitSide: string,
  file: string,
): string | undefined {
  for (const library of context.libraries)
    for (const side of sidesAt(library, directory)) {
      if (library === destination && side === unitSide) continue;
      if (unitSide === "framework" ? side === "framework" : side !== "framework") continue;
      if (showAtBase(library, `library/${directory}/${side}/${file}`) !== null)
        return context.libraries.length > 1 ? `${side} in ${library.name}` : side;
    }
  return undefined;
}

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
    library: null,
    description: fields.description ?? "",
    state: "unchanged",
    warnings: [],
    files: [],
    finals: new Map(),
    before: new Map(),
  };
  if (base !== null && ours === base) return unit;
  const defects = checkRoles(root, [name])[0]?.defects ?? [];
  if (defects.length)
    return {
      ...unit,
      state: "invalid",
      reason: `not in the form of a Contrejour role, so it stays in this project: ${defects.join("; ")}`,
    };
  if (!context.sides.includes(fields.side ?? ""))
    return {
      ...unit,
      state: "wrong-side",
      reason: `it serves the ${fields.side} side, and this ${side} project receives ${context.sides.join(" and ")}`,
    };
  const target = `library/roles/${fields.side}/${name}.md`;
  const library = communityOf(context);
  const taken = nameTakenElsewhere(context, library, "roles", fields.side, `${name}.md`);
  if (taken)
    return {
      ...unit,
      library: library.name,
      state: "conflict",
      reason: `the library has a role of this name under ${taken}`,
    };
  const theirs = showAtBase(library, target);
  const sent = context.sent.get(target) ?? new Set<string>();
  const verdict = compare(ours, base, theirs, sent, context.seeded.has(source));
  let final = ours;
  let state: State;
  let reason = verdict.reason;
  if (verdict.state === "both-moved") {
    const result = merged(ours, base!, theirs!);
    if (result === null) {
      state = "conflict";
      reason =
        "this project and the library changed the same part of it: bring the library's change into this project's copy by hand, then plan again";
    } else {
      state = "merged";
      final = result;
    }
  } else state = verdict.state;
  if (SENDABLE.includes(state) && sent.has(sha256(final))) {
    state = "already-contributed";
    reason = "an earlier contribution from this project already carries exactly this";
  }
  return {
    ...unit,
    library: library.name,
    state,
    ...(reason ? { reason } : {}),
    files: [{ source, target, sha256: sha256(final) }],
    finals: new Map([[target, final]]),
    before: new Map(theirs === null ? [] : [[target, theirs]]),
  };
}

async function classifyLoop(context: PlanContext, name: string): Promise<Classified> {
  const { root, side } = context;
  const definitionSource = `.claude/loops/${name}.md`;
  const scriptSource = `.claude/workflows/${name}.js`;
  const definition = readText(loopDefinitionPath(root, name)) ?? "";
  const script = readText(loopScriptPath(root, name));
  const fields = frontmatter(definition);
  const baseDefinition = readText(seededFile(root, definitionSource));
  const baseScript = readText(seededFile(root, scriptSource));
  const unit: Classified = {
    kind: "loop",
    name,
    side: fields.side ?? null,
    library: null,
    description: fields.description ?? "",
    state: "unchanged",
    warnings: [],
    files: [],
    finals: new Map(),
    before: new Map(),
  };
  if (baseDefinition !== null && definition === baseDefinition && script === baseScript)
    return unit;
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
  const library = communityOf(context);
  const pairs = [
    { source: definitionSource, ours: definition, base: baseDefinition, ext: "md" },
    { source: scriptSource, ours: script ?? "", base: baseScript, ext: "js" },
  ].map((pair) => {
    const target = `library/loops/${fields.side}/${name}.${pair.ext}`;
    const theirs = showAtBase(library, target);
    const sent = context.sent.get(target) ?? new Set<string>();
    const seeded = context.seeded.has(pair.source);
    return {
      ...pair,
      target,
      theirs,
      sent,
      verdict: compare(pair.ours, pair.base, theirs, sent, seeded),
    };
  });
  const files = pairs.map((pair) => ({
    source: pair.source,
    target: pair.target,
    sha256: sha256(pair.ours),
  }));
  const whole = {
    ...unit,
    library: library.name,
    files,
    finals: new Map(pairs.map((pair) => [pair.target, pair.ours])),
    before: new Map(
      pairs.flatMap((pair) =>
        pair.theirs === null ? [] : ([[pair.target, pair.theirs]] as [string, string][]),
      ),
    ),
  };
  if (pairs.every((pair) => pair.verdict.state === "in-library"))
    return { ...whole, state: "in-library" };
  if (pairs.some((pair) => pair.verdict.state === "both-moved"))
    return {
      ...whole,
      state: "conflict",
      reason:
        "this project and the library both changed this loop: a script is generated from its definition, so have loop-editor merge the definition and regenerate the script",
    };
  const stuck = pairs.find((pair) => ["conflict", "unknown-base"].includes(pair.verdict.state));
  if (stuck)
    return {
      ...whole,
      state: stuck.verdict.state as State,
      ...(stuck.verdict.reason ? { reason: stuck.verdict.reason } : {}),
    };
  if (pairs.every((pair) => pair.sent.has(sha256(pair.ours))))
    return {
      ...whole,
      state: "already-contributed",
      reason: "an earlier contribution from this project already carries exactly this",
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
 * The defects, in the libraries this contribution would produce, of what it
 * carries: checked as a project receives them, the framework's and the
 * community's library laid under the package's, with the planned text in place.
 */
async function checkResult(
  root: string,
  libraries: LibrarySource[],
  selected: Classified[],
): Promise<{ ok: boolean; defects: string[] }> {
  const merged = fs.mkdtempSync(path.join(os.tmpdir(), "contrejour-contribution-check-"));
  try {
    // Underneath, what the libraries gave this project, as it got them: a library this project
    // has no checkout of (its package's, when it was installed from an archive) still counts.
    layBaselines(root, path.join(merged, "library"));
    // As a project gets them: the framework's library, the community's over it, the package's over both.
    // A checkout that holds the framework's own folder (the framework's checkout itself) is the framework's.
    const main = libraries[0]!;
    const community = libraries.filter((library) => library.name === COMMUNITY_LIBRARY);
    const framework = libraries.filter(
      (library) => library !== main && !community.includes(library),
    );
    const mainIsFramework =
      sidesAt(main, "loops").includes("framework") || sidesAt(main, "roles").includes("framework");
    const order = mainIsFramework
      ? [main, ...framework, ...community]
      : [...framework, ...community, ...(community.includes(main) ? [] : [main])];
    for (const library of order)
      await inWorktree(root, library, ["--detach"], (dir) => {
        if (fs.existsSync(path.join(dir, "library")))
          fs.cpSync(path.join(dir, "library"), path.join(merged, "library"), {
            recursive: true,
            filter: (file) => path.basename(file) !== ".gitkeep",
          });
      });
    writeFinals(merged, selected);
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

/** The loops and roles the installer seeded into this project, as seeded, by their side, as a library holds them. */
function layBaselines(root: string, library: string): void {
  const seeded = path.join(root, ".contrejour", "seeded");
  for (const [from, kind, extension] of [
    ["agents", "roles", ".md"],
    ["loops", "loops", ".md"],
  ] as const) {
    const dir = path.join(seeded, from);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((entry) => entry.endsWith(extension))) {
      const text = fs.readFileSync(path.join(dir, file), "utf8");
      const side = frontmatter(text).side;
      if (!side) continue;
      const target = path.join(library, kind, side);
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, file), text);
      // A loop's script goes beside its definition.
      const script = path.join(seeded, "workflows", file.replace(/\.md$/, ".js"));
      if (kind === "loops" && fs.existsSync(script))
        fs.copyFileSync(script, path.join(target, path.basename(script)));
    }
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
    reason: `no checkout of the community library is recorded for this project: \`library-cli.js clone\` fetches one from ${COMMUNITY_URL}`,
    upstream: COMMUNITY_URL,
  };
}

async function makePlan(
  root: string,
  exclude: string[],
): Promise<{ plan: PublicPlan; selected: Classified[]; libraries: LibrarySource[] }> {
  const side = installedRole(root);
  const finished = finishedTasks(root, side, extensionOf(root));
  const shared = {
    project: projectSlug(root),
    side,
    eligible: finished.length > 0,
    finished_tasks: finished,
  };
  const checkouts = checkoutsOf(root);
  const missing = missingLibrary(checkouts);
  if (missing) {
    return {
      plan: {
        ...shared,
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
      libraries: [],
    };
  }
  const libraries = checkouts.map(({ name, checkout }) => resolveLibrary(name, checkout));
  const installed = readJson(installationFile(root));
  const context: PlanContext = {
    root,
    side,
    sides: sidesOf(root),
    libraries,
    sent: sentHashes(root),
    seeded: new Set(
      isRecord(installed) && Array.isArray(installed.seeded) ? (installed.seeded as string[]) : [],
    ),
  };
  const units: Classified[] = [];
  const roles = rolesDir(root);
  if (fs.existsSync(roles))
    for (const file of fs.readdirSync(roles).sort())
      if (file.endsWith(".md")) units.push(classifyRole(context, file.slice(0, -3)));
  for (const name of listLoops(root)) units.push(await classifyLoop(context, name));

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
    if (exclude.includes(unit.name)) {
      unit.state = "excluded";
      unit.reason = "the owner left it out";
    }
  }
  const selected = units.filter((unit) => SENDABLE.includes(unit.state));
  const leaving = selected
    .flatMap((unit) =>
      unit.files.map((file) => ({
        library: unit.library,
        target: file.target,
        sha256: file.sha256,
      })),
    )
    .sort((a, b) => `${a.library}/${a.target}`.localeCompare(`${b.library}/${b.target}`));
  const digest = leaving.length ? sha256(JSON.stringify(leaving)) : null;
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
      library: view(libraries.find((library) => library.name === COMMUNITY_LIBRARY)!),
      libraries: libraries.map(view),
      selected: selected.map(present),
      not_selected: units
        .filter((unit) => !SENDABLE.includes(unit.state) && unit.state !== "unchanged")
        .map(present),
      unchanged: units.filter((unit) => unit.state === "unchanged").length,
      changes_file: changesFile,
      library_check: selected.length ? await checkResult(root, libraries, selected) : null,
      check: checkState(root, side, digest),
      digest,
    },
    selected,
    libraries,
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

function cloneLibrary(root: string): { checkout: string; cloned: boolean } {
  const known = checkoutsOf(root).find((entry) => entry.name === COMMUNITY_LIBRARY);
  if (known) return { checkout: known.checkout, cloned: false };
  const target = communityClonePath(root);
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

function pullRequestText(plan: PublicPlan, units: PlanUnit[]): { title: string; body: string } {
  const added = units.filter((unit) => unit.state === "new").length;
  const changed = units.length - added;
  const title = `library: ${plan.project} (${plan.side}): ${[
    ...(added ? [`${added} new`] : []),
    ...(changed ? [`${changed} changed`] : []),
  ].join(", ")}`;
  const rows = units.map(
    (unit) =>
      `| ${unit.kind} | \`${unit.name}\` | ${unit.side} | ${unit.state} | ${unit.description.replace(/\|/g, "\\|")} |`,
  );
  const body = [
    `Contributed by a ${plan.side} project after ${plan.finished_tasks.length} finished task(s), through \`library-contribution\`: the loops and roles its owner chose to share, with the owner's approval.`,
    "",
    "| Kind | Name | Side | Change | What it is |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    `A changed one holds the project's version, merged with what changed here meanwhile; nothing else here is touched. \`library-cli.js\` ran the loop and role checks on the resulting library and found no key or token of the project in these files.${
      plan.check === "passed"
        ? " The project's own check of what leaves passed exactly this text."
        : ""
    }`,
    "",
  ].join("\n");
  return { title, body };
}

interface Sent extends Published {
  library: string;
  status: "pushed" | "local-only" | "not-committed";
  branch: string | null;
  base: string;
  files: string[];
}

/** Commit one library's part on a new branch, push it and open its pull request. */
async function sendTo(
  root: string,
  plan: PublicPlan,
  library: LibrarySource,
  units: Classified[],
): Promise<Sent> {
  const files = units.flatMap((unit) => unit.files);
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const stem = `library/${plan.project}-${plan.side}-${stamp}`;
  const taken = (name: string) =>
    git(library.checkout, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`).ok ||
    (library.remote !== null &&
      git(
        library.checkout,
        "ls-remote",
        "--heads",
        "origin",
        `refs/heads/${name}`,
      ).stdout.trim() !== "");
  let branch = stem;
  for (let attempt = 2; taken(branch); attempt += 1) branch = `${stem}-${attempt}`;

  const { title, body } = pullRequestText(plan, units);
  let failure: string | null = null;
  await inWorktree(root, library, ["-b", branch], (dir) => {
    writeFinals(dir, units);
    const added = git(dir, "add", "--", "library");
    // The checkout's own hooks need its dependencies, and helper checks already ran on this text.
    const commit = added.ok
      ? git(dir, "commit", "--no-verify", "--quiet", "-m", title, "-m", body)
      : added;
    if (!commit.ok) {
      git(library.checkout, "worktree", "remove", "--force", dir);
      git(library.checkout, "branch", "-D", branch);
      failure = `git could not commit in ${library.checkout}: ${commit.stderr}`;
    }
  });
  if (failure !== null)
    return {
      library: library.name,
      status: "not-committed",
      branch: null,
      base: library.branch,
      pushed: false,
      remote: null,
      pull_request: null,
      compare_url: null,
      reason: failure,
      files: files.map((file) => file.target),
    };

  const bodyFile = path.join(contributionsDir(root), "pull-request.md");
  fs.writeFileSync(bodyFile, body);
  const published = pushAndOpen(library, branch, title, bodyFile);
  if (published.pushed) {
    const log = readJson(logPath(root));
    const contributions =
      isRecord(log) && Array.isArray(log.contributions) ? log.contributions : [];
    writeStateJsonAtomic(logPath(root), {
      schema_version: 1,
      contributions: [
        ...contributions,
        {
          at: new Date().toISOString(),
          library: library.name,
          branch,
          base: library.branch,
          remote: published.remote,
          pull_request: published.pull_request,
          files: files.map((file) => ({ target: file.target, sha256: file.sha256 })),
        },
      ],
    });
  }
  return {
    library: library.name,
    status: published.pushed ? "pushed" : "local-only",
    branch,
    base: library.branch,
    ...published,
    files: files.map((file) => file.target),
  };
}

async function contribute(
  root: string,
  digest: string,
  exclude: string[],
): Promise<{
  status: "pushed" | "partly-pushed" | "local-only";
  reason: string | null;
  pull_requests: Sent[];
  files: string[];
}> {
  const { plan, selected, libraries } = await makePlan(root, exclude);
  if (!plan.library.available || !libraries.length)
    failA1("LIBRARY_UNAVAILABLE", plan.library.available ? "" : plan.library.reason);
  if (!plan.eligible)
    failA1(
      "NO_FINISHED_TASK",
      "a project contributes once at least one of its tasks has finished, as its rules count them (by default, a run of its task loop)",
    );
  if (!plan.digest)
    failA1("NOTHING_TO_CONTRIBUTE", "this project has nothing new or changed to contribute");
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

  // Every contribution goes to the community library: one pull request.
  const sent: Sent[] = [];
  for (const library of libraries) {
    const units = selected.filter((unit) => unit.library === library.name);
    if (units.length) sent.push(await sendTo(root, plan, library, units));
  }
  fs.rmSync(previewDir(root), { recursive: true, force: true });
  const pushed = sent.filter((entry) => entry.pushed).length;
  const reasons = sent
    .filter((entry) => entry.reason)
    .map((entry) => (sent.length > 1 ? `${entry.library}: ${entry.reason}` : entry.reason!));
  return {
    status: pushed === sent.length ? "pushed" : pushed ? "partly-pushed" : "local-only",
    reason: reasons.join("; ") || null,
    pull_requests: sent,
    files: sent.flatMap((entry) => entry.files),
  };
}

function cli(): void {
  const program = createCli("library", "Contribute a project's loops and roles to the library");
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
      "List the loops and roles this project could contribute, new and changed, with the digest contribute requires",
    )
    .requiredOption("--project <dir>")
    .option("--exclude <names>", "comma-separated loops and roles the owner leaves out")
    .action((options: { project: string; exclude?: string }) =>
      action(
        async () => (await makePlan(path.resolve(options.project), names(options.exclude))).plan,
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
    .command("contribute")
    .description(
      "Send exactly what the plan with this digest lists, as a pull request to the community library",
    )
    .requiredOption("--project <dir>")
    .requiredOption("--digest <sha256>", "the digest of the plan the owner approved")
    .option("--exclude <names>", "the same list the plan was made with")
    .action((options: { project: string; digest: string; exclude?: string }) =>
      action(() =>
        contribute(path.resolve(options.project), options.digest, names(options.exclude)),
      )(),
    );
  runCli(program);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli();
