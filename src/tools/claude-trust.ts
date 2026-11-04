/**
 * Claude Code's trust in a folder, recorded by the Studio for its workspace and
 * the projects in it. Claude Code starts background sessions only in a folder it
 * trusts, and the owner decided (2026-11-04) that the workspace they choose for
 * their projects, and every project in it, is trusted without a prompt for each.
 *
 * Claude Code keeps trust in its global config (`~/.claude.json`, or the one in
 * `CLAUDE_CONFIG_DIR`) as `projects[<folder>].hasTrustDialogAccepted`, looked up
 * from a folder upward to the root of its git repository and no further. Every
 * project is its own repository, so the workspace's entry does not reach its
 * projects: each project gets its own entry. The file is shared with every
 * running Claude Code, so it is changed the way Claude Code changes it: under its
 * lock (the directory `<file>.lock`), read again, the entries added in Claude
 * Code's own shape, written whole through a temporary file. Nothing is created
 * (without a config file Claude Code has not run on this machine), and a folder
 * inside another repository is left out, since trusting it would trust all of
 * that repository: Claude Code's own prompt then asks the owner.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A project entry as Claude Code writes a new one when the owner trusts a folder. */
const NEW_PROJECT = {
  allowedTools: [],
  mcpContextUris: [],
  mcpServers: {},
  enabledMcpjsonServers: [],
  disabledMcpjsonServers: [],
  hasTrustDialogAccepted: false,
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false,
};
/** Claude Code refreshes a lock it holds every few seconds: one this old belongs to a process that is gone. */
const STALE_LOCK_MS = 30_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Claude Code's global config file, chosen as Claude Code chooses it. */
export function claudeConfigFile(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  // An old installation keeps it in Claude Code's folder, as .config.json.
  const legacy = path.join(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), ".config.json");
  try {
    const stat = fs.statSync(legacy);
    if (stat.isFile() && stat.size > 0) return legacy;
  } catch {
    // None: the usual file.
  }
  const suffix = env.CLAUDE_CODE_CUSTOM_OAUTH_URL ? "-custom-oauth" : "";
  return path.join(env.CLAUDE_CONFIG_DIR || home, `.claude${suffix}.json`);
}

/** Claude Code's name for a folder in its config, written as it writes paths (forward slashes on Windows). */
const keyOf = (folder: string, platform: NodeJS.Platform): string => {
  const normal = path.normalize(folder);
  return platform === "win32" ? normal.replaceAll("\\", "/") : normal;
};
/** A real path without Windows' long-path prefix, as Claude Code reads one. */
const withoutPrefix = (real: string): string =>
  real.startsWith("\\\\?\\UNC\\")
    ? `\\\\${real.slice(8)}`
    : real.startsWith("\\\\?\\") && real.length >= 7 && real[5] === ":"
      ? real.slice(4)
      : real;
