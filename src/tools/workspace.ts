/**
 * The owner's projects, as the Studio manages them in a workspace folder: list
 * them, start a new one from a reference project, and copy one. A new project
 * is installed by the framework's own installer from the library checkout,
 * then gets the reference's loops and roles the way the installer seeds the
 * library's (a copy kept as the baseline), and the reference's task loop. A
 * copy carries the loops, roles, memory, task and chosen loop, never the keys,
 * tokens, trajectories or anything a run left behind.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { installedLibrary, installedRole } from "./installation.js";
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
}
export interface ProjectInfo {
  name: string;
  root: string;
  package: string | null;
  profile: string | null;
  loop: string | null;
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** The reference projects of a library checkout (or of the framework it carries): `references/<name>/reference.json`. */
export function listReferences(library: string | null): ReferenceInfo[] {
  const dir = library
    ? [
        path.join(library, "references"),
        path.join(library, "agent-loop-studio", "references"),
      ].find((candidate) => fs.existsSync(candidate))
    : undefined;
  if (!dir) return [];
  const out: ReferenceInfo[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    try {
      const info: unknown = JSON.parse(
        fs.readFileSync(path.join(dir, name, "reference.json"), "utf8"),
      );
      if (isRecord(info) && info.name === name && typeof info.task_loop === "string")
        out.push(info as unknown as ReferenceInfo);
    } catch {
      // A folder without a readable reference.json is not a reference.
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
  return {
    name: path.basename(root),
    root,
    package: hasManifest(root) ? readManifest(root).name : null,
    profile,
    loop,
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

/** Give a project the loops and roles of a reference, and make its task loop the project's. */
export function applyReference(
  projectRoot: string,
  name: string,
): { added: string[]; loop: string } {
  const root = path.resolve(projectRoot);
  const reference = listReferences(installedLibrary(root)).find((entry) => entry.name === name);
  if (!reference) failA1("NOT_FOUND", `the library has no reference project ${name}`);
  const library = installedLibrary(root)!;
  const dir = [
    path.join(library, "references", name),
    path.join(library, "agent-loop-studio", "references", name),
  ].find((candidate) => fs.existsSync(candidate))!;
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
      if (fs.existsSync(target)) continue;
      seed(root, target, fs.readFileSync(path.join(source, file)));
      added.push(path.relative(root, target));
    }
  }
  useLoop(root, { name: reference.task_loop, params: {} });
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
