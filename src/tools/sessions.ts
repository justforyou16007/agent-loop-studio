/**
 * Claude Code background sessions, as the framework runs loops in them: start
 * one as a role with its first message, learn whether it is working, has ended
 * its turn or has stopped, continue it with a message, and read what it
 * recorded: what its loop returned, where it stopped for the owner, its last
 * words. No shell is involved: every command is an argv list.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { failA1, isRecord } from "./validate.js";

/** How sessions are started: the command, the permission mode an unattended session needs, the model. */
export interface SessionOptions {
  claude_command: string[];
  permission_mode: string;
  model?: string | null;
}
export interface BackgroundSession {
  /** The short id `claude agents` lists. */
  id: string;
  /** The full id its transcript is named after. */
  session_id: string;
  name: string;
}
/**
 * running is a working session; idle is one whose turn ended while its process
 * lives on; stopped is one whose process ended; gone is one that was removed.
 */
export type SessionState = "running" | "idle" | "stopped" | "gone";

/**
 * Variables that tie a process to the Claude Code or Paseo session it runs in.
 * Inherited, they would attach a new session to that one; it must stand alone.
 */
const SESSION_VARIABLES = new Set([
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
]);
export function standaloneEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => !SESSION_VARIABLES.has(name) && !name.startsWith("PASEO_"),
    ),
  );
}

export function runClaude(
  argv: string[],
  cwd: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const [command, ...args] = argv;
  return new Promise((resolve) => {
    execFile(
      command!,
      args,
      {
        cwd,
        env: standaloneEnvironment(process.env),
        timeout: 120_000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) =>
        resolve({
          ok: !error,
          stdout: String(stdout),
          stderr: String(stderr).trim() || (error ? error.message : ""),
        }),
    );
  });
}

/** `claude --bg` reports the short id of the session it started or continued. */
export function backgroundedId(output: string): string | null {
  return /backgrounded\s*·\s*([0-9a-f]{6,})/i.exec(output)?.[1] ?? null;
}

export interface ListedSession {
  id: string;
  sessionId?: string;
  name?: string;
  status?: string;
  state?: string;
}
export const listArgv = (options: SessionOptions, root: string): string[] => [
  ...options.claude_command,
  "agents",
  "--json",
  "--all",
  "--cwd",
  root,
];
export async function listSessions(
  options: SessionOptions,
  root: string,
): Promise<ListedSession[]> {
  const reply = await runClaude(listArgv(options, root), root);
  if (!reply.ok) throw new Error(`claude agents failed: ${reply.stderr}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.stdout);
  } catch {
    throw new Error(`claude agents printed no JSON: ${reply.stdout.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed)) throw new Error("claude agents did not list sessions");
  return parsed.filter(
    (entry): entry is ListedSession => isRecord(entry) && typeof entry.id === "string",
  );
}

/**
 * busy is a working session; idle is one whose turn ended while its process
 * lives on (`done`, or `blocked` on something nobody will answer); a session
 * without a status has stopped.
 */
export function sessionState(listed: ListedSession | undefined): SessionState {
  if (!listed) return "gone";
  if (listed.status === "busy") return "running";
  if (listed.status === undefined || listed.status === null) return "stopped";
  return "idle";
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function findSession(
  options: SessionOptions,
  root: string,
  id: string | null,
  name: string,
): Promise<BackgroundSession> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const found = (await listSessions(options, root)).find(
      (entry) => (id ? entry.id === id : entry.name === name) && entry.sessionId,
    );
    if (found) return { id: found.id, session_id: found.sessionId!, name };
    await delay(1000);
  }
  failA1("DISPATCH_FAILED", `claude --bg started no session that can be found (${name})`);
}

export interface StartRequest {
  /** What `claude agents` lists it as. */
  name: string;
  /** The role the session runs as. */
  agent: string;
  /** Its first message: the loop to run, with its arguments. */
  prompt: string;
}
export function startArgv(options: SessionOptions, request: StartRequest): string[] {
  return [
    ...options.claude_command,
    "--bg",
    "--name",
    request.name,
    "--agent",
    request.agent,
    "--permission-mode",
    options.permission_mode,
    ...(options.model ? ["--model", options.model] : []),
    // In a git checkout a background session may not edit files until it creates a worktree.
    "--settings",
    JSON.stringify({ worktree: { bgIsolation: "none" } }),
    request.prompt,
  ];
}
export const stopArgv = (options: SessionOptions, session: BackgroundSession): string[] => [
  ...options.claude_command,
  "stop",
  session.id,
];
/**
 * A stopped session continues in place with the options it was started with;
 * any other flag would start a copy instead.
 */
export const resumeArgv = (
  options: SessionOptions,
  session: BackgroundSession,
  message: string,
): string[] => [...options.claude_command, "--bg", "--resume", session.session_id, message];

export async function startSession(
  options: SessionOptions,
  root: string,
  request: StartRequest,
): Promise<BackgroundSession> {
  const reply = await runClaude(startArgv(options, request), root);
  if (!reply.ok) throw new Error(`claude --bg failed: ${reply.stderr || reply.stdout}`);
  return findSession(options, root, backgroundedId(reply.stdout), request.name);
}

