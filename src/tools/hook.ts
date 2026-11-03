#!/usr/bin/env node
/**
 * The hook helper Claude Code runs on the events the installer registered: one event
 * name as the argument, the event's JSON on stdin. It only records, notifies or
 * blocks; judgment stays with roles. Which actions run is declared by the loop
 * definitions (`triggers` in `.claude/loops/*.md`). It never breaks a session:
 * anything unexpected is logged to `.contrejour/hook-errors.log` and the event
 * passes.
 *
 * A role inside a loop cannot talk to the owner, so a session carries the owner's
 * replies into a loop as `args.answers`. `guard-owner-answers` makes sure each is
 * the owner's own: a message the owner typed in this session after the loop
 * stopped at that review, word for word. It blocks the run otherwise, and records
 * the answers it verified for the loop's `owner-review` step to check.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { declaredTriggers } from "./loops.js";
import {
  FRAMEWORK_TRIGGERS,
  loadExtension,
  triggersOf,
  type ProjectExtension,
} from "./project-manifest.js";
import { isRecord } from "./validate.js";

/** The project this helper is installed in: `<root>/.contrejour/dist/tools/hook.js`. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const trajectoriesDir = (root: string): string =>
  path.join(path.resolve(root), ".contrejour", "trajectories");
const safe = (value: unknown): string =>
  String(value ?? "unknown").replace(/[^A-Za-z0-9._-]/g, "_");

function runningWorkflows(input: Record<string, unknown>): { id: string; name: string }[] {
  const tasks = Array.isArray(input.background_tasks) ? input.background_tasks : [];
  return tasks
    .filter((task) => isRecord(task) && task.type === "workflow" && task.status === "running")
    .map((task) => ({
      id: String((task as Record<string, unknown>).id),
      name: String((task as Record<string, unknown>).name),
    }));
}

/**
 * A role finished, or the session stopped: keep the transcript in the project,
 * because Claude Code's own copy lives under the user's home, is cleaned up
 * after a while and changes format between versions, and index which session,
 * loop and task (the project says which, such as a submission) it belonged to.
 * A role has its own transcript; the session's is the entry role's, copied again
 * each time the session stops.
 */
export function recordTrajectory(
  root: string,
  input: Record<string, unknown>,
  extension: ProjectExtension = {},
): void {
  const dir = path.join(trajectoriesDir(root), safe(input.session_id));
  fs.mkdirSync(dir, { recursive: true });
  const isRole = input.agent_id !== undefined;
  const transcript = isRole ? input.agent_transcript_path : input.transcript_path;
  const source = typeof transcript === "string" ? transcript : null;
  const id = isRole ? safe(input.agent_id) : "session";
  const file = path.join(dir, `${safe(input.agent_type)}-${id}.jsonl`);
  if (source && fs.existsSync(source)) fs.copyFileSync(source, file);
  const entry = {
    at: new Date().toISOString(),
    session_id: input.session_id ?? null,
    agent_type: input.agent_type ?? null,
    agent_id: isRole ? input.agent_id : "session",
    workflows: runningWorkflows(input),
    submission:
      typeof input.session_id === "string" && extension.taskOf
        ? extension.taskOf(root, input.session_id)
        : null,
    transcript: source && fs.existsSync(file) ? path.relative(root, file) : null,
  };
  fs.appendFileSync(path.join(trajectoriesDir(root), "index.jsonl"), `${JSON.stringify(entry)}\n`);
}

/** Where the hook keeps the owner's answers it verified, one file per review. */
export const answersDir = (root: string): string =>
  path.join(path.resolve(root), ".contrejour", "reviews", "answers");
export const answerFile = (root: string, reviewId: string): string =>
  path.join(answersDir(root), `${reviewId.replace(/[^A-Za-z0-9._-]/g, "-")}.json`);

