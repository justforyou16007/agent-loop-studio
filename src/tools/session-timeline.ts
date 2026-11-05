/**
 * A background session's conversation, as the Studio's chat shows it, read from
 * the transcript Claude Code keeps of it: what the Studio asked, what the owner
 * said, what the session said, each tool it called as one row whose status
 * follows its result, the loops it ran with their roles, API errors, and where
 * each turn ended. The bookkeeping Claude Code also writes there is left out.
 *
 * The rows follow the design of Paseo's agent timeline
 * (https://github.com/getpaseo/paseo, Apache-2.0), rebuilt here for
 * transcripts: one row kind each, a tool call upserted by its id, a loop that
 * runs in the background still running until its notification comes.
 */
import fs from "node:fs";
import path from "node:path";
import type {
  SessionTimeline,
  TimelineItem,
  TimelineRole,
  TimelineRun,
  ToolDetail,
  ToolKind,
} from "./studio-types.js";
import type { TranscriptEntry } from "./sessions.js";
import { isRecord } from "./validate.js";

/** What a long text keeps for the chat: a tool's output, a file's content. */
const DETAIL_LIMIT = 24_000;
/** What one message keeps: longer is cut, with a mark. */
const TEXT_LIMIT = 64_000;

const cut = (text: string, limit: number): string =>
  text.length > limit
    ? `${text.slice(0, limit)}\n… (${text.length - limit} more characters)`
    : text;
const stringOf = (value: unknown): string => (typeof value === "string" ? value : "");

/** A transcript read once and then only as it grows: the entries, and where reading stopped. */
const read = new Map<string, { offset: number; tail: Buffer; entries: TranscriptEntry[] }>();
export function transcriptEntries(file: string | null): TranscriptEntry[] {
  if (!file || !fs.existsSync(file)) return [];
  const size = fs.statSync(file).size;
  let known = read.get(file);
  // A file that shrank was rewritten: read it again from the start.
  if (!known || size < known.offset) known = { offset: 0, tail: Buffer.alloc(0), entries: [] };
  if (size > known.offset) {
    const fd = fs.openSync(file, "r");
    try {
      const fresh = Buffer.alloc(size - known.offset);
      fs.readSync(fd, fresh, 0, fresh.length, known.offset);
      const bytes = Buffer.concat([known.tail, fresh]);
      // Only whole lines: the last one may still be being written.
      const end = bytes.lastIndexOf(0x0a);
      const whole = end < 0 ? Buffer.alloc(0) : bytes.subarray(0, end);
      const entries = [...known.entries];
      for (const line of whole.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry: unknown = JSON.parse(line);
          if (isRecord(entry)) entries.push(entry);
        } catch {
          // Not an entry.
        }
      }
      known = {
        offset: size,
        tail: Buffer.from(end < 0 ? bytes : bytes.subarray(end + 1)),
        entries,
      };
    } finally {
      fs.closeSync(fd);
    }
  }
  read.set(file, known);
  return known.entries;
}

