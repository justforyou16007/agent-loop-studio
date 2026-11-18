/**
 * What Claude Code records of a session, as the framework reads it: where its
 * transcript is, what its loops returned, where one stopped for the owner, what
 * it last said, and how far its latest loop's run has come.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRecord } from "./validate.js";

/** Claude Code's own folder: `CLAUDE_CONFIG_DIR`, or `.claude` in the home folder. */
export const claudeHome = (env: NodeJS.ProcessEnv = process.env): string =>
  env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
/** Where Claude Code keeps its sessions' transcripts, by project. */
export const transcriptsDir = (env: NodeJS.ProcessEnv = process.env): string =>
  path.join(claudeHome(env), "projects");

/** Where Claude Code keeps a session's transcript: in its own folder, by project, by session id. */
export function transcriptPath(root: string, sessionId: string): string | null {
  const projects = transcriptsDir();
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

/** A text of a message's content: a string, or its text parts. */
const contentText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
          .join("")
      : "";

/** A loop a session ran: the Workflow call, the run it started, and how that run ended. */
export interface LoopCall {
  /** The Workflow tool call's id, which its notification names. */
  call: string;
  loop: string;
  /** The run it started (`wf_…`), once Claude Code said which. */
  run: string | null;
  /** When the session called it. */
  at: string;
  /** Its notification: how it ended and what it returned; null while it runs, or when nothing said it ended. */
  ended: { at: string; status: string; result: unknown } | null;
}
/** Every loop a session ran, oldest first, each with the run it started and how that ended. */
export function loopCalls(entries: TranscriptEntry[]): LoopCall[] {
  const calls = new Map<string, LoopCall>();
  for (const entry of entries) {
    const message = isRecord(entry.message) ? entry.message : {};
    const content = Array.isArray(message.content) ? message.content : [];
    const at = typeof entry.timestamp === "string" ? entry.timestamp : "";
    if (entry.type === "assistant")
      for (const part of content)
        if (isRecord(part) && part.type === "tool_use" && part.name === "Workflow") {
          const input = isRecord(part.input) ? part.input : {};
          calls.set(String(part.id), {
            call: String(part.id),
            loop: typeof input.name === "string" ? input.name : "",
            run: null,
            at,
            ended: null,
          });
        }
    if (entry.type !== "user") continue;
    for (const part of content)
      if (isRecord(part) && part.type === "tool_result" && calls.has(String(part.tool_use_id))) {
        const result = isRecord(entry.toolUseResult) ? entry.toolUseResult : {};
        calls.get(String(part.tool_use_id))!.run =
          typeof result.runId === "string"
            ? result.runId
            : (/\bwf_[A-Za-z0-9_-]+/.exec(contentText(part.content))?.[0] ?? null);
      }
    const origin = isRecord(entry.origin) ? entry.origin : {};
    if (origin.kind !== "task-notification") continue;
    const said = textOf(entry);
    const call = calls.get(/<tool-use-id>([^<]+)<\/tool-use-id>/.exec(said)?.[1] ?? "");
    if (!call) continue;
    const result = /<result>([\s\S]*?)<\/result>/.exec(said)?.[1];
    call.ended = {
      at,
      status: /<status>([^<]+)<\/status>/.exec(said)?.[1]?.trim() ?? "",
      result: result === undefined ? null : (jsonIn(result) ?? result.trim()),
    };
  }
  return [...calls.values()];
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
 * Where the session's latest loop run (or the run named) is: each role it started, in order, with
 * its phase and whether it has finished. Read from the journal Claude Code keeps
 * next to the transcript, so it reflects the run as it goes.
 */
export function runProgress(transcript: string | null, run?: string): StepProgress[] {
  if (!transcript) return [];
  const runs = path.join(transcript.replace(/\.jsonl$/, ""), "subagents", "workflows");
  if (!fs.existsSync(runs)) return [];
  const latest = run
    ? path.join(runs, run)
    : fs
        .readdirSync(runs)
        .map((name) => path.join(runs, name))
        .filter((dir) => fs.existsSync(path.join(dir, "journal.jsonl")))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (latest && !fs.existsSync(path.join(latest, "journal.jsonl"))) return [];
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

export interface LatestRun {
  /** The run's id, which a session resumes it by (`resumeFromRunId`). */
  id: string;
  /** When it started, ISO 8601. */
  started_at: string;
  steps: StepProgress[];
}
/** The session's latest loop run: its id, when it started, and each role it started. */
export function latestRun(transcript: string | null): LatestRun | null {
  if (!transcript) return null;
  const runs = path.join(transcript.replace(/\.jsonl$/, ""), "subagents", "workflows");
  if (!fs.existsSync(runs)) return null;
  const latest = fs
    .readdirSync(runs)
    .map((name) => ({ name, dir: path.join(runs, name) }))
    .filter((run) => fs.existsSync(path.join(run.dir, "journal.jsonl")))
    .map((run) => ({ ...run, stat: fs.statSync(run.dir) }))
    .sort((a, b) => b.stat.birthtimeMs - a.stat.birthtimeMs)[0];
  if (!latest) return null;
  return {
    id: latest.name,
    started_at: new Date(latest.stat.birthtimeMs || latest.stat.mtimeMs).toISOString(),
    steps: runProgress(transcript, latest.name),
  };
}
