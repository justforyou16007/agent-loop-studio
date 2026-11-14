/**
 * The Studio's conversations with the authoring loops. What the owner asks for
 * in the chat starts `loop-authoring` (or `role-authoring`) in a session that
 * runs as the project's task manager, the role that runs loops and relays the
 * owner's answers. Where the loop stops for the owner, the Studio
 * shows its review note and the draft on the canvas; the owner's reply, exactly
 * as the Studio sends it, goes back to the session, which passes it to the loop
 * unchanged. The Studio itself decides nothing: the loop's roles do the work,
 * the owner decides, and the hook checks each answer came from the owner.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SessionHost } from "./agent-sessions.js";
import { flowOf } from "./flow.js";
import { entryRoleOf } from "./installation.js";
import { collectDraftView } from "./loop-view.js";
import {
  lastAssistantText,
  latestRun,
  loopResults,
  ownerWait,
  runProgress,
  transcriptPath,
  transcriptsDir,
} from "./session-record.js";
import {
  roleTimeline,
  sessionTimeline,
  toolDetail,
  transcriptEntries,
} from "./session-timeline.js";
import { writeStateJsonAtomic } from "./state-file.js";
import type {
  AuthoringStatus,
  CanvasPointer,
  SessionTimeline,
  ToolDetail,
} from "./studio-types.js";
import { isRecord } from "./validate.js";

export type AuthoringLoop = "loop-authoring" | "role-authoring";
/** Changing a loop or a role through its authoring loop, or running one of the project's loops. */
export type Purpose = "authoring" | "run";
export type Pointer = CanvasPointer;
export interface Conversation {
  id: string;
  purpose?: Purpose;
  loop: string;
  base: { name: string; source: string } | null;
  /** Claude Code's id of its session, which names its transcript and continues it. */
  session: { session_id: string };
  started_at: string;
  /** What the Studio sent the session for the owner, verbatim. */
  sent: { text: string; at: string }[];
}
export type ConversationStatus = AuthoringStatus;

const storeFile = (root: string): string =>
  path.join(root, ".contrejour", "studio", "conversations.json");
function readStore(root: string): Conversation[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(storeFile(root), "utf8"));
    return isRecord(parsed) && Array.isArray(parsed.conversations)
      ? (parsed.conversations as Conversation[])
      : [];
  } catch {
    return [];
  }
}
function writeStore(root: string, conversations: Conversation[]): void {
  fs.mkdirSync(path.dirname(storeFile(root)), { recursive: true });
  // Only the last few are kept: older ones are in Claude Code's own list of sessions.
  writeStateJsonAtomic(storeFile(root), {
    schema_version: 1,
    conversations: conversations.slice(-20),
  });
}

/** The things pointed at, in one line the loop's roles read with the owner's words. */
const pointing = (pointers: Pointer[]): string =>
  pointers.length
    ? `\n\n[On the canvas: ${pointers.map((pointer) => pointer.label).join("; ")}]`
    : "";

/**
 * What the owner wants, as `description`: their words, what they pointed at, and
 * the loop or role they were looking at. A role the owner chose to change is
 * changed; the loop on the canvas is what the words change unless they ask for
 * another loop, which the authoring loop's own steps then find or build.
 */
export function describeRequest(
  loop: AuthoringLoop,
  base: Conversation["base"],
  text: string,
  pointers: Pointer[],
): string {
  const where = base?.source === "library" ? "from the library" : "of this project";
  const opening = !base
    ? ""
    : loop === "loop-authoring"
      ? `The owner is looking at the loop \`${base.name}\` (${where}); their words change it, unless they ask for another loop: `
      : `Change the existing role \`${base.name}\` (${where}): `;
  return `${opening}${text}${pointing(pointers)}`;
}
/** The owner's reply as the session receives it, and passes it to the loop: their words and what they pointed at. */
export const ownerMessage = (text: string, pointers: Pointer[]): string =>
  `${text}${pointing(pointers)}`.trim();