/** A path as the owner reads it: inside the project, from the project's folder. */
const shown = (file: string, root: string): string => {
  if (!file) return "";
  const relative = path.relative(root, file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.split(path.sep).join("/")
    : file;
};
/** `mcp__server__tool` as `server · tool`, `SomeTool` as it is. */
const humanName = (name: string): string => {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  return mcp ? `${mcp[1]} · ${mcp[2]}` : name;
};

/** What a tool call does, and what it was called on, from its name and its input. */
function describeTool(
  name: string,
  input: Record<string, unknown>,
  root: string,
): { tool: ToolKind; title: string; summary: string } {
  const file = shown(
    stringOf(input.file_path) || stringOf(input.notebook_path) || stringOf(input.path),
    root,
  );
  const firstLine = (text: string) => text.split("\n")[0]!.trim();
  switch (name) {
    case "Bash":
    case "PowerShell":
      return { tool: "shell", title: "", summary: firstLine(stringOf(input.command)) };
    case "BashOutput":
    case "KillShell":
      return {
        tool: "shell",
        title: name,
        summary: stringOf(input.bash_id) || stringOf(input.shell_id),
      };
    case "Read":
      return { tool: "read", title: "", summary: file };
    case "Write":
      return { tool: "write", title: "", summary: file };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { tool: "edit", title: "", summary: file };
    case "Grep":
    case "Glob":
      return {
        tool: "search",
        title: "",
        summary: [stringOf(input.pattern), file].filter(Boolean).join("  ·  "),
      };
    case "WebSearch":
    case "ToolSearch":
      return { tool: "search", title: "", summary: stringOf(input.query) };
    case "WebFetch":
      return { tool: "fetch", title: "", summary: stringOf(input.url) };
    case "Task":
    case "Agent":
      return {
        tool: "agent",
        title: stringOf(input.subagent_type),
        summary: stringOf(input.description) || firstLine(stringOf(input.prompt)),
      };
    case "Workflow": {
      const script = stringOf(input.scriptPath);
      return {
        tool: "workflow",
        title: "",
        summary: stringOf(input.name) || (script ? path.basename(script, ".js") : "") || "script",
      };
    }
    case "Skill":
      return { tool: "skill", title: "", summary: stringOf(input.skill) || stringOf(input.name) };
    case "TodoWrite":
      return {
        tool: "todo",
        title: "",
        summary: Array.isArray(input.todos) ? String(input.todos.length) : "",
      };
    default: {
      const first = Object.values(input).find((value) => typeof value === "string") as
        | string
        | undefined;
      return { tool: "other", title: humanName(name), summary: firstLine(first ?? "") };
    }
  }
}

/** The text of a message's content: a string, or its text parts. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => (part as { text: string }).text)
    .join("\n");
}

/** What the Studio sent to start a loop: `Run the <loop> loop[ with args <json>].` */
function promptOf(text: string): { loop: string | null; args: string } {
  const asked = /^Run the ([a-z0-9][a-z0-9-]*) loop(?: with args ([\s\S]*?))?\.\s*$/.exec(
    text.trim(),
  );
  if (!asked) return { loop: null, args: "" };
  let args = asked[2] ?? "";
  try {
    args = args ? JSON.stringify(JSON.parse(args), null, 2) : "";
  } catch {
    // Shown as written.
  }
  return { loop: asked[1]!, args };
}
/** The owner's words and what they pointed at on the canvas, as the Studio sends a reply. */
function ownerWords(text: string): { text: string; pointers: string[] } {
  const pointed = /\n*\[On the canvas: ([^\]]*)\]\s*$/.exec(text);
  return pointed
    ? {
        text: text.slice(0, pointed.index).trim(),
        pointers: pointed[1]!.split("; ").filter(Boolean),
      }
    : { text: text.trim(), pointers: [] };
}
/** Words in a user's turn that are Claude Code's own, not anybody's message. */
const NOISE = [
  /^No response requested\.?$/,
  /<local-command-(stdout|stderr|caveat)>/,
  /<command-(name|message|args)>/,
];
const INTERRUPTED = /^\[Request interrupted by user/;

/** A loop's or a background agent's result, in a line, as its notification carries it. */
function resultLine(result: string): string {
  const trimmed = result.trim();
  try {
    const value: unknown = JSON.parse(trimmed);
    if (isRecord(value)) {
      if (value.waiting === "owner") return "waiting:owner";
      for (const key of ["installed", "published", "loop", "role", "reason", "summary"])
        if (typeof value[key] === "string" && value[key]) return `${key}: ${String(value[key])}`;
    }
    return JSON.stringify(value).slice(0, 300);
  } catch {
    return trimmed.split("\n")[0]!.slice(0, 300);
  }
}

/** The roles a loop run started, in order, from the journal Claude Code keeps beside the transcript. */
function runRoles(dir: string): TimelineRole[] {
  const journal = path.join(dir, "journal.jsonl");
  if (!fs.existsSync(journal)) return [];
  const roles: (TimelineRole & { key: string })[] = [];
  for (const line of fs.readFileSync(journal, "utf8").split("\n")) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry) || typeof entry.key !== "string") continue;
    if (entry.type === "started") {
      const agent = String(entry.agentId ?? "");
      let role = "";
      try {
        const meta: unknown = JSON.parse(
          fs.readFileSync(path.join(dir, `agent-${agent}.meta.json`), "utf8"),
        );
        if (isRecord(meta) && typeof meta.agentType === "string") role = meta.agentType;
      } catch {
        // Written a moment after the role starts.
      }
      roles.push({
        key: entry.key,
        agent,
        role,
        phase: stringOf(entry.phase),
        label: stringOf(entry.label),
        done: false,
      });
    } else if (entry.type === "result") {
      const known = roles.find((role) => role.key === entry.key);
      if (known) known.done = true;
    }
  }
  return roles.map(({ key: _key, ...role }) => role);
}
/** The runs of a session's loops, oldest first: `<transcript>/subagents/workflows/<run>/`. */
function runDirs(transcript: string): { id: string; dir: string }[] {
  const runs = path.join(transcript.replace(/\.jsonl$/, ""), "subagents", "workflows");
  if (!fs.existsSync(runs)) return [];
  return fs
    .readdirSync(runs)
    .map((id) => ({ id, dir: path.join(runs, id) }))
    .filter((run) => fs.existsSync(path.join(run.dir, "journal.jsonl")))
    .sort((a, b) => fs.statSync(a.dir).birthtimeMs - fs.statSync(b.dir).birthtimeMs);
}