export interface SessionControl {
  /** Throws when Claude Code cannot answer. */
  state(session: BackgroundSession): Promise<SessionState>;
  /**
   * Continue a session that is not running with this message. It continues in
   * place; should Claude Code start a copy instead, the copy is returned.
   */
  resume(session: BackgroundSession, message: string): Promise<BackgroundSession>;
}
export function sessionControl(options: SessionOptions, root: string): SessionControl {
  return {
    async state(session) {
      return sessionState(
        (await listSessions(options, root)).find((entry) => entry.id === session.id),
      );
    },
    async resume(session, message) {
      const state = await this.state(session);
      if (state === "running") throw new Error(`session ${session.id} is still running`);
      if (state === "gone") throw new Error(`session ${session.id} no longer exists`);
      // A session whose process lives on would be copied rather than continued.
      if (state === "idle") {
        const stopped = await runClaude(stopArgv(options, session), root);
        if (!stopped.ok) throw new Error(`claude stop failed: ${stopped.stderr}`);
      }
      const reply = await runClaude(resumeArgv(options, session, message), root);
      if (!reply.ok) throw new Error(`claude --resume failed: ${reply.stderr || reply.stdout}`);
      const id = backgroundedId(reply.stdout);
      return id && id !== session.id ? await findSession(options, root, id, session.name) : session;
    },
  };
}

/** Where Claude Code keeps a session's transcript: under the user's home, by project, by session id. */
export function transcriptPath(root: string, sessionId: string): string | null {
  const projects = path.join(os.homedir(), ".claude", "projects");
  const named = path.join(
    projects,
    path.resolve(root).replace(/[^A-Za-z0-9]/g, "-"),
    `${sessionId}.jsonl`,
  );
  if (fs.existsSync(named)) return named;
  // Session ids are unique, so the file is the one of that name in any project folder.
  if (!fs.existsSync(projects)) return null;
  for (const folder of fs.readdirSync(projects)) {
    const candidate = path.join(projects, folder, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export type TranscriptEntry = Record<string, unknown>;
export function readTranscript(file: string | null): TranscriptEntry[] {
  if (!file || !fs.existsSync(file)) return [];
  const entries: TranscriptEntry[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (isRecord(entry)) entries.push(entry);
    } catch {
      // A line being written while it is read is skipped; the next read has it.
    }
  }
  return entries;
}

const textOf = (entry: TranscriptEntry): string => {
  const message = isRecord(entry.message) ? entry.message : {};
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: string; text: string } =>
        isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
};

/** A JSON value inside a notification's result: the whole text, or the object it contains. */
function jsonIn(text: string): unknown {
  const trimmed = text.trim();
  for (const candidate of [
    trimmed,
    trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1),
  ]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next reading.
    }
  }
  return null;
}

export interface LoopResult {
  value: unknown;
  /** When Claude Code recorded it, ISO 8601; empty when the entry has no time. */
  at: string;
}
/** What the session's loops returned, oldest first: the result of each task notification that carried JSON. */
export function loopResults(entries: TranscriptEntry[]): LoopResult[] {
  const results: LoopResult[] = [];
  for (const entry of entries) {
    const origin = isRecord(entry.origin) ? entry.origin : {};
    if (entry.type !== "user" || origin.kind !== "task-notification") continue;
    const result = /<result>([\s\S]*?)<\/result>/.exec(textOf(entry))?.[1];
    if (result === undefined) continue;
    const value = jsonIn(result);
    if (value !== null)
      results.push({ value, at: typeof entry.timestamp === "string" ? entry.timestamp : "" });
  }
  return results;
}

export interface OwnerWait {
  review_id: string;
  question: string;
  document: string;
}
export function ownerWait(result: unknown): OwnerWait | null {
  if (!isRecord(result) || result.waiting !== "owner" || typeof result.review_id !== "string")
    return null;
  return {
    review_id: result.review_id,
    question: typeof result.question === "string" ? result.question : "",
    document: typeof result.document === "string" ? result.document : "",
  };
}

/** The session's last words to the owner: the text of its last assistant message. */
export function lastAssistantText(entries: TranscriptEntry[]): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type !== "assistant") continue;
    const text = textOf(entry).trim();
    if (text) return text;
  }
  return "";
}

export interface StepProgress {
  /** The loop's phase the role ran in, such as `Draft`. */
  phase: string;
  role: string;
  done: boolean;
}
/**
 * Where the session's latest loop run is: each role it started, in order, with
 * its phase and whether it has finished. Read from the journal Claude Code keeps
 * next to the transcript, so it reflects the run as it goes.
 */
export function runProgress(transcript: string | null): StepProgress[] {
  if (!transcript) return [];
  const runs = path.join(transcript.replace(/\.jsonl$/, ""), "subagents", "workflows");
  if (!fs.existsSync(runs)) return [];
  const latest = fs
    .readdirSync(runs)
    .map((name) => path.join(runs, name))
    .filter((dir) => fs.existsSync(path.join(dir, "journal.jsonl")))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (!latest) return [];
  const steps: (StepProgress & { key: string })[] = [];
  for (const line of fs.readFileSync(path.join(latest, "journal.jsonl"), "utf8").split("\n")) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry) || typeof entry.key !== "string") continue;
    if (entry.type === "started") {
      let role = "";
      try {
        const meta: unknown = JSON.parse(
          fs.readFileSync(path.join(latest, `agent-${String(entry.agentId)}.meta.json`), "utf8"),
        );
        if (isRecord(meta) && typeof meta.agentType === "string") role = meta.agentType;
      } catch {
        // The role's record is written a moment after it starts.
      }
      steps.push({
        key: entry.key,
        phase: typeof entry.phase === "string" ? entry.phase : "",
        role,
        done: false,
      });
    } else if (entry.type === "result") {
      const step = steps.find((known) => known.key === entry.key);
      if (step) step.done = true;
    }
  }
  return steps.map(({ phase, role, done }) => ({ phase, role, done }));
}
