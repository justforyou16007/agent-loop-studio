/**
 * The Studio's conversations with the authoring loops. What the owner asks for
 * in the chat starts `loop-authoring` (or `role-authoring`) in a background
 * session that runs as the project's task manager, the role that runs loops and
 * relays the owner's answers. Where the loop stops for the owner, the Studio
 * shows its review note and the draft on the canvas; the owner's reply, exactly
 * as the Studio sends it, goes back to the session, which passes it to the loop
 * unchanged. The Studio itself decides nothing: the loop's roles do the work,
 * the owner decides, and the hook checks each answer came from the owner.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { flowOf } from "./flow.js";
import { entryRoleOf } from "./installation.js";
import { collectDraftView } from "./loop-view.js";
import {
  lastAssistantText,
  listSessions,
  loopResults,
  ownerWait,
  readTranscript,
  runClaude,
  runProgress,
  sessionControl,
  sessionState,
  startSession,
  stopArgv,
  transcriptPath,
  type BackgroundSession,
  type SessionOptions,
} from "./sessions.js";
import { writeStateJsonAtomic } from "./state-file.js";
import type { AuthoringStatus, CanvasPointer } from "./studio-types.js";
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
  session: BackgroundSession;
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
  // Only the last few are kept: older ones are in Claude Code's own session list.
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
  options: SessionOptions,
  request: { loop: AuthoringLoop; base: Conversation["base"]; text: string; pointers: Pointer[] },
): Promise<Conversation> {
  const description = describeRequest(request.loop, request.base, request.text, request.pointers);
  return begin(projectRoot, options, {
    purpose: "authoring",
    loop: request.loop,
    base: request.base,
    prompt: `Run the ${request.loop} loop with args ${JSON.stringify({ description })}.`,
  });
}

/**
 * Run one of the project's loops in a background session, as the role that runs
 * loops: it passes the arguments the loop's definition names, and relays the
 * owner's answers when the loop stops for them.
 */
export function runLoop(
  projectRoot: string,
  options: SessionOptions,
  loop: string,
): Promise<Conversation> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(loop))
    throw new Error("a loop name is lowercase words joined by hyphens");
  return begin(projectRoot, options, {
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
  options: SessionOptions,
  loop: string,
  goal: string,
): Promise<Conversation> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(loop))
    throw new Error("a loop name is lowercase words joined by hyphens");
  return begin(projectRoot, options, {
    purpose: "run",
    loop: "loop-trial",
    base: { name: loop, source: "project" },
    prompt: `Run the loop-trial loop with args ${JSON.stringify({ loop, goal })}.`,
  });
}

async function begin(
  projectRoot: string,
  options: SessionOptions,
  request: { purpose: Purpose; loop: string; base: Conversation["base"]; prompt: string },
): Promise<Conversation> {
  const root = path.resolve(projectRoot);
  const id = crypto.randomBytes(4).toString("hex");
  const prompt = request.prompt;
  const session = await startSession(options, root, {
    name: `contrejour-studio-${id}`,
    // The role that runs loops and relays the owner's answers.
    agent: entryRoleOf(root),
    prompt,
  });
  const conversation: Conversation = {
    id,
    purpose: request.purpose,
    loop: request.loop,
    base: request.base,
    session,
    started_at: new Date().toISOString(),
    sent: [{ text: prompt, at: new Date().toISOString() }],
  };
  writeStore(root, [...readStore(root), conversation]);
  return conversation;
}

export async function answerConversation(
  projectRoot: string,
  options: SessionOptions,
  request: { id: string; text: string; pointers: Pointer[] },
): Promise<Conversation> {
  const root = path.resolve(projectRoot);
  const conversations = readStore(root);
  const conversation = conversations.find((entry) => entry.id === request.id);
  if (!conversation) throw new Error(`no conversation ${request.id}`);
  const message = ownerMessage(request.text, request.pointers);
  if (!message) throw new Error("the reply is empty");
  conversation.session = await sessionControl(options, root).resume(conversation.session, message);
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
 * Before a project's folder is deleted: the sessions the Studio started in it
 * that are still working, which keep the folder. When none is, the ones whose
 * process only waits (for the owner, say) are stopped, since their folder goes.
 */
export async function releaseSessions(
  projectRoot: string,
  options: SessionOptions,
): Promise<string[]> {
  const root = path.resolve(projectRoot);
  const sessions = new Map(readStore(root).map((entry) => [entry.session.id, entry.session]));
  if (!sessions.size) return [];
  const listed = await listSessions(options, root);
  const states = [...sessions.values()].map((session) => ({
    session,
    state: sessionState(listed.find((entry) => entry.id === session.id)),
  }));
  const working = states.filter((entry) => entry.state === "running");
  if (working.length) return working.map((entry) => entry.session.id);
  for (const { session, state } of states)
    if (state === "idle") {
      const stopped = await runClaude(stopArgv(options, session), root);
      if (!stopped.ok) throw new Error(`claude stop failed: ${stopped.stderr}`);
    }
  return [];
}

/** How each recent conversation stands: working, waiting for the owner (with the note and the draft), or ended. */
export async function conversationStatuses(
  projectRoot: string,
  options: SessionOptions,
): Promise<ConversationStatus[]> {
  const root = path.resolve(projectRoot);
  const conversations = readStore(root).slice(-5);
  if (!conversations.length) return [];
  const listed = await listSessions(options, root);
  const statuses: ConversationStatus[] = [];
  for (const conversation of conversations) {
    const live = sessionState(listed.find((entry) => entry.id === conversation.session.id));
    const transcript = transcriptPath(root, conversation.session.session_id);
    const entries = readTranscript(transcript);
    const results = loopResults(entries);
    const latest = results.at(-1) ?? null;
    const last = latest?.value ?? null;
    // A message the loop has not answered yet: sent after its latest result, or before it gave any.
    const sentAt = Date.parse(conversation.sent.at(-1)?.at ?? "") || 0;
    const pending = !latest || (Date.parse(latest.at) || 0) < sentAt;
    // Right after a reply Claude Code may still list the session as idle for a moment.
    const starting = pending && live === "idle" && Date.now() - sentAt < 20_000;
    let state: ConversationStatus["state"];
    if (live === "gone") state = "gone";
    else if (live === "running" || starting) state = "running";
    // The loop still waits at its review until a new result comes, even when a reply did not reach it.
    else if (ownerWait(last)) state = "waiting";
    else if (!pending && last !== null) state = "done";
    else state = live === "stopped" ? "stopped" : "idle";
    const review = state === "waiting" ? ownerWait(last) : null;
    // A reply that did not reach the loop: what the session said about it.
    const replyFailed = state === "waiting" && pending;
    statuses.push({
      id: conversation.id,
      purpose: conversation.purpose ?? "authoring",
      loop: conversation.loop,
      base: conversation.base,
      session: conversation.session.id,
      started_at: conversation.started_at,
      state,
      review,
      note: review
        ? readNote(root, review.document) || lastAssistantText(entries)
        : lastAssistantText(entries),
      result: state === "done" ? last : null,
      draft: review ? await draftOf(root, review) : null,
      progress: state === "running" ? runProgress(transcript) : [],
      reply_failed: replyFailed,
      last_words: replyFailed ? lastAssistantText(entries) : "",
    });
  }
  return statuses.reverse();
}
