/**
 * What a project package tells the framework about itself, in `project.json`
 * at the package's root (installed as `.contrejour/project.json`): the profiles
 * a project can be installed as, each with the role its sessions enter as and
 * the library sides its loops and roles come from; the hook actions it adds;
 * and the module of its own helpers the framework calls where the project
 * decides (`ProjectExtension`). The framework knows nothing else about a
 * project: everything specific to one comes through here.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { failA1, isRecord } from "./validate.js";

export interface Profile {
  description?: string;
  /** The role a session in such a project runs as: it runs loops and relays the owner's answers. */
  entry_role: string;
  /** The library sides (`library/loops/<side>`, `library/roles/<side>`) besides `framework` this profile uses. */
  sides: string[];
  /** What the installer tells the owner to do next, after opening the Studio. */
  next?: string[];
}
export interface ProjectManifest {
  format: 1;
  name: string;
  description?: string;
  profiles: Record<string, Profile>;
  /** A module in the installed helpers (`.contrejour/dist/tools/`) exporting `extension`. */
  extension?: string | null;
  /** Hook actions the extension adds, with the events each runs on. */
  hook_actions?: Record<string, string[]>;
}

/** The framework's own hook actions and the events they run on. */
export const FRAMEWORK_TRIGGERS: Readonly<Record<string, readonly string[]>> = {
  "record-trajectory": ["SubagentStop", "Stop"],
  "guard-owner-answers": ["PreToolUse"],
};

export const manifestFile = (root: string): string =>
  path.join(path.resolve(root), ".contrejour", "project.json");

function checked(value: unknown, where: string): ProjectManifest {
  if (
    !isRecord(value) ||
    value.format !== 1 ||
    typeof value.name !== "string" ||
    !isRecord(value.profiles)
  )
    failA1("INVALID_VALUE", "project.json needs format 1, a name and its profiles", where);
  for (const [name, profile] of Object.entries(value.profiles)) {
    if (
      !/^[a-z0-9][a-z0-9-]*$/.test(name) ||
      !isRecord(profile) ||
      typeof profile.entry_role !== "string" ||
      !Array.isArray(profile.sides) ||
      !profile.sides.every((side) => typeof side === "string" && /^[a-z0-9][a-z0-9-]*$/.test(side))
    )
      failA1("INVALID_VALUE", `profile ${name} needs an entry_role and its library sides`, where);
  }
  if (
    value.extension !== undefined &&
    value.extension !== null &&
    !/^[a-z0-9][a-z0-9-]*\.js$/.test(String(value.extension))
  )
    failA1(
      "INVALID_VALUE",
      "extension names a module of the installed helpers, such as project-extension.js",
      where,
    );
  if (value.hook_actions !== undefined && !isRecord(value.hook_actions))
    failA1("INVALID_VALUE", "hook_actions maps each action to the events it runs on", where);
  return value as unknown as ProjectManifest;
}

/** The manifest a package or project carries. */
export function readManifestFile(file: string): ProjectManifest {
  if (!fs.existsSync(file))
    failA1("INVALID_VALUE", "this project has no project.json: reinstall it", file);
  return checked(JSON.parse(fs.readFileSync(file, "utf8")), file);
}
export const readManifest = (root: string): ProjectManifest => readManifestFile(manifestFile(root));
export const hasManifest = (root: string): boolean => fs.existsSync(manifestFile(root));

/** The profile a project was installed as. */
export function profileNamed(root: string, name: string): Profile {
  const profile = readManifest(root).profiles[name];
  if (!profile)
    failA1("INVALID_VALUE", `this project's package has no profile ${name}`, manifestFile(root));
  return profile;
}
/** Every library side the package's profiles use, the framework's first. */
export function knownSides(root: string): string[] {
  if (!hasManifest(root)) return ["framework"];
  return [
    "framework",
    ...new Set(Object.values(readManifest(root).profiles).flatMap((profile) => profile.sides)),
  ];
}
/** The hook actions a loop may declare in this project, with their events. */
export function triggersOf(root: string): Record<string, readonly string[]> {
  const added = hasManifest(root) ? (readManifest(root).hook_actions ?? {}) : {};
  return { ...added, ...FRAMEWORK_TRIGGERS };
}

/** A hook action of the project's: the reason to block the tool use, or nothing. */
export type HookAction = (
  root: string,
  event: string,
  input: Record<string, unknown>,
) => string | null | void;

/** Where the project decides what the framework cannot know. Every part is optional. */
export interface ProjectExtension {
  hookActions?: Record<string, HookAction>;
  /** What a session works on (such as a submission), recorded with each trajectory. */
  taskOf?(root: string, sessionId: string): string | null;
  /** The tasks of the project that finished: one is needed before the project contributes. */
  finishedTasks?(root: string, profile: string): string[];
  /** Values that must never leave the machine, with what each is. */
  secrets?(root: string, profile: string): { label: string; value: string }[];
  /** Files whose content no contribution may contain. */
  hiddenPaths?(root: string, profile: string): string[];
  /**
   * Whether a contribution must pass a check of the project's (such as a review
   * against hidden data) before it leaves. The check's role records its verdict on
   * the plan's digest with `library-cli.js record-check`.
   */
  needsContributionCheck?(root: string, profile: string): boolean;
}

/** The project's extension, from its installed helpers; empty when it has none. */
export async function loadExtension(root: string): Promise<ProjectExtension> {
  if (!hasManifest(root)) return {};
  const name = readManifest(root).extension;
  if (!name) return {};
  const file = path.join(path.resolve(root), ".contrejour", "dist", "tools", name);
  if (!fs.existsSync(file))
    failA1("INVALID_VALUE", `the project's extension ${name} is not installed`, file);
  const loaded = (await import(pathToFileURL(file).href)) as { extension?: ProjectExtension };
  return loaded.extension ?? {};
}
