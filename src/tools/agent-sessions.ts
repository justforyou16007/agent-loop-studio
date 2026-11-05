/**
 * The Studio's sessions with Claude Code, started from this process through the
 * Claude Agent SDK: one session per conversation, its input kept open so the
 * owner's replies go in as they come, and a loop it runs in the background
 * waking it when the loop ends. How a session stands is what it says as it goes:
 * working until nothing is left to do, loops in the background included, then
 * idle until the next message; with the words being written, and why a turn
 * failed. It writes its transcript as Claude Code always does, which is what the
 * chat and the hooks read.
 *
 * A session lives as long as the Studio: when the Studio stops, so do they, and
 * a reply later continues the same session from its transcript.
 */
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

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

/** The SDK's query, or what stands in for it. */
export type AgentQuery = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => Query;

export interface HostOptions {
  /** How the sessions run unattended: past every check, or with Claude Code's classifier deciding. */
  permissionMode: "bypassPermissions" | "auto";
  model?: string | null;
  /** Claude Code's executable, when the one the SDK brings should not run. */
  executable?: string | null;
  /** Stands in for the SDK, in tests. */
  query?: AgentQuery;
}

/** A conversation's session as it goes. */
export interface LiveSession {
  /** The conversation's id. */
  key: string;
  root: string;
  /** Claude Code's id of the session, once it has started it. */
  sessionId: string | null;
  /** Working (a turn, or a loop in the background), waiting for a message, or over. */
  state: "running" | "idle" | "closed";
  /**
   * What the session is writing, or wrote last: its message until the next one
   * starts, since its transcript has a whole message only a moment after it ends.
   */
  streaming: string;
  /** Why its last turn failed, or why the session ended, in Claude Code's words. */
  failure: string | null;
  /** Claude Code's last lines on its error output. */
  log: string[];
  /** Moves whenever the session records something new, rather than only writing on. */
  steps: number;
  /** When the Studio started it, in milliseconds. */
  startedAt: number;
}

/** The messages for a session, as they come: the session reads them as its input. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
  private ended = false;
  push(message: SDKUserMessage): boolean {
    if (this.ended) return false;
    if (this.waiting) {
      const take = this.waiting;
      this.waiting = null;
      take({ value: message, done: false });
    } else this.queue.push(message);
    return true;
  }
  end(): void {
    this.ended = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = null;
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () =>
        this.queue.length
          ? Promise.resolve({ value: this.queue.shift()!, done: false })
          : this.ended
            ? Promise.resolve({ value: undefined, done: true })
            : new Promise((resolve) => (this.waiting = resolve)),
    };
  }
}

/** A message for a session: the owner's, marked as typed by a person, or the Studio's own. */
const messageOf = (text: string, human: boolean): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
  // The SDK treats a message with no origin as nobody's; the owner's words are a person's.
  ...(human ? { origin: { kind: "human" as const } } : {}),
});

interface Running {
  live: LiveSession;
  query: Query;
  inbox: Inbox;
  /** Settled once the session has ended and its process is gone. */
  ended: Promise<void>;
}

export class SessionHost {
  private readonly sessions = new Map<string, Running>();
  private readonly listeners = new Set<(live: LiveSession) => void>();
  constructor(private readonly options: HostOptions) {}