export interface SessionLog {
  /** What the owner typed, with its place in the transcript. */
  owner: { index: number; text: string }[];
  /** Where a loop first stopped for the owner at each review id. */
  stops: Map<string, number>;
}
/** The owner's messages and the loops' stops for the owner, in a session transcript. */
export function readSessionLog(transcript: string): SessionLog {
  const log: SessionLog = { owner: [], stops: new Map() };
  transcript.split("\n").forEach((line, index) => {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(entry) || entry.type !== "user" || entry.isMeta) return;
    const message = isRecord(entry.message) ? entry.message : {};
    const content = message.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content) &&
            content.length &&
            content.every((block) => isRecord(block) && block.type === "text")
          ? content.map((block) => String((block as Record<string, unknown>).text ?? "")).join("")
          : null;
    if (text === null) return;
    // Typed by a person: no origin (Claude Code 2.1.316 and before) or a human one (2.1.317
    // on, promptSource "typed"), and never sent by the system. A loop's result reaches the
    // session as a notification; a message relayed from another session or channel has its
    // own origin. Neither is the owner's words.
    const origin = isRecord(entry.origin) ? entry.origin : null;
    const typed =
      entry.promptSource !== "system" &&
      (entry.origin === undefined || (origin !== null && origin.kind === "human"));
    if (!typed) {
      if (entry.promptSource !== "system" && origin?.kind !== "task-notification") return;
      for (const match of text.matchAll(/"review_id"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
        let id: string;
        try {
          id = JSON.parse(`"${match[1]}"`) as string;
        } catch {
          continue;
        }
        if (!log.stops.has(id)) log.stops.set(id, index);
      }
      return;
    }
    if (/^<(task-notification|system-reminder|command-|local-command)/.test(text.trim())) return;
    log.owner.push({ index, text: text.trim() });
  });
  return log;
}
/** Why the answers a session passes to a loop are not all the owner's own; empty when they are. */
export function answerProblems(log: SessionLog, answers: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const [id, answer] of Object.entries(answers)) {
    const stop = log.stops.get(id);
    if (typeof answer !== "string" || !answer.trim())
      problems.push(`the answer to "${id}" is not text`);
    else if (stop === undefined)
      problems.push(`no loop stopped at "${id}" in this session, so the owner was never shown it`);
    else if (!log.owner.some((message) => message.index > stop && message.text === answer.trim()))
      problems.push(
        `the answer to "${id}" is not, word for word and whole, a message the owner typed after the loop stopped there`,
      );
  }
  return problems;
}
function guardOwnerAnswers(root: string, input: Record<string, unknown>): string | null {
  const toolInput = isRecord(input.tool_input) ? input.tool_input : {};
  if (input.tool_name !== "Workflow") {
    const target = toolInput.file_path ?? toolInput.notebook_path;
    if (typeof target !== "string" || !target) return null;
    const cwd = typeof input.cwd === "string" ? input.cwd : root;
    const resolved = path.resolve(cwd, target);
    const dir = answersDir(root);
    return resolved === dir || resolved.startsWith(dir + path.sep)
      ? "Contrejour: the owner's verified answers are written only by the hook, when a session passes them to a loop."
      : null;
  }
  const args = isRecord(toolInput.args) ? toolInput.args : {};
  if (!isRecord(args.answers) || !Object.keys(args.answers).length) return null;
  const transcript = typeof input.transcript_path === "string" ? input.transcript_path : "";
  if (!transcript || !fs.existsSync(transcript))
    return "Contrejour: the owner's answers cannot be checked, because this session's transcript is not available. Run the loop without answers; it asks the owner again.";
  const problems = answerProblems(
    readSessionLog(fs.readFileSync(transcript, "utf8")),
    args.answers,
  );
  if (problems.length)
    return `Contrejour: an answer passed to a loop must be a message the owner typed in this session after the loop stopped at that review, whole and word for word: ${problems.join("; ")}. Show the owner the review note and pass their reply unchanged; drop answers this session never received.`;
  fs.mkdirSync(answersDir(root), { recursive: true });
  for (const [id, answer] of Object.entries(args.answers))
    fs.writeFileSync(
      answerFile(root, id),
      `${JSON.stringify({ review_id: id, answer, session_id: input.session_id ?? null, verified_at: new Date().toISOString() }, null, 2)}\n`,
    );
  return null;
}

const deny = (reason: string): string =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });

async function handle(event: string, input: Record<string, unknown>): Promise<string | null> {
  const actions = declaredTriggers(ROOT);
  const triggers = triggersOf(ROOT);
  const on = (action: string) => actions.has(action) && (triggers[action] ?? []).includes(event);
  // The project's own actions, and the task a trajectory belongs to, come from its extension.
  const needed =
    [...actions].some((action) => on(action) && !FRAMEWORK_TRIGGERS[action]) ||
    on("record-trajectory");
  const extension = needed ? await loadExtension(ROOT) : {};
  if (on("record-trajectory")) recordTrajectory(ROOT, input, extension);
  if (on("guard-owner-answers")) {
    const reason = guardOwnerAnswers(ROOT, input);
    if (reason) return deny(reason);
  }
  for (const action of [...actions].sort()) {
    if (FRAMEWORK_TRIGGERS[action] || !on(action)) continue;
    const run = extension.hookActions?.[action];
    if (!run)
      throw new Error(
        `the loops declare the hook action ${action}, which the project's extension does not provide`,
      );
    const reason = await run(ROOT, event, input);
    if (reason) return deny(reason);
  }
  return null;
}

function main(): void {
  const event = process.argv[2] ?? "";
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => (text += chunk));
  process.stdin.on("end", () => {
    void (async () => {
      try {
        const input: unknown = text.trim() ? JSON.parse(text) : {};
        const output = await handle(event, isRecord(input) ? input : {});
        if (output) process.stdout.write(`${output}\n`);
      } catch (error) {
        try {
          fs.appendFileSync(
            path.join(ROOT, ".contrejour", "hook-errors.log"),
            `${new Date().toISOString()} ${event}: ${String(error)}\n`,
          );
        } catch {
          // Nowhere to log; let the event pass.
        }
      }
    })();
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
