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
import { translateFlow, type Lang } from "./translations.js";
import type { Effort } from "./efforts.js";
import {
  lastAssistantText,
  latestRun,
  loopCalls,
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

/**
 * What a conversation is: the owner's conversation in the chat (`chat`), where
 * the session runs the loop each request is for; running one of the project's
 * loops (`run`); or, as recorded by an earlier version, changing a loop or a
 * role through its authoring loop (`authoring`).
 */
export type Purpose = "chat" | "run" | "authoring";
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
  /** When the owner last stopped it: until their next message, or a new result of its loops, it stands stopped. */
  stopped_at?: string;
  /** How many results its loops had given when it was stopped: one more is a new one, whatever its time. */
  stopped_results?: number;
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
/**
 * The project's conversations, each naming the session as it is now: one whose
 * session left for a fresh transcript (`/clear`) is recorded under the new id,
 * so the chat reads, and a later message continues, what the session writes now.
 */
function currentStore(root: string, host: SessionHost): Conversation[] {
  const conversations = readStore(root);
  let moved = false;
  for (const conversation of conversations) {
    const now = host.get(conversation.id)?.sessionId;
    if (now && now !== conversation.session.session_id) {
      conversation.session.session_id = now;
      moved = true;
    }
  }
  if (moved) writeStore(root, conversations);
  return conversations;
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
 * The owner's words as the session receives them when they start a
 * conversation: as they typed them, and, in brackets, what the Studio shows
 * them, the loop on the canvas and what they pointed at, which say what "this
 * loop" or "this step" means. The session runs the loop the request is for.
 */
export function chatMessage(text: string, pointers: Pointer[], base: Conversation["base"]): string {
  // A slash command goes as typed: Claude Code runs it only when it is the whole message.
  if (isSlashCommand(text)) return text.trim();
  const where = base?.source === "library" ? "from the library" : "of this project";
  const shown = base
    ? `\n\n[In the Studio: the loop \`${base.name}\` (${where}) is on the canvas]`
    : "";
  return `${text}${shown}${pointing(pointers)}`.trim();
}
/** The owner's reply as the session receives it, and passes it to the loop: their words and what they pointed at. */
export const ownerMessage = (text: string, pointers: Pointer[]): string =>
  isSlashCommand(text) ? text.trim() : `${text}${pointing(pointers)}`.trim();
/** A Claude Code slash command, such as `/compact` or `/clear`: a word after a slash, alone or with its arguments. */
export const isSlashCommand = (text: string): boolean =>
  /^\/[A-Za-z][\w:-]*(\s|$)/.test(text.trim());

/**
 * The owner's conversation in the chat, started by their first message: a
 * session as the entry role, which runs the loop the request is for (making or
 * changing a loop or a role, running, trying or publishing one) or answers it.
 */
export async function startChat(
  projectRoot: string,
  host: SessionHost,
  request: {
    text: string;
    pointers: Pointer[];
    base: Conversation["base"];
    effort?: Effort | null;
  },
): Promise<Conversation> {
  return begin(projectRoot, host, {
    purpose: "chat",
    loop: "",
    base: request.base,
    prompt: chatMessage(request.text, request.pointers, request.base),
    // The owner typed it: their own words, not the Studio's.
    human: true,
    effort: request.effort ?? null,
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
  effort: Effort | null = null,
): Promise<Conversation> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(loop))
    throw new Error("a loop name is lowercase words joined by hyphens");
  return begin(projectRoot, host, {
    purpose: "run",
    loop,
    base: { name: loop, source: "project" },
    // Every role of the loop sees this message, so it names the loop and nothing else.
    prompt: `Run the ${loop} loop.`,
    effort,
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
  effort: Effort | null = null,
): Promise<Conversation> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(loop))
    throw new Error("a loop name is lowercase words joined by hyphens");
  return begin(projectRoot, host, {
    purpose: "run",
    loop: "loop-trial",
    base: { name: loop, source: "project" },
    prompt: `Run the loop-trial loop with args ${JSON.stringify({ loop, goal })}.`,
    effort,
  });
}

async function begin(
  projectRoot: string,
  host: SessionHost,
  request: {
    purpose: Purpose;
    loop: string;
    base: Conversation["base"];
    prompt: string;
    /** The owner typed the first message (a chat), rather than the Studio wording an action of theirs. */
    human?: boolean;
    /** The reasoning effort its session runs at, as the owner chose it in the chat. */
    effort: Effort | null;
  },
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
    // The Studio's own words for an action of the owner's are never an answer to a review.
    human: request.human ?? false,
    effort: request.effort,
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

/**
 * The reasoning effort the owner chose, for a conversation's session before a
 * message goes to it: one that runs at another takes it first. A session that
 * cannot change it still gets the message, at the level it has.
 */
async function withEffort(host: SessionHost, id: string, effort: Effort | null | undefined) {
  if (effort === undefined) return;
  await host.setEffort(id, effort).catch(() => false);
}

/**
 * Have a conversation's session run at another reasoning effort now, its turn
 * under way included. `applied` is false when no session runs it: the level
 * goes with the message that continues it.
 */
export async function setConversationEffort(
  projectRoot: string,
  host: SessionHost,
  id: string,
  effort: Effort | null,
): Promise<{ id: string; effort: Effort | null; applied: boolean }> {
  if (!hasConversation(projectRoot, id)) throw new Error(`no conversation ${id}`);
  return { id, effort, applied: await host.setEffort(id, effort) };
}

/** The sessions of the project's conversations: which conversation each is, and whether it works now. */
export function conversationSessions(
  projectRoot: string,
  host: SessionHost,
): Map<string, { conversation: string; working: boolean }> {
  return new Map(
    currentStore(path.resolve(projectRoot), host).map((conversation) => [
      conversation.session.session_id,
      { conversation: conversation.id, working: host.get(conversation.id)?.state === "running" },
    ]),
  );
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
  request: {
    id: string;
    text: string;
    pointers: Pointer[];
    /** The reasoning effort the owner chose in the chat: left out, the session's stays as it is. */
    effort?: Effort | null;
  },
): Promise<Conversation> {
  const root = path.resolve(projectRoot);
  const conversations = currentStore(root, host);
  const conversation = conversations.find((entry) => entry.id === request.id);
  if (!conversation) throw new Error(`no conversation ${request.id}`);
  const message = ownerMessage(request.text, request.pointers);
  if (!message) throw new Error("the reply is empty");
  await withEffort(host, conversation.id, request.effort);
  if (!host.send(conversation.id, message, true))
    await host.start({
      key: conversation.id,
      root,
      agent: entryRoleOf(root),
      message,
      human: true,
      resume: conversation.session.session_id,
      effort: request.effort ?? null,
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
  lang: Lang | null,
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
    // In the page's language, from the translation the draft carries (`loop-editor` writes it before the review).
    flow:
      named[1] === "loop" && loop
        ? {
            ...translateFlow(flowOf(draft.view, loop), (lang && loop.translations[lang]) || {}),
            lang: lang ?? "en",
          }
        : null,
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
function transcriptOf(
  root: string,
  host: SessionHost | null,
  id: string,
): string | null | undefined {
  const conversation = (host ? currentStore(root, host) : readStore(root)).find(
    (entry) => entry.id === id,
  );
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
  const transcript = transcriptOf(root, host, id);
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
  // The record already follows its session: the chat reads its timeline first.
  const transcript = transcriptOf(root, null, id);
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
  const root = path.resolve(projectRoot);
  const conversations = currentStore(root, host);
  const conversation = conversations.find((entry) => entry.id === id);
  if (!conversation) throw new Error(`no conversation ${id}`);
  // The turn and the loop it runs stop (an interrupt ends the session's background work too).
  await host.interrupt(id);
  // Until the owner's next message it stands stopped, not back at the review its loop last stopped at.
  conversation.stopped_at = new Date().toISOString();
  conversation.stopped_results = loopResults(
    transcriptEntries(transcriptPath(root, conversation.session.session_id)),
  ).length;
  writeStore(root, conversations);
}

/** How each recent conversation stands: working, waiting for the owner (with the note and the draft), or ended. */
export async function conversationStatuses(
  projectRoot: string,
  host: SessionHost,
  count = 5,
  /** The language a draft under review is shown in. */
  lang: Lang | null = null,
): Promise<ConversationStatus[]> {
  const root = path.resolve(projectRoot);
  const conversations = currentStore(root, host).slice(-count);
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
    // Stopped by the owner after their last message, with no result since (counted, not timed): it stays stopped.
    const stoppedAt = Date.parse(conversation.stopped_at ?? "") || 0;
    const stopped =
      stoppedAt > 0 &&
      stoppedAt >= sentAt &&
      results.length <= (conversation.stopped_results ?? results.length);
    let state: ConversationStatus["state"];
    if (live?.state === "running") state = "running";
    else if (stopped) state = "stopped";
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
      // A chat runs whatever loop each request is for: the one its session ran last.
      loop: conversation.loop || loopCalls(entries).at(-1)?.loop || "",
      base: conversation.base,
      started_at: conversation.started_at,
      state,
      review,
      note: review ? readNote(root, review.document) || lastAssistantText(entries) : "",
      result: state === "done" ? last : null,
      draft: review ? await draftOf(root, review, lang) : null,
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
  effort?: Effort | null,
): Promise<{ id: string; run: string }> {
  const root = path.resolve(projectRoot);
  const conversations = currentStore(root, host);
  const conversation = conversations.find((entry) => entry.id === id);
  if (!conversation) throw new Error(`no conversation ${id}`);
  const status = (await conversationStatuses(root, host, conversations.length)).find(
    (entry) => entry.id === id,
  );
  if (!status?.run || !status.resumable)
    throw new Error("this conversation has no loop run that stopped partway");
  // The Studio's words, as when it started the loop: the session resumes the run it names.
  const transcript = transcriptPath(root, conversation.session.session_id);
  const loop =
    loopCalls(transcriptEntries(transcript)).find((call) => call.run === status.run!.id)?.loop ||
    status.loop;
  const message = `Resume the run ${status.run.id} of the ${loop} loop where it stopped, with the arguments it was started with.`;
  await withEffort(host, conversation.id, effort);
  if (!host.send(conversation.id, message, false))
    await host.start({
      key: conversation.id,
      root,
      agent: entryRoleOf(root),
      message,
      human: false,
      resume: conversation.session.session_id,
      effort: effort ?? null,
    });
  conversation.sent.push({ text: message, at: new Date().toISOString() });
  writeStore(root, conversations);
  return { id, run: status.run.id };
}
