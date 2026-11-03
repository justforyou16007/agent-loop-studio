#!/usr/bin/env node
/**
 * The library-contributor role's tool. A project sends what it added or changed
 * back to the shared library as a pull request, once at least one of its tasks
 * has finished. The installer keeps a copy of every file it seeded in
 * `.contrejour/seeded/`: against that baseline, a file the project left alone is
 * never sent, however far the library has moved on, so a contribution cannot undo
 * anyone else's work. `plan` lists what would leave and binds it to a digest,
 * which `contribute` requires, so what leaves is what the owner approved.
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
  description: string;
  state: State;
  reason?: string;
  warnings: string[];
  files: PlanFile[];
}
type LibraryView =
  | {
      available: true;
      checkout: string;
      remote: string | null;
      base_branch: string;
      base_commit: string;
      note: string | null;
    }
  | { available: false; reason: string; upstream: string | null };
interface PublicPlan {
  project: string;
  side: Role;
  /** At least one task finished, as the project counts them (a run of its task loop, unless it says otherwise). */
  eligible: boolean;
  finished_tasks: string[];
  library: LibraryView;
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

/** Where a project without a checkout can get one: the repository this release came from. */
function upstreamUrl(root: string): string | null {
  const installed = readJson(path.join(root, ".contrejour", "package.json"));
  const repository = isRecord(installed) ? installed.repository : null;
  const url = isRecord(repository) ? repository.url : repository;
  return typeof url === "string" && url ? url.replace(/^git\+/, "") : null;
}
function checkoutOf(root: string): string | null {
  for (const candidate of [installedLibrary(root), clonePath(root)])
    if (candidate && fs.existsSync(candidate) && git(candidate, "rev-parse", "--git-dir").ok)
      return candidate;
  return null;
}

/**
 * The branch a contribution starts from and asks to merge into: the remote's
 * default branch, as of now. A repository whose default branch has no library yet
 * falls back to the branch this checkout is on, and says so.
 */
function resolveLibrary(checkout: string): LibrarySource {
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
  if (theirs === null)
    return base === null && !seeded
      ? { state: "new" }
      : { state: "conflict", reason: "the library no longer has this file" };
  // The library holds what this project sent earlier, so only this project moved since.
  if (base === theirs || sent.has(sha256(theirs))) return { state: "changed" };
  if (base !== null) return { state: "both-moved" };
  return seeded
    ? {
        state: "unknown-base",
        reason:
          "this project was installed before baselines were kept, so what it changed cannot be told from what the library changed: install into a fresh project to contribute it",
      }
    : { state: "conflict", reason: "the library already has a different file of this name" };
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
  source: LibrarySource;
  sent: Map<string, Set<string>>;
  seeded: Set<string>;
}

function showAtBase(context: PlanContext, target: string): string | null {
  const shown = git(context.source.checkout, "show", `${context.source.ref}:${target}`);
  return shown.ok ? normal(shown.stdout) : null;
}

