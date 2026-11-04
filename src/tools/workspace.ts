/**
 * The owner's projects, as the Studio manages them in a workspace folder: list
 * them, start a new one, from an example or empty, and copy one. Examples are
 * the framework's reference projects and the projects published to the
 * community library (`agent-loop-community/projects/<name>/`). A new project is
 * installed by the framework's own installer from the Studio's checkout, then
 * gets the example's loops and roles the way the installer seeds the library's
 * (a copy kept as the baseline, the example's taking the place of a framework
 * one of the same name), and the example's task loop with its values. A copy
 * carries the loops, roles, memory, task and chosen loop, never the keys,
 * tokens, trajectories or anything a run left behind.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { COMMUNITY_LIBRARY, installedLibrary, installedRole } from "./installation.js";
import { readSelectedLoop } from "./loops.js";
import { useLoop } from "./project-loop.js";
import { hasManifest, readManifest } from "./project-manifest.js";
import { registerHooks } from "./project-settings.js";
import { failA1, isRecord } from "./validate.js";

export interface ReferenceInfo {
  name: string;
  title: { zh: string; en: string };
  description: { zh: string; en: string };
  task_loop: string;
  /** The task loop's parameter values, when the example sets them. */
  params?: Record<string, unknown>;
  /** The framework's own reference project, or a project published to the community library. */
  source: "framework" | "community";
}
export interface ProjectInfo {
  name: string;
  root: string;
  package: string | null;
  profile: string | null;
  loop: string | null;
  /** The project's latest publication to the community library, when it has one. */
  published: { name: string; at: string; pull_request: string | null } | null;
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Where a library checkout keeps its examples: the framework's references, and the community's published projects. */
function exampleDirs(library: string | null): { dir: string; source: ReferenceInfo["source"] }[] {
  if (!library) return [];
  return [
    { dir: path.join(library, "references"), source: "framework" as const },
    { dir: path.join(library, "agent-loop-studio", "references"), source: "framework" as const },
    { dir: path.join(library, COMMUNITY_LIBRARY, "projects"), source: "community" as const },
  ].filter((entry) => fs.existsSync(entry.dir));
}

/** The examples a new project can start from: `<dir>/<name>/reference.json`, the framework's first. */
export function listReferences(library: string | null): ReferenceInfo[] {
  const out: ReferenceInfo[] = [];
  for (const { dir, source } of exampleDirs(library))
    for (const name of fs.readdirSync(dir).sort()) {
      if (out.some((known) => known.name === name)) continue;
      try {
        const info: unknown = JSON.parse(
          fs.readFileSync(path.join(dir, name, "reference.json"), "utf8"),
        );
        if (isRecord(info) && info.name === name && typeof info.task_loop === "string")
          out.push({ ...(info as unknown as ReferenceInfo), source });
      } catch {
        // A folder without a readable reference.json is not an example.
      }
    }
  return out;
}

function describe(root: string): ProjectInfo {
  let profile: string | null = null;
  let loop: string | null = null;
  try {
    profile = installedRole(root);
  } catch {
    profile = null;
  }
  try {
    loop = readSelectedLoop(root).loop;
  } catch {
    loop = null;
  }
  let published: ProjectInfo["published"] = null;
  try {
    const record: unknown = JSON.parse(
      fs.readFileSync(path.join(root, ".contrejour", "published.json"), "utf8"),
    );
    if (isRecord(record) && typeof record.name === "string" && typeof record.at === "string")
      published = {
        name: record.name,
        at: record.at,
        pull_request: typeof record.pull_request === "string" ? record.pull_request : null,
      };
  } catch {
    published = null;
  }
  return {
    name: path.basename(root),
    root,
    package: hasManifest(root) ? readManifest(root).name : null,
    profile,
    loop,
    published,
  };
}

/** The projects in the workspace: its folders with an installation record. */
export function listProjects(workspace: string): ProjectInfo[] {
  const dir = path.resolve(workspace);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .sort()
    .map((name) => path.join(dir, name))
    .filter((root) => fs.existsSync(path.join(root, ".contrejour", "install.json")))
    .map(describe);
}

function seed(root: string, target: string, contents: Buffer): void {
  const relative = path.relative(path.join(root, ".claude"), target);
  for (const file of [target, path.join(root, ".contrejour", "seeded", relative)]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
}

/**
 * Give a project the loops and roles of an example, and make its task loop, with
 * its values, the project's. The example's take the place of a framework loop or
 * role of the same name the project still has as installed; what the project
 * got from it is recorded, since it is the project's own to publish.
 */
export function applyReference(
  projectRoot: string,
  name: string,
): { added: string[]; loop: string } {
  const root = path.resolve(projectRoot);
  const library = installedLibrary(root);
  const reference = listReferences(library).find((entry) => entry.name === name);
  if (!reference) failA1("NOT_FOUND", `there is no example project ${name}`);
  const dir = exampleDirs(library)
    .map((entry) => path.join(entry.dir, name))
    .find((candidate) => fs.existsSync(path.join(candidate, "reference.json")))!;
  const added: string[] = [];
  for (const [from, to, extension] of [
    ["loops", "loops", ".md"],
    ["loops", "workflows", ".js"],
    ["roles", "agents", ".md"],
  ] as const) {
    const source = path.join(dir, from);
    if (!fs.existsSync(source)) continue;
    for (const file of fs.readdirSync(source).filter((entry) => entry.endsWith(extension))) {
      const target = path.join(root, ".claude", to, file);
      const relative = path.relative(path.join(root, ".claude"), target);
      const baseline = path.join(root, ".contrejour", "seeded", relative);
      // One the project changed is its own; one as installed gives way to the example's.
      if (
        fs.existsSync(target) &&
        !(fs.existsSync(baseline) && fs.readFileSync(baseline).equals(fs.readFileSync(target)))
      )
        continue;
      seed(root, target, fs.readFileSync(path.join(source, file)));
      added.push(path.relative(root, target).split(path.sep).join("/"));
    }
  }
  useLoop(root, { name: reference.task_loop, params: reference.params ?? {} });
  fs.writeFileSync(
    path.join(root, ".contrejour", "reference.json"),
    `${JSON.stringify({ schema_version: 1, name, source: reference.source, files: added }, null, 2)}\n`,
  );
  return { added, loop: reference.task_loop };
}

const STARTER_TASK = `# Task

Say here what this project should do: what it makes, what it must do well,
how to tell it is done. Every role reads this file.
`;

/** Install a new project in the workspace from the library checkout, and start it from a reference. */
export function createProject(
  workspace: string,
  name: string,
  options: { library: string; reference: string | null; profile?: string },
): ProjectInfo {
  if (!NAME.test(name))
    failA1(
      "INVALID_VALUE",
      "a project name is lowercase letters, digits, dots, dashes or underscores",
    );
  const root = path.join(path.resolve(workspace), name);
  if (fs.existsSync(root)) failA1("INVALID_VALUE", `${root} already exists`);
  const installer = path.join(options.library, "distribution", "install-from-repo.mjs");
  if (!fs.existsSync(installer)) failA1("NOT_FOUND", `${options.library} has no installer`);
  const installed = spawnSync(
    process.execPath,
    [installer, "--role", options.profile ?? "default", "--project", root],
    { encoding: "utf8", windowsHide: true },
  );
  if (installed.status !== 0) {
    fs.rmSync(root, { recursive: true, force: true });
    failA1(
      "INSTALL_FAILED",
      (installed.stderr || installed.stdout).trim().split("\n").slice(-3).join(" "),
    );
  }
  // A project is a git repository: the optimizer commits each role fix on its own.
  spawnSync("git", ["init", "--quiet", root], { windowsHide: true });
  if (!fs.existsSync(path.join(root, "task.md")))
    fs.writeFileSync(path.join(root, "task.md"), STARTER_TASK);
  if (options.reference) applyReference(root, options.reference);
  return describe(root);
}

/** What a copy leaves behind: keys and tokens, and what runs and reviews wrote. */
const NOT_COPIED = new Set([
  ".git",
  "node_modules",
  ".mcp.json",
  ".contrejour/environment.json",
  ".contrejour/trajectories",
  ".contrejour/studio",
  ".contrejour/drafts",
  ".contrejour/reviews",
  ".contrejour/contributions",
  ".contrejour/published.json",
  ".contrejour/proposals",
  ".contrejour/results",
  ".contrejour/scratch",
  ".contrejour/hook-errors.log",
]);

/** Copy a project: its loops, roles, memory, task and chosen loop, installed afresh from the same library. */
export function copyProject(workspace: string, from: string, name: string): ProjectInfo {
  const source = path.join(path.resolve(workspace), from);
  if (!fs.existsSync(path.join(source, ".contrejour", "install.json")))
    failA1("NOT_FOUND", `${from} is not a project of this workspace`);
  const library = installedLibrary(source);
  if (!library)
    failA1("INVALID_VALUE", `${from} records no library checkout to install the copy from`);
  const copy = createProject(workspace, name, {
    library,
    reference: null,
    profile: installedRole(source),
  });
  const walk = (relative: string) => {
    const here = path.join(source, relative);
    for (const entry of fs.readdirSync(here, { withFileTypes: true })) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (NOT_COPIED.has(next)) continue;
      // The installer's own files are the copy's, freshly installed.
      if (
        /^\.contrejour\/(dist|node_modules|templates|install\.json|package\.json|project\.json)/.test(
          next,
        )
      )
        continue;
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) {
        const target = path.join(copy.root, next);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(here, entry.name), target);
      }
    }
  };
  walk("");
  // The copied settings point the hooks at the original project's helper: point them at the copy's.
  registerHooks(copy.root);
  return describe(copy.root);
}