/** The folder at or above `folder` that holds `.git`, as Claude Code finds a repository. */
function repositoryRoot(folder: string): string | null {
  for (let dir = path.resolve(folder); ; ) {
    try {
      const stat = fs.statSync(path.join(dir, ".git"));
      if (stat.isDirectory() || stat.isFile()) return dir;
    } catch {
      // Not here: one folder up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The names under which Claude Code looks a folder's trust up: its real path (how
 * a background session checks it), and the path as given when that differs. Or
 * why the folder cannot be trusted on its own.
 */
export function trustKeys(
  folder: string,
  platform: NodeJS.Platform = process.platform,
): { keys: string[] } | { problem: string } {
  const given = path.resolve(folder);
  let real: string;
  try {
    real = withoutPrefix(fs.realpathSync.native(given));
  } catch {
    return { problem: `${given} does not exist` };
  }
  const root = repositoryRoot(real);
  if (root !== null && path.resolve(root) !== path.resolve(real))
    return {
      problem: `${given} is inside the git repository ${root}: trusting it would trust all of that repository`,
    };
  if (root !== null && !fs.statSync(path.join(root, ".git")).isDirectory())
    return {
      problem: `${given} is a worktree or a submodule, which Claude Code names by another repository`,
    };
  return { keys: [...new Set([keyOf(real, platform), keyOf(given, platform)])] };
}

export interface TrustOutcome {
  /** Recorded now. */
  trusted: string[];
  /** Trusted already. */
  already: string[];
  /** Not recorded, and why. */
  skipped: { folder: string; reason: string }[];
}

/** Hold Claude Code's lock on its config while `work` runs; `held` false when another process kept it all along. */
async function underLock<T>(
  file: string,
  waitMs: number,
  work: () => Promise<T>,
): Promise<{ held: false } | { held: true; value: T }> {
  const lock = `${file}.lock`;
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > STALE_LOCK_MS) {
          fs.rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Gone already: take it.
        continue;
      }
      if (Date.now() > until) return { held: false };
      await delay(40 + Math.random() * 80);
    }
  }
  try {
    return { held: true, value: await work() };
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/** Write the config whole through a file beside it, renamed over it; through a symbolic link, onto its target. */
async function replaceFile(file: string, text: string): Promise<void> {
  const target = fs.realpathSync(file);
  const temporary = `${target}.studio-${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
  try {
    for (let attempt = 0; ; attempt += 1)
      try {
        fs.renameSync(temporary, target);
        return;
      } catch (error) {
        // On Windows a file another process has open cannot be replaced for that moment.
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 20 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw error;
        await delay(50);
      }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** What a change under the lock came to: the folders recorded and those trusted already, or why nothing was. */
type Changed = { problem: string } | { recorded: string[]; already: string[] };

const trustedIn = (config: unknown, keys: string[]): boolean =>
  isRecord(config) &&
  isRecord(config.projects) &&
  keys.every((key) => {
    const entry = (config.projects as Record<string, unknown>)[key];
    return isRecord(entry) && entry.hasTrustDialogAccepted === true;
  });
const parsed = (text: string): unknown => JSON.parse(text.replace(/^\uFEFF/, ""));

/**
 * Record Claude Code's trust in these folders. It never throws for a folder that
 * cannot be trusted: that one is skipped with the reason, and Claude Code's own
 * prompt is left to ask the owner.
 */
export async function trustFolders(
  folders: string[],
  options: {
    file?: string;
    platform?: NodeJS.Platform;
    /** How long to wait for a Claude Code that is changing its config. */
    waitMs?: number;
  } = {},
): Promise<TrustOutcome> {
  const outcome: TrustOutcome = { trusted: [], already: [], skipped: [] };
  const wanted: { folder: string; keys: string[] }[] = [];
  for (const folder of new Set(folders.map((entry) => path.resolve(entry)))) {
    const found = trustKeys(folder, options.platform);
    if ("problem" in found) outcome.skipped.push({ folder, reason: found.problem });
    else wanted.push({ folder, keys: found.keys });
  }
  if (!wanted.length) return outcome;
  const file = options.file ?? claudeConfigFile();
  const skipAll = (reason: string) => {
    for (const { folder } of wanted) outcome.skipped.push({ folder, reason });
    return outcome;
  };
  if (!fs.existsSync(file))
    return skipAll(
      `Claude Code's config ${file} does not exist yet: run claude once on this machine`,
    );
  // Already trusted, the usual case: nothing to lock or write.
  try {
    const config = parsed(fs.readFileSync(file, "utf8"));
    if (wanted.every((entry) => trustedIn(config, entry.keys))) {
      outcome.already.push(...wanted.map((entry) => entry.folder));
      return outcome;
    }
  } catch {
    // Read again under the lock.
  }
  // Read, changed and written whole while Claude Code's lock is held, so no other save comes between.
  let locked: { held: false } | { held: true; value: Changed };
  try {
    locked = await underLock(file, options.waitMs ?? 5000, async (): Promise<Changed> => {
      let config: unknown;
      try {
        config = parsed(fs.readFileSync(file, "utf8"));
      } catch {
        return {
          problem: `Claude Code's config ${file} is not readable as JSON: it was left as it is`,
        };
      }
      if (!isRecord(config))
        return { problem: `Claude Code's config ${file} is not an object: it was left as it is` };
      const projects: Record<string, unknown> = isRecord(config.projects)
        ? { ...config.projects }
        : {};
      const recorded: string[] = [];
      const already: string[] = [];
      for (const { folder, keys } of wanted) {
        if (trustedIn({ projects }, keys)) {
          already.push(folder);
          continue;
        }
        for (const key of keys) {
          const entry = projects[key];
          if (isRecord(entry) && entry.hasTrustDialogAccepted === true) continue;
          projects[key] = {
            ...(isRecord(entry) ? entry : NEW_PROJECT),
            hasTrustDialogAccepted: true,
          };
        }
        recorded.push(folder);
      }
      // As Claude Code writes it: two spaces, no newline at the end.
      if (recorded.length)
        await replaceFile(file, JSON.stringify({ ...config, projects }, null, 2));
      return { recorded, already };
    });
  } catch (error) {
    return skipAll(
      `Claude Code's config ${file} could not be changed: ${(error as Error).message}`,
    );
  }
  if (!locked.held)
    return skipAll(`another process held Claude Code's config ${file} too long: try again`);
  if ("problem" in locked.value) return skipAll(locked.value.problem);
  outcome.trusted.push(...locked.value.recorded);
  outcome.already.push(...locked.value.already);
  return outcome;
}