/**
 * The rows of a conversation, from a transcript's entries. The first message is
 * the Studio's own (`prompt`), the others the owner's; a tool call is running
 * until its result comes, a loop or background agent until its notification.
 */
export function timelineOf(
  entries: TranscriptEntry[],
  options: { root: string; transcript?: string | null },
): TimelineItem[] {
  const items: TimelineItem[] = [];
  const tools = new Map<string, Extract<TimelineItem, { kind: "tool" }>>();
  const texts = new Map<string, Extract<TimelineItem, { kind: "text" }>>();
  const thoughts = new Set<string>();
  const runs = options.transcript ? runDirs(options.transcript) : [];
  let turn = 0;
  let asked = false;
  let retrying: Extract<TimelineItem, { kind: "notice" }> | null = null;
  let workflows = 0;
  const said = (text: string, at: string, id: string) => {
    const words = text.trim();
    if (!words || NOISE.some((pattern) => pattern.test(words))) return;
    if (INTERRUPTED.test(words)) {
      items.push({ kind: "notice", id, turn, at, level: "warning", text: "interrupted" });
      return;
    }
    turn += 1;
    retrying = null;
    if (!asked) {
      asked = true;
      items.push({
        kind: "prompt",
        id,
        turn,
        at,
        text: cut(words, TEXT_LIMIT),
        ...promptOf(words),
      });
    } else items.push({ kind: "owner", id, turn, at, ...ownerWords(cut(words, TEXT_LIMIT)) });
  };
  for (const [index, entry] of entries.entries()) {
    const at = stringOf(entry.timestamp);
    const id = stringOf(entry.uuid) || `entry-${index}`;
    const message = isRecord(entry.message) ? entry.message : {};
    const content = message.content;
    if (entry.type === "user") {
      if (entry.isMeta === true || entry.isCompactSummary === true) continue;
      const origin = isRecord(entry.origin) ? entry.origin : {};
      if (origin.kind === "task-notification") {
        // A loop or background agent finished: its row takes its status and result.
        const text = contentText(content);
        const toolId = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(text)?.[1]?.trim() ?? "";
        const status = /<status>([^<]+)<\/status>/.exec(text)?.[1]?.trim() ?? "";
        const result = /<result>([\s\S]*?)<\/result>/.exec(text)?.[1] ?? "";
        const tool = tools.get(toolId);
        if (tool) {
          tool.status = status === "failed" || status === "error" ? "failed" : "done";
          tool.ended = at;
          tool.result = resultLine(result);
          if (tool.run) {
            const dir = runs.find((run) => run.id === tool.run!.id)?.dir;
            if (dir) tool.run.roles = runRoles(dir);
          }
        } else {
          const summary = /<summary>([^<]+)<\/summary>/.exec(text)?.[1]?.trim() ?? "";
          if (summary) items.push({ kind: "notice", id, turn, at, level: "info", text: summary });
        }
        continue;
      }
      if (typeof content === "string") {
        said(content, at, id);
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (!isRecord(part)) continue;
        if (part.type === "text") said(stringOf(part.text), at, id);
        if (part.type !== "tool_result") continue;
        const tool = tools.get(stringOf(part.tool_use_id));
        if (!tool) continue;
        const output = contentText(part.content);
        // A loop and a background agent answer at once that they started: they run until their notification.
        const background =
          tool.tool === "workflow" ||
          (tool.tool === "agent" && /background|async|started/i.test(output));
        if (part.is_error === true) tool.status = INTERRUPTED.test(output) ? "canceled" : "failed";
        else if (!background) tool.status = "done";
        if (tool.status !== "running") tool.ended = at;
        if (tool.tool === "workflow" && !tool.run) {
          // Its run: named in the answer, or else the next of the session's runs.
          const named = /\bwf_[A-Za-z0-9-]+/.exec(output)?.[0];
          const run = runs.find((known) => known.id === named) ?? runs[workflows];
          workflows += 1;
          if (run) tool.run = { id: run.id, roles: runRoles(run.dir) };
        }
      }
      continue;
    }
    if (entry.type === "assistant") {
      if (entry.isApiErrorMessage === true) {
        items.push({ kind: "notice", id, turn, at, level: "error", text: contentText(content) });
        continue;
      }
      const messageId = stringOf(message.id) || id;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (!isRecord(part)) continue;
        if (part.type === "text" && stringOf(part.text).trim()) {
          const known = texts.get(messageId);
          if (known) known.text = cut(`${known.text}\n\n${stringOf(part.text)}`, TEXT_LIMIT);
          else {
            const item = {
              kind: "text" as const,
              id: `${messageId}:text`,
              turn,
              at,
              text: cut(stringOf(part.text), TEXT_LIMIT),
            };
            texts.set(messageId, item);
            items.push(item);
          }
        } else if (part.type === "thinking" || part.type === "redacted_thinking") {
          if (thoughts.has(messageId)) continue;
          thoughts.add(messageId);
          items.push({ kind: "thinking", id: `${messageId}:thinking`, turn, at });
        } else if (part.type === "tool_use" || part.type === "server_tool_use") {
          const name = stringOf(part.name);
          const input = isRecord(part.input) ? part.input : {};
          const tool = {
            kind: "tool" as const,
            id: stringOf(part.id) || `${messageId}:${name}`,
            turn,
            at,
            name,
            ...describeTool(name, input, options.root),
            status: "running" as const,
            ended: "",
            run: null as TimelineRun | null,
            result: "",
          };
          tools.set(tool.id, tool);
          items.push(tool);
        }
      }
      retrying = null;
      continue;
    }
    if (entry.type === "system") {
      if (entry.subtype === "api_error" && isRecord(entry.error)) {
        // Retries come one after another: one notice that follows them.
        const text = stringOf(entry.error.formatted) || stringOf(entry.error.message);
        const attempt = typeof entry.retryAttempt === "number" ? entry.retryAttempt : 0;
        const of = typeof entry.maxRetries === "number" ? entry.maxRetries : 0;
        const line = attempt && of ? `${text} (retry ${attempt}/${of})` : text;
        const notice: Extract<TimelineItem, { kind: "notice" }> = retrying ?? {
          kind: "notice",
          id,
          turn,
          at,
          level: "warning",
          text: line,
        };
        notice.text = line;
        if (!retrying) items.push(notice);
        retrying = notice;
      } else if (entry.subtype === "turn_duration" && typeof entry.durationMs === "number") {
        items.push({ kind: "turn-end", id, turn, at, durationMs: entry.durationMs });
        retrying = null;
      } else if (entry.subtype === "compact_boundary") {
        items.push({ kind: "notice", id, turn, at, level: "info", text: "compacted" });
      }
    }
  }
  return items;
}