  /**
   * Start a conversation's session with its first message, or continue an
   * earlier one (`resume`) with the next. Resolves once Claude Code has started
   * it; a session that cannot start fails here, with Claude Code's own words.
   */
  async start(request: {
    key: string;
    root: string;
    agent: string;
    message: string;
    human: boolean;
    resume?: string | null;
  }): Promise<LiveSession> {
    await this.close(request.key);
    const live: LiveSession = {
      key: request.key,
      root: request.root,
      sessionId: null,
      state: "running",
      streaming: "",
      failure: null,
      log: [],
      steps: 0,
      startedAt: Date.now(),
    };
    const inbox = new Inbox();
    const query = this.options.query ?? (await sdkQuery());
    const handle = query({
      prompt: inbox,
      options: {
        cwd: request.root,
        agent: request.agent,
        // Left out, the SDK sends a bare prompt of its own and the role's instructions never reach the model.
        systemPrompt: { type: "preset", preset: "claude_code" },
        env: {
          ...standaloneEnvironment(process.env),
          // Whether the session works or waits, as it changes.
          CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
          CLAUDE_AGENT_SDK_CLIENT_APP: "agent-loop-studio",
        },
        permissionMode: this.options.permissionMode,
        ...(this.options.permissionMode === "bypassPermissions"
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        // Nobody is there to approve: what would ask is refused at once rather than left waiting.
        permissionPrompts: "none",
        includePartialMessages: true,
        ...(this.options.model ? { model: this.options.model } : {}),
        ...(this.options.executable ? { pathToClaudeCodeExecutable: this.options.executable } : {}),
        ...(request.resume ? { resume: request.resume } : {}),
        stderr: (data: string) => {
          live.log = [...live.log, ...data.split(/\r?\n/).filter((line) => line.trim())].slice(-40);
        },
      },
    });
    let started!: () => void;
    let failed!: (error: Error) => void;
    const named = new Promise<void>((resolve, reject) => {
      started = resolve;
      failed = reject;
    });
    const running: Running = {
      live,
      query: handle,
      inbox,
      ended: Promise.resolve(),
    };
    running.ended = this.consume(running, started, failed);
    this.sessions.set(request.key, running);
    inbox.push(messageOf(request.message, request.human));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        named,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Claude Code did not start the session within two minutes")),
            120_000,
          );
        }),
      ]);
    } catch (error) {
      await this.close(request.key);
      throw error;
    } finally {
      clearTimeout(timer);
    }
    return live;
  }

  /** Read what the session says until it ends; the first message that names it means it has started. */
  private async consume(
    running: Running,
    started: () => void,
    failed: (error: Error) => void,
  ): Promise<void> {
    const { live } = running;
    try {
      for await (const message of running.query) {
        const moved = this.apply(live, message);
        if (live.sessionId) started();
        if (moved) this.changed(live);
      }
    } catch (error) {
      live.failure = [(error as Error).message, ...live.log.slice(-5)].join("\n");
    }
    live.state = "closed";
    live.streaming = "";
    // Its process ended with no word as to why: what it printed on its way out.
    if (!live.failure && !live.sessionId)
      live.failure =
        live.log.slice(-5).join("\n") || "Claude Code ended the session before it started";
    // A session that never started fails its start; for one that did, this settles nothing.
    failed(new Error(live.failure ?? "the session ended"));
    this.changed(live);
  }

  /** What one message from the session says about it; false when nothing the owner sees moved. */
  private apply(live: LiveSession, message: SDKMessage): boolean {
    if (message.type === "stream_event") {
      // The session's own words as they are written; what a role of its loop writes is the role's.
      if (message.parent_tool_use_id) return false;
      const { event } = message;
      if (event.type === "message_start") live.streaming = "";
      else if (event.type === "content_block_delta" && event.delta.type === "text_delta")
        live.streaming += event.delta.text;
      else return false;
      return true;
    }
    live.steps += 1;
    if (message.type === "system") {
      if (message.subtype === "init") live.sessionId = message.session_id;
      else if (message.subtype === "session_state_changed")
        // Idle only when nothing is left: a loop in the background keeps it working past its turn.
        live.state = message.state === "idle" ? "idle" : "running";
    } else if (message.type === "result") {
      // An API error's words, or what stopped the turn short.
      live.failure = !message.is_error
        ? null
        : message.subtype === "success"
          ? message.result
          : message.errors.join("\n") || message.subtype;
    }
    return true;
  }

  private changed(live: LiveSession): void {
    for (const listener of this.listeners) listener(live);
  }

  /** Send the session a message; false when it is over, and must be continued with `start`. */
  send(key: string, text: string, human: boolean): boolean {
    const running = this.sessions.get(key);
    if (!running || running.live.state === "closed") return false;
    if (!running.inbox.push(messageOf(text, human))) return false;
    running.live.state = "running";
    running.live.failure = null;
    running.live.streaming = "";
    this.changed(running.live);
    return true;
  }

  /** Stop what the session is doing, the loop it runs in the background with it; it waits for a message after. */
  async interrupt(key: string): Promise<void> {
    const running = this.sessions.get(key);
    if (running?.live.state === "running") await running.query.interrupt();
  }

  /** End a conversation's session, until a message continues it; settled once its process is gone. */
  async close(key: string): Promise<void> {
    const running = this.sessions.get(key);
    if (!running) return;
    if (running.live.state !== "closed") {
      running.inbox.end();
      running.query.close();
    }
    await running.ended;
  }
  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((key) => this.close(key)));
  }

  get(key: string): LiveSession | null {
    return this.sessions.get(key)?.live ?? null;
  }
  /** Every session the Studio has started in this process, ended ones too. */
  all(): LiveSession[] {
    return [...this.sessions.values()].map((running) => running.live);
  }
  /** Follow every session: called on each change. */
  subscribe(listener: (live: LiveSession) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** The SDK, loaded when a session first starts: only the Studio's checkout has it, not a project's copy of the helpers. */
async function sdkQuery(): Promise<AgentQuery> {
  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    return sdk.query as AgentQuery;
  } catch (error) {
    throw new Error(
      `this copy of the Studio cannot start sessions, because the Claude Agent SDK is not installed beside it: start the Studio from a checkout of agent-loop-studio, prepared with npm ci (${(error as Error).message})`,
    );
  }
}
