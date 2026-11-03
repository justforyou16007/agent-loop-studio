/**
 * What the installer fixed for this project: the profile of its package it was
 * installed as (`project.json` names them), and the library it came from. Every
 * project runs on Claude Code, so skills, roles, loop definitions and loop
 * scripts live in the project's `.claude/` directory.
 */
import fs from "node:fs";
import path from "node:path";
import { hasManifest, profileNamed } from "./project-manifest.js";
import { failA1, isRecord } from "./validate.js";

/** A profile of the project's package, as its project.json names them (`default` for a project built in the Studio). */
export type Role = string;

/** Where Claude Code reads project skills and roles, and where loops live, relative to the project root. */
export const SKILLS_DIR = ".claude/skills";
export const ROLES_DIR = ".claude/agents";
export const LOOPS_DIR = ".claude/loops";
export const WORKFLOWS_DIR = ".claude/workflows";

export const installationFile = (root: string): string =>
  path.join(path.resolve(root), ".contrejour", "install.json");
/** What library-cli.js keeps about this project's contributions to the shared library. */
export const contributionsDir = (root: string): string =>
  path.join(path.resolve(root), ".contrejour", "contributions");

function installation(root: string): Record<string, unknown> {
  const file = installationFile(root);
  if (!fs.existsSync(file))
    failA1(
      "INVALID_VALUE",
      "install the project first (install-contrejour.sh --role <profile>)",
      file,
    );
  const installed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!isRecord(installed)) failA1("INVALID_VALUE", "reinstall Contrejour", file);
  // Earlier releases could run on Codex; Contrejour no longer does and does not migrate.
  if (installed.provider !== undefined && installed.provider !== "claude")
    failA1(
      "INVALID_VALUE",
      "this project was installed for Codex, which Contrejour no longer supports; install into a fresh project",
      file,
    );
  return installed;
}

/** The profile chosen at installation (`install-contrejour.sh --role`); it never changes. */
export function installedRole(root: string): Role {
  const role = installation(root).role;
  if (typeof role !== "string" || !role || (hasManifest(root) && !profileNamed(root, role)))
    failA1(
      "INVALID_VALUE",
      "reinstall the project with --role <one of its package's profiles>",
      installationFile(root),
    );
  return role;
}

/** The role this project's sessions enter as: its profile's, from the package's manifest. */
export function entryRoleOf(root: string): string {
  return profileNamed(root, installedRole(root)).entry_role;
}
/** The library sides this project's loops and roles come from, the framework's first. */
export function sidesOf(root: string): string[] {
  return ["framework", ...profileNamed(root, installedRole(root)).sides];
}

/** The local Contrejour checkout the project was installed from: the shared library of loops and roles. */
export function installedLibrary(root: string): string | null {
  const library = installation(root).library;
  return typeof library === "string" && library ? library : null;
}

/**
 * Where the project's library lives: the checkout it was installed from and, in a
 * project package's checkout, the framework's and the community's libraries it
 * carries as submodules (`agent-loop-studio/`, `agent-loop-community/`). Each
 * holds `library/loops/<side>/` and `library/roles/<side>/`; the first holding a
 * file wins.
 */
export function libraryRoots(root: string): string[] {
  const library = installedLibrary(root);
  if (!library) return [];
  return [
    library,
    path.join(library, "agent-loop-studio"),
    path.join(library, "agent-loop-community"),
  ].filter((candidate) => fs.existsSync(path.join(candidate, "library")));
}

export function skillsDir(root: string): string {
  return path.join(path.resolve(root), ...SKILLS_DIR.split("/"));
}
