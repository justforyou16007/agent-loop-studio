/**
 * What the project's roles and loops gave, newest first, for the Studio's output
 * viewer. A role's output is its whole return value, from the journal Claude
 * Code keeps beside a session's transcript (one `{"type": "result"}` line per
 * role that finished); a loop's is the result of the notification that ended
 * it. Every session Claude Code ran in the project's folder counts, the Studio's
 * and the owner's own; the newest sessions are read first.
 */
import fs from "node:fs";
import path from "node:path";
import { transcriptsDir } from "./session-record.js";
import type { OutputItem, OutputList } from "./studio-types.js";
import { isRecord } from "./validate.js";

export interface OutputQuery {
  /** Only what was given at or before this time. */
  before?: string;
  kind?: "role" | "loop";
  name?: string;
  limit?: number;
}

/** How many of the project's sessions are read, newest first. */
const SESSIONS_READ = 60;

const lines = (file: string): Record<string, unknown>[] => {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line) => {
        try {
          const parsed: unknown = JSON.parse(line);
          return isRecord(parsed) ? [parsed] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
};
const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
          .join("")
      : "";
/** A JSON value in a notification's result: the whole text, or the object in it; else the text. */
function valueIn(text: string): unknown {
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
  return trimmed;
}

/** The loops a session ran, with what each ended with: its Workflow calls, matched to their notifications. */
function loopOutputs(session: string, transcript: string): OutputItem[] {
  const calls = new Map<string, { name: string; run: string | null }>();
  const items: OutputItem[] = [];
  for (const entry of lines(transcript)) {
    const message = isRecord(entry.message) ? entry.message : {};
    const content = Array.isArray(message.content) ? message.content : [];
    if (entry.type === "assistant")
      for (const part of content)
        if (isRecord(part) && part.type === "tool_use" && part.name === "Workflow") {
          const input = isRecord(part.input) ? part.input : {};
          calls.set(String(part.id), {
            name: typeof input.name === "string" ? input.name : "a loop",
            run: null,
          });
        }
    if (entry.type !== "user") continue;
    for (const part of content)
      if (isRecord(part) && part.type === "tool_result" && calls.has(String(part.tool_use_id))) {
        const result = isRecord(entry.toolUseResult) ? entry.toolUseResult : {};
        const run =
          typeof result.runId === "string"
            ? result.runId
            : (/\bwf_[A-Za-z0-9_-]+/.exec(textOf(part.content))?.[0] ?? null);
        calls.get(String(part.tool_use_id))!.run = run;
      }
    const origin = isRecord(entry.origin) ? entry.origin : {};
    if (origin.kind !== "task-notification") continue;
    const text = textOf(message.content);
    const result = /<result>([\s\S]*?)<\/result>/.exec(text)?.[1];
    const call = calls.get(/<tool-use-id>([^<]+)<\/tool-use-id>/.exec(text)?.[1] ?? "");
    if (result === undefined || !call) continue;
    items.push({
      at: typeof entry.timestamp === "string" ? entry.timestamp : "",
      kind: "loop",
      name: call.name,
      session,
      run: call.run,
      step: "",
      output: valueIn(result),
    });
  }
  return items;
}

/** The roles of a session's loop runs that finished, each with its whole return value. */
function roleOutputs(session: string, transcript: string): OutputItem[] {
  const runs = path.join(transcript.replace(/\.jsonl$/, ""), "subagents", "workflows");
  if (!fs.existsSync(runs)) return [];
  const items: OutputItem[] = [];
  for (const run of fs.readdirSync(runs)) {
    const dir = path.join(runs, run);
    const journal = path.join(dir, "journal.jsonl");
    if (!fs.existsSync(journal)) continue;
    const started = new Map<string, { phase: string; label: string }>();
    for (const entry of lines(journal)) {
      const key = String(entry.key ?? "");
      if (entry.type === "started")
        started.set(key, {
          phase: typeof entry.phase === "string" ? entry.phase : "",
          label: typeof entry.label === "string" ? entry.label : "",
        });
      if (entry.type !== "result" || !("result" in entry)) continue;
      const agent = String(entry.agentId ?? "");
      let role = "";
      try {
        const meta: unknown = JSON.parse(
          fs.readFileSync(path.join(dir, `agent-${agent}.meta.json`), "utf8"),
        );
        if (isRecord(meta) && typeof meta.agentType === "string") role = meta.agentType;
      } catch {
        // A role whose record is missing is named by nothing.
      }
      // When it finished: the last entry of its own transcript, else the journal's last change.
      const own = lines(path.join(dir, `agent-${agent}.jsonl`));
      const last = own.at(-1)?.timestamp;
      const at =
        typeof last === "string" ? last : new Date(fs.statSync(journal).mtimeMs).toISOString();
      const step = started.get(key);
      items.push({
        at,
        kind: "role",
        name: role || "a role",
        session,
        run,
        step: step ? [step.phase, step.label].filter(Boolean).join(" · ") : "",
        output: entry.result,
      });
    }
  }
  return items;
}

/** What the project's roles and loops gave, newest first, as the query narrows it. */
export function projectOutputs(root: string, query: OutputQuery = {}): OutputList {
  const folder = path.join(transcriptsDir(), path.resolve(root).replace(/[^A-Za-z0-9]/g, "-"));
  if (!fs.existsSync(folder)) return { items: [], roles: [], loops: [] };
  const sessions = fs
    .readdirSync(folder)
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => ({ file: path.join(folder, file), session: file.slice(0, -6) }))
    .map((entry) => ({ ...entry, changed: fs.statSync(entry.file).mtimeMs }))
    .sort((a, b) => b.changed - a.changed)
    .slice(0, SESSIONS_READ);
  const all = sessions.flatMap(({ file, session }) => [
    ...roleOutputs(session, file),
    ...loopOutputs(session, file),
  ]);
  const before = query.before ? Date.parse(query.before) : NaN;
  const items = all
    .filter((item) => Number.isNaN(before) || (Date.parse(item.at) || 0) <= before)
    .filter((item) => !query.kind || item.kind === query.kind)
    .filter((item) => !query.name || item.name === query.name)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, query.limit ?? 100);
  const names = (kind: OutputItem["kind"]) =>
    [...new Set(all.filter((item) => item.kind === kind).map((item) => item.name))].sort();
  return { items, roles: names("role"), loops: names("loop") };
}