/** A session's conversation, from its transcript; `missing` names where it was looked for when there is none. */
export function sessionTimeline(
  transcript: string | null,
  root: string,
  missing: string,
): SessionTimeline {
  if (!transcript) return { items: [], record_missing: missing };
  return {
    items: timelineOf(transcriptEntries(transcript), { root, transcript }),
    record_missing: null,
  };
}

/** What one role of a loop run did, from its own transcript beside the session's. */
export function roleTimeline(
  transcript: string | null,
  run: string,
  agent: string,
  root: string,
): SessionTimeline {
  if (!transcript || !/^[A-Za-z0-9_-]+$/.test(run) || !/^[A-Za-z0-9_-]+$/.test(agent))
    return { items: [], record_missing: null };
  const file = path.join(
    transcript.replace(/\.jsonl$/, ""),
    "subagents",
    "workflows",
    run,
    `agent-${agent}.jsonl`,
  );
  return { items: timelineOf(transcriptEntries(file), { root }), record_missing: null };
}

/** One tool call in full: its command and output, its diff, the file it wrote, or its input and output. */
export function toolDetail(
  entries: TranscriptEntry[],
  toolId: string,
  root: string,
): ToolDetail | null {
  let use: Record<string, unknown> | null = null;
  let result: { output: string; failed: boolean; structured: unknown } | null = null;
  for (const entry of entries) {
    const message = isRecord(entry.message) ? entry.message : {};
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isRecord(part)) continue;
      if ((part.type === "tool_use" || part.type === "server_tool_use") && part.id === toolId)
        use = part;
      if (part.type === "tool_result" && part.tool_use_id === toolId)
        result = {
          output: contentText(part.content),
          failed: part.is_error === true,
          structured: entry.toolUseResult,
        };
    }
  }
  if (!use) return null;
  const name = stringOf(use.name);
  const input = isRecord(use.input) ? use.input : {};
  const output = result?.output ?? "";
  const error = result?.failed ? cut(output, DETAIL_LIMIT) : "";
  const structured = isRecord(result?.structured) ? result.structured : {};
  const file = shown(stringOf(input.file_path) || stringOf(input.notebook_path), root);
  if (name === "Bash" || name === "PowerShell") {
    const out = [stringOf(structured.stdout), stringOf(structured.stderr)]
      .filter(Boolean)
      .join("\n");
    return {
      kind: "shell",
      command: stringOf(input.command),
      output: cut(out || output, DETAIL_LIMIT),
      error,
    };
  }
  if ((name === "Edit" || name === "MultiEdit") && Array.isArray(structured.structuredPatch)) {
    const lines: Extract<ToolDetail, { kind: "diff" }>["lines"] = [];
    for (const hunk of structured.structuredPatch) {
      if (!isRecord(hunk) || !Array.isArray(hunk.lines)) continue;
      lines.push({
        kind: "hunk",
        text: `@@ -${String(hunk.oldStart)},${String(hunk.oldLines)} +${String(hunk.newStart)},${String(hunk.newLines)} @@`,
      });
      for (const line of hunk.lines) {
        const text = String(line);
        lines.push({
          kind: text.startsWith("+") ? "add" : text.startsWith("-") ? "remove" : "context",
          text: text.slice(1),
        });
      }
    }
    return { kind: "diff", file, lines: lines.slice(0, 2000), error };
  }
  if (name === "Edit" || name === "MultiEdit") {
    // Without the patch, the strings it replaced.
    const lines: Extract<ToolDetail, { kind: "diff" }>["lines"] = [
      ...stringOf(input.old_string)
        .split("\n")
        .map((text) => ({ kind: "remove" as const, text })),
      ...stringOf(input.new_string)
        .split("\n")
        .map((text) => ({ kind: "add" as const, text })),
    ];
    return { kind: "diff", file, lines: lines.slice(0, 2000), error };
  }
  if (name === "Write")
    return { kind: "content", file, content: cut(stringOf(input.content), DETAIL_LIMIT), error };
  if (name === "Read") return { kind: "content", file, content: cut(output, DETAIL_LIMIT), error };
  return {
    kind: "text",
    input: cut(JSON.stringify(input, null, 2), DETAIL_LIMIT),
    output: cut(output, DETAIL_LIMIT),
    error,
  };
}