/** A side's project receives the framework's files and its own; a name must stay unique across them. */
function nameTakenElsewhere(
  context: PlanContext,
  directory: string,
  unitSide: string,
  file: string,
) {
  const sides = (directory: string) =>
    (
      git(
        context.source.checkout,
        "ls-tree",
        "--name-only",
        `${context.source.ref}:library/${directory}`,
      ).stdout || ""
    )
      .split("\n")
      .filter(Boolean);
  const others =
    unitSide === "framework"
      ? sides(directory).filter((side) => side !== "framework")
      : ["framework"];
  return others.find((other) => showAtBase(context, `library/${directory}/${other}/${file}`));
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
  if (fields.side !== "framework" && fields.side !== side)
    return {
      ...unit,
      state: "wrong-side",
      reason: `it serves the ${fields.side} side, and this is a ${side} project`,
    };
  const target = `library/roles/${fields.side}/${name}.md`;
  const taken = nameTakenElsewhere(context, "roles", fields.side, `${name}.md`);
  if (taken)
    return {
      ...unit,
      state: "conflict",
      reason: `the library has a role of this name under ${taken}`,
    };
  const theirs = showAtBase(context, target);
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
    description: fields.description ?? "",
    state: "unchanged",
    warnings: [],
    files: [],
    finals: new Map(),
    before: new Map(),
  };
  if (baseDefinition !== null && definition === baseDefinition && script === baseScript)
    return unit;
  if (fields.side !== "framework" && fields.side !== side)
    return {
      ...unit,
      state: "wrong-side",
      reason: `it serves the ${fields.side ?? "unnamed"} side, and this is a ${side} project`,
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
    { source: definitionSource, ours: definition, base: baseDefinition, ext: "md" },
    { source: scriptSource, ours: script ?? "", base: baseScript, ext: "js" },
  ].map((pair) => {
    const target = `library/loops/${fields.side}/${name}.${pair.ext}`;
    const theirs = showAtBase(context, target);
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
async function checkResult(
  root: string,
  source: LibrarySource,
  selected: Classified[],
): Promise<{ ok: boolean; defects: string[] }> {
  return inWorktree(root, source, ["--detach"], async (dir) => {
    writeFinals(dir, selected);
    const { reports } = await checkLibrary(
      path.join(dir, "library"),
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
  });
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
  writeFinals(after, selected);
  for (const unit of selected) {
    for (const [target, text] of unit.before) {
      const file = path.join(before, ...target.split("/"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
    for (const file of unit.files) file.preview = path.join(after, ...file.target.split("/"));
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

async function makePlan(
  root: string,
  exclude: string[],
): Promise<{ plan: PublicPlan; selected: Classified[]; source: LibrarySource | null }> {
  const side = installedRole(root);
  const finished = finishedTasks(root, side, extensionOf(root));
  const shared = {
    project: projectSlug(root),
    side,
    eligible: finished.length > 0,
    finished_tasks: finished,
  };
  const checkout = checkoutOf(root);
  if (!checkout) {
    const upstream = upstreamUrl(root);
    return {
      plan: {
        ...shared,
        library: {
          available: false,
          reason: `no checkout of the Contrejour repository is recorded for this project${
            upstream ? `: \`library-cli.js clone\` fetches one from ${upstream}` : ""
          }`,
          upstream,
        },
        selected: [],
        not_selected: [],
        unchanged: 0,
        changes_file: null,
        library_check: null,
        check: checkState(root, side, null),
        digest: null,
      },
      selected: [],
      source: null,
    };
  }
  const source = resolveLibrary(checkout);
  const installed = readJson(installationFile(root));
  const context: PlanContext = {
    root,
    side,
    source,
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
    for (const known of [root, checkout, home])
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
    .flatMap((unit) => unit.files)
    .map((file) => ({ target: file.target, sha256: file.sha256 }))
    .sort((a, b) => a.target.localeCompare(b.target));
  const digest = leaving.length ? sha256(JSON.stringify(leaving)) : null;
  const changesFile = writePreview(root, selected);
  const present = (unit: Classified): PlanUnit => {
    const { finals: _finals, before: _before, ...shown } = unit;
    return shown;
  };
  return {
    plan: {
      ...shared,
      library: {
        available: true,
        checkout,
        remote: source.remote,
        base_branch: source.branch,
        base_commit: source.commit,
        note: source.note,
      },
      selected: selected.map(present),
      not_selected: units
        .filter((unit) => !SENDABLE.includes(unit.state) && unit.state !== "unchanged")
        .map(present),
      unchanged: units.filter((unit) => unit.state === "unchanged").length,
      changes_file: changesFile,
      library_check: selected.length ? await checkResult(root, source, selected) : null,
      check: checkState(root, side, digest),
      digest,
    },
    selected,
    source,
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
  const existing = checkoutOf(root);
  if (existing) return { checkout: existing, cloned: false };
  const upstream = upstreamUrl(root);
  if (!upstream)
    failA1(
      "LIBRARY_UNAVAILABLE",
      "this release names no repository: install from a local checkout, or run the installer with --library",
    );
  const target = clonePath(root);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const cloned = run("git", ["clone", "--quiet", upstream, target]);
  if (!cloned.ok) failA1("LIBRARY_UNAVAILABLE", `could not clone ${upstream}: ${cloned.stderr}`);
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

function pullRequestText(plan: PublicPlan): { title: string; body: string } {
  const added = plan.selected.filter((unit) => unit.state === "new").length;
  const changed = plan.selected.length - added;
  const title = `library: ${plan.project} (${plan.side}): ${[
    ...(added ? [`${added} new`] : []),
    ...(changed ? [`${changed} changed`] : []),
  ].join(", ")}`;
  const rows = plan.selected.map(
    (unit) =>
      `| ${unit.kind} | \`${unit.name}\` | ${unit.side} | ${unit.state} | ${unit.description.replace(/\|/g, "\\|")} |`,
  );
  const body = [
    `Contributed from a ${plan.side} project after ${plan.finished_tasks.length} finished task(s), through the \`library-contributor\` role, with the owner's approval.`,
    "",
    "| Kind | Name | Side | Change | What it is |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    `This holds only what the project added or changed since it was installed; what the library changed meanwhile is untouched. \`library-cli.js\` ran the loop and role checks on the resulting library and found no key or token of the project in these files.${
      plan.check === "passed"
        ? " The project's own check of what leaves passed exactly this text."
        : ""
    }`,
    "",
  ].join("\n");
  return { title, body };
}

async function contribute(
  root: string,
  digest: string,
  exclude: string[],
): Promise<Published & { status: string; branch: string; base: string; files: string[] }> {
  const { plan, selected, source } = await makePlan(root, exclude);
  if (!plan.library.available || !source)
    failA1("LIBRARY_UNAVAILABLE", plan.library.available ? "" : plan.library.reason);
  if (!plan.eligible)
    failA1(
      "NO_FINISHED_TASK",
      "a project contributes once at least one task has finished: one submission whose review ended and whose result was published",
    );
  if (!plan.digest) failA1("NOTHING_TO_CONTRIBUTE", "this project has nothing new to send");
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
  const stem = `library/${plan.project}-${plan.side}-${stamp}`;
  const taken = (name: string) =>
    git(source.checkout, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`).ok ||
    (source.remote !== null &&
      git(source.checkout, "ls-remote", "--heads", "origin", `refs/heads/${name}`).stdout.trim() !==
        "");
  let branch = stem;
  for (let attempt = 2; taken(branch); attempt += 1) branch = `${stem}-${attempt}`;

  const { title, body } = pullRequestText(plan);
  let committed = false;
  await inWorktree(root, source, ["-b", branch], (dir) => {
    writeFinals(dir, selected);
    const added = git(dir, "add", "--", "library");
    // The checkout's own hooks need its dependencies, and helper checks already ran on this text.
    const commit = added.ok
      ? git(dir, "commit", "--no-verify", "--quiet", "-m", title, "-m", body)
      : added;
    if (!commit.ok) {
      git(source.checkout, "worktree", "remove", "--force", dir);
      git(source.checkout, "branch", "-D", branch);
      failA1("COMMIT_FAILED", `git could not commit in ${source.checkout}: ${commit.stderr}`);
    }
    committed = true;
  });
  if (!committed) failA1("COMMIT_FAILED", "nothing was committed");

  const bodyFile = path.join(contributionsDir(root), "pull-request.md");
  fs.writeFileSync(bodyFile, body);
  const published = pushAndOpen(source, branch, title, bodyFile);
  const files = selected.flatMap((unit) => unit.files);
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
          branch,
          base: source.branch,
          remote: published.remote,
          pull_request: published.pull_request,
          files: files.map((file) => ({ target: file.target, sha256: file.sha256 })),
        },
      ],
    });
  }
  fs.rmSync(previewDir(root), { recursive: true, force: true });
  return {
    status: published.pushed ? "pushed" : "local-only",
    branch,
    base: source.branch,
    ...published,
    files: files.map((file) => file.target),
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
      if (isRecord(result) && result.status === "local-only") process.exitCode = 1;
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
    .description("List what this project could contribute, with the digest contribute requires")
    .requiredOption("--project <dir>")
    .option("--exclude <names>", "comma-separated loops and roles the owner leaves out")
    .action((options: { project: string; exclude?: string }) =>
      action(
        async () => (await makePlan(path.resolve(options.project), names(options.exclude))).plan,
      )(),
    );
  program
    .command("clone")
    .description("Fetch a checkout of the Contrejour repository, for a project without one")
    .requiredOption("--project <dir>")
    .action((options: { project: string }) =>
      action(() => cloneLibrary(path.resolve(options.project)))(),
    );
  program
    .command("record-check")
    .description("Record the verdict of the project's own check on one plan of its contribution")
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
    .description("Send exactly what the plan with this digest lists, as a pull request")
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
