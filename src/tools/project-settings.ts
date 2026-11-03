/**
 * The project settings the framework owns, in `.claude/settings.json`: its hook
 * registrations (argv form, no shell), the role a session enters as, and
 * background sessions that may edit a git checkout without a worktree. Every
 * other setting and hook stays as it is.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeStateJsonAtomic } from "./state-file.js";
import { isRecord } from "./validate.js";

type JsonObject = Record<string, unknown>;
const readJson = (file: string): JsonObject => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

/**
 * Events the hook helper listens to. Which actions run on them is declared by
 * the loop definitions; the helper itself decides.
 */
export const HOOK_EVENTS: readonly { event: string; matcher?: string }[] = [
  { event: "SubagentStop" },
  { event: "Stop" },
  { event: "PreToolUse", matcher: "Write|Edit|NotebookEdit|Workflow" },
];
export const hookHelperPath = (root: string): string =>
  path.join(root, ".contrejour", "dist", "tools", "hook.js");
export const settingsPath = (root: string): string =>
  path.join(path.resolve(root), ".claude", "settings.json");
const isFrameworkHook = (hook: unknown): boolean =>
  isRecord(hook) &&
  Array.isArray(hook.args) &&
  typeof hook.args[0] === "string" &&
  /[\\/]\.contrejour[\\/]dist[\\/]tools[\\/]hook\.js$/.test(hook.args[0]);

/**
 * Register the hooks in the project settings, replacing the framework's earlier
 * registrations and keeping every other setting and hook. The installer does it,
 * so the hooks guard every loop from the start.
 */
export function registerHooks(projectRoot: string): string {
  const root = path.resolve(projectRoot);
  const file = settingsPath(root);
  const settings = readJson(file);
  const hooks: JsonObject = isRecord(settings.hooks) ? { ...settings.hooks } : {};
  for (const { event, matcher } of HOOK_EVENTS) {
    const groups = (Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []).filter(
      (group) =>
        !(isRecord(group) && Array.isArray(group.hooks) && group.hooks.some(isFrameworkHook)),
    );
    hooks[event] = [
      ...groups,
      {
        ...(matcher ? { matcher } : {}),
        hooks: [
          { type: "command", command: process.execPath, args: [hookHelperPath(root), event] },
        ],
      },
    ] as JsonObject[];
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeStateJsonAtomic(file, { ...settings, hooks });
  return file;
}

/**
 * The role a Claude Code session in this project runs as, the one that runs the
 * project's loops and relays the owner's answers; with the hooks registered and
 * background sessions allowed to edit a git checkout.
 */
export function writeEntryRole(projectRoot: string, role: string): string {
  const file = registerHooks(projectRoot);
  const settings = readJson(file);
  const worktree = isRecord(settings.worktree) ? settings.worktree : {};
  writeStateJsonAtomic(file, {
    ...settings,
    agent: role,
    worktree: { ...worktree, bgIsolation: "none" },
  });
  return file;
}

/** The role sessions enter as, when the settings name one. */
export function entryRole(projectRoot: string): string | null {
  const agent = readJson(settingsPath(projectRoot)).agent;
  return typeof agent === "string" && agent ? agent : null;
}

/** The project's name as a slug: its folder's name in lowercase words joined by hyphens. */
export function projectSlug(projectRoot: string): string {
  const name = path.basename(path.resolve(projectRoot));
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-/, "")
    .replace(/-$/, "");
  return slug || `project-${crypto.createHash("sha256").update(name).digest("hex").slice(0, 8)}`;
}