export async function startConversation(
  projectRoot: string,
  host: SessionHost,
  request: { loop: AuthoringLoop; base: Conversation["base"]; text: string; pointers: Pointer[] },
): Promise<Conversation> {
  const description = describeRequest(request.loop, request.base, request.text, request.pointers);
  return begin(projectRoot, host, {
    purpose: "authoring",
    loop: request.loop,
    base: request.base,
    prompt: `Run the ${request.loop} loop with args ${JSON.stringify({ description })}.`,
  });
}

/**
 * Run one of the project's loops in a session, as the role that runs loops: it
 * passes the arguments the loop's definition names, and relays the
 * owner's answers when the loop stops for them.
 */
export function runLoop(
  projectRoot: string,
  host: SessionHost,
  loop: string,
): Promise<Conversation> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(loop))
    throw new Error("a loop name is lowercase words joined by hyphens");
  return begin(projectRoot, host, {
    purpose: "run",
    loop,
    base: { name: loop, source: "project" },
    // Every role of the loop sees this message, so it names the loop and nothing else.
    prompt: `Run the ${loop} loop.`,
  });
}

/**
 * Try a loop the way it will run: the loop-trial loop checks it statically, runs it
 * for real on a small scale and asks the owner, in the chat, whether what it did
 * serves their goal, improving it between trials.
 */
export function trialLoop(
  projectRoot: string,
  host: SessionHost,
  loop: string,
  goal: string,
): Promise<Conversation> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(loop))
    throw new Error("a loop name is lowercase words joined by hyphens");
  return begin(projectRoot, host, {
    purpose: "run",
    loop: "loop-trial",
    base: { name: loop, source: "project" },
    prompt: `Run the loop-trial loop with args ${JSON.stringify({ loop, goal })}.`,
  });
}

async function begin(
  projectRoot: string,
  host: SessionHost,
  request: { purpose: Purpose; loop: string; base: Conversation["base"]; prompt: string },
): Promise<Conversation> {
  const root = path.resolve(projectRoot);
  const id = crypto.randomBytes(4).toString("hex");
  const prompt = request.prompt;
  const live = await host.start({
    key: id,
    root,
    // The role that runs loops and relays the owner's answers.
    agent: entryRoleOf(root),
    message: prompt,
    // The Studio's own words, carrying the owner's: never an answer to a review.
    human: false,
  });
  const conversation: Conversation = {
    id,
    purpose: request.purpose,
    loop: request.loop,
    base: request.base,
    session: { session_id: live.sessionId! },
    started_at: new Date().toISOString(),
    sent: [{ text: prompt, at: new Date().toISOString() }],
  };
  writeStore(root, [...readStore(root), conversation]);
  return conversation;
}

/** Whether this project has that conversation. */
export function hasConversation(projectRoot: string, id: string): boolean {
  return readStore(path.resolve(projectRoot)).some((entry) => entry.id === id);
}

/**
 * The owner's message for a conversation: its session takes it as it is, or, once
 * that session is over (the Studio restarted, its process ended), the message
 * continues it from its transcript.
 */
export async function answerConversation(
  projectRoot: string,
  host: SessionHost,
  request: { id: string; text: string; pointers: Pointer[] },
): Promise<Conversation> {
  const root = path.resolve(projectRoot);
  const conversations = readStore(root);
  const conversation = conversations.find((entry) => entry.id === request.id);
  if (!conversation) throw new Error(`no conversation ${request.id}`);
  const message = ownerMessage(request.text, request.pointers);
  if (!message) throw new Error("the reply is empty");
  if (!host.send(conversation.id, message, true))
    await host.start({
      key: conversation.id,
      root,
      agent: entryRoleOf(root),
      message,
      human: true,
      resume: conversation.session.session_id,
    });
  conversation.sent.push({ text: message, at: new Date().toISOString() });
  writeStore(root, conversations);
  return conversation;
}

/**
 * The review note: `document` is the note itself, or the path of the file
 * holding it inside the project.
 */
function readNote(root: string, document: string): string {
  if (!document) return "";
  if (!document.includes("\n") && document.length < 400) {
    const file = path.resolve(root, document);
    if (file.startsWith(root + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile())
      return fs.readFileSync(file, "utf8").slice(0, 200_000);
  }
  return document.slice(0, 200_000);
}

async function draftOf(
  root: string,
  review: AuthoringStatus["review"],
): Promise<ConversationStatus["draft"]> {
  const named = /^(loop|role):([a-z0-9][a-z0-9-]*):/.exec(review?.review_id ?? "");
  if (!named) return null;
  const draft = await collectDraftView(root, named[2]!);
  if (!draft) return null;
  const loop = draft.view.loops.find(
    (entry) => entry.name === named[2] && entry.source === "project",
  );
  // A role's draft is read as text beside the role the project has now.
  const read = (file: string): string | null =>
    fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  const files = draft.roles.map((name) => ({
    name,
    text: read(path.join(root, ".contrejour", "drafts", named[2]!, "agents", `${name}.md`)) ?? "",
    original: read(path.join(root, ".claude", "agents", `${name}.md`)),
  }));
  return {
    name: named[2]!,
    flow: named[1] === "loop" && loop ? flowOf(draft.view, loop) : null,
    roles: draft.roles,
    files,
  };
}

/**
 * Before a project's folder is deleted: the conversations whose sessions still
 * work in it, which keep the folder. When none does, the sessions that only wait
 * for a message end, since their folder goes.
 */
export async function releaseSessions(projectRoot: string, host: SessionHost): Promise<string[]> {
  const root = path.resolve(projectRoot);
  const here = host.all().filter((live) => live.root === root);
  const working = here.filter((live) => live.state === "running");
  if (working.length) return working.map((live) => live.key);
  await Promise.all(here.map((live) => host.close(live.key)));
  return [];
}

/** The transcript of a conversation's session, by the conversation's id; undefined for no such conversation. */
function transcriptOf(root: string, id: string): string | null | undefined {
  const conversation = readStore(root).find((entry) => entry.id === id);
  return conversation ? transcriptPath(root, conversation.session.session_id) : undefined;
}
/** A conversation as the chat shows it, or one role of a loop it ran; null for no such conversation. */
export function conversationTimeline(
  projectRoot: string,
  host: SessionHost,
  id: string,
  role: { run: string; agent: string } | null = null,
): SessionTimeline | null {
  const root = path.resolve(projectRoot);
  const transcript = transcriptOf(root, id);
  if (transcript === undefined) return null;
  if (role) return roleTimeline(transcript, role.run, role.agent, root);
  const live = host.get(id);
  // A session just started may not have written its record yet: that is no missing record.
  const starting = live?.state === "running" && Date.now() - live.startedAt < 20_000;
  return {
    ...sessionTimeline(transcript, root, transcriptsDir()),
    ...(starting ? { record_missing: null } : {}),
    streaming: live?.streaming ?? "",
  };
}
/** One tool call of a conversation, or of one role of a loop it ran, in full. */
export function conversationTool(
  projectRoot: string,
  id: string,
  tool: string,
  role: { run: string; agent: string } | null = null,
): ToolDetail | null {
  const root = path.resolve(projectRoot);
  const transcript = transcriptOf(root, id);
  if (!transcript) return null;
  const file =
    role && /^[A-Za-z0-9_-]+$/.test(role.run) && /^[A-Za-z0-9_-]+$/.test(role.agent)
      ? path.join(
          transcript.replace(/\.jsonl$/, ""),
          "subagents",
          "workflows",
          role.run,
          `agent-${role.agent}.jsonl`,
        )
      : transcript;
  return toolDetail(transcriptEntries(file), tool, root);
}
/** Stop what a conversation's session is doing, a loop it runs with it; a message continues it later. */
export async function stopConversation(
  projectRoot: string,
  host: SessionHost,
  id: string,
): Promise<void> {
  if (!hasConversation(projectRoot, id)) throw new Error(`no conversation ${id}`);
  await host.interrupt(id);
}

/** How each recent conversation stands: working, waiting for the owner (with the note and the draft), or ended. */
export async function conversationStatuses(
  projectRoot: string,
  host: SessionHost,
  count = 5,
): Promise<ConversationStatus[]> {
  const root = path.resolve(projectRoot);
  const conversations = readStore(root).slice(-count);
  const statuses: ConversationStatus[] = [];
  for (const conversation of conversations) {
    const live = host.get(conversation.id);
    const transcript = transcriptPath(root, conversation.session.session_id);
    const entries = transcriptEntries(transcript);
    const results = loopResults(entries);
    const latest = results.at(-1) ?? null;
    const last = latest?.value ?? null;
    // A message the loop has not answered yet: sent after its latest result, or before it gave any.
    const sentAt = Date.parse(conversation.sent.at(-1)?.at ?? "") || 0;
    const pending = !latest || (Date.parse(latest.at) || 0) < sentAt;
    let state: ConversationStatus["state"];
    if (live?.state === "running") state = "running";
    // The loop still waits at its review until a new result comes, even when a reply did not reach it.
    else if (ownerWait(last)) state = "waiting";
    else if (!pending && last !== null) state = "done";
    // Its turn is over and its session waits for a message.
    else if (live?.state === "idle") state = "idle";
    // No session runs it any more: a message continues it from its transcript, if there is one.
    else state = transcript ? "stopped" : "gone";
    const review = state === "waiting" ? ownerWait(last) : null;
    // Its latest loop run, and whether the loop gave a result since it started: one that did not, in a
    // session no longer working, was stopped partway and can be resumed where it stopped.
    const run = latestRun(transcript);
    const ended =
      run !== null && latest !== null && (Date.parse(latest.at) || 0) >= Date.parse(run.started_at);
    const resumable = run !== null && !ended && (state === "stopped" || state === "idle");
    // A reply that did not reach the loop: what the session said about it.
    const replyFailed = state === "waiting" && pending;
    statuses.push({
      id: conversation.id,
      purpose: conversation.purpose ?? "authoring",
      loop: conversation.loop,
      base: conversation.base,
      started_at: conversation.started_at,
      state,
      review,
      note: review ? readNote(root, review.document) || lastAssistantText(entries) : "",
      result: state === "done" ? last : null,
      draft: review ? await draftOf(root, review) : null,
      progress: state === "running" ? runProgress(transcript) : [],
      reply_failed: replyFailed,
      last_words: replyFailed ? lastAssistantText(entries) : "",
      failure: live?.failure ?? null,
      run: run ? { id: run.id, started_at: run.started_at, steps: run.steps, ended } : null,
      resumable,
    });
  }
  return statuses.reverse();
}

/**
 * Resume a conversation's loop run where it stopped: the session runs the loop
 * again with the run's id (`resumeFromRunId`), so the roles that finished give
 * their results at once and the run goes on from where it was.
 */
export async function resumeConversation(
  projectRoot: string,
  host: SessionHost,
  id: string,
): Promise<{ id: string; run: string }> {
  const root = path.resolve(projectRoot);
  const conversations = readStore(root);
  const conversation = conversations.find((entry) => entry.id === id);
  if (!conversation) throw new Error(`no conversation ${id}`);
  const status = (await conversationStatuses(root, host, conversations.length)).find(
    (entry) => entry.id === id,
  );
  if (!status?.run || !status.resumable)
    throw new Error("this conversation has no loop run that stopped partway");
  // The Studio's words, as when it started the loop: the session resumes the run it names.
  const message = `Resume the run ${status.run.id} of the ${conversation.loop} loop where it stopped, with the arguments it was started with.`;
  if (!host.send(conversation.id, message, false))
    await host.start({
      key: conversation.id,
      root,
      agent: entryRoleOf(root),
      message,
      human: false,
      resume: conversation.session.session_id,
    });
  conversation.sent.push({ text: message, at: new Date().toISOString() });
  writeStore(root, conversations);
  return { id, run: status.run.id };
}
