import {
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  Info,
  ListCollapse,
  Loader2,
  Play,
  Square,
  TriangleAlert,
  Workflow,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AuthoringStatus,
  SessionTimeline,
  TimelineItem,
} from "../../../src/tools/studio-types.js";
import { api } from "../api.js";
import { useLang } from "../i18n.js";
import { Markdown } from "../Markdown.js";
import type { Focus, Names } from "../types.js";
import { Button, cx } from "../ui.js";
import { outcomeOf } from "./outcome.js";
import { duration, foldTurns, groupRows, summarize, type Row, type ToolItem } from "./timeline.js";
import {
  GroupRow,
  RoleStatus,
  ThoughtRow,
  ToolRow,
  workSentence,
  type DetailReader,
} from "./ToolRow.js";

/** A message the owner sent the session, shown until the session's transcript has it. */
export interface PendingReply {
  text: string;
  at: string;
}

/**
 * One conversation with a background session, as it goes: what the Studio
 * asked, what the session said and did, the loop's roles, the owner's replies,
 * and at its end what it waits for or how it ended. Read from the session's
 * transcript, often while it works.
 */
export function SessionView({
  conversation,
  status,
  live,
  pending,
  onReply,
  onStop,
  onViewFiles,
  names,
  onFocus,
}: {
  conversation: string;
  /** The conversation's latest status, as the Studio last read it. */
  status: AuthoringStatus | null;
  /** The conversation the chat is on now: followed as it goes. */
  live: boolean;
  pending: PendingReply[];
  /** A quick reply to the review it waits at, while it waits. */
  onReply?: (text: string) => void;
  onStop?: () => Promise<void>;
  onViewFiles: (files: { name: string; text: string; original: string | null }[]) => void;
  names: Names;
  onFocus: (focus: Focus) => void;
}) {
  const { t } = useLang();
  const [timeline, setTimeline] = useState<SessionTimeline | null>(null);
  const state = status?.state ?? "running";
  // Often while it works, now and then while it waits, once when it is over.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api.timeline(conversation);
        if (!stopped) setTimeline(next);
      } catch {
        // Tried again on the next round.
      }
      if (!stopped && live && state !== "done" && state !== "gone")
        timer = setTimeout(() => void poll(), state === "running" ? 1500 : 5000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [conversation, live, state]);

  const items = timeline?.items ?? [];
  const lastTurn = items.at(-1)?.turn ?? 0;
  const rows = useMemo(
    () => foldTurns(groupRows(items), live && state === "running" ? lastTurn : null),
    [items, live, state, lastTurn],
  );
  // The owner's replies the transcript does not have yet: each until a message of the same words comes after it.
  const unseen = pending.filter(
    (reply) =>
      !items.some(
        (item) =>
          item.kind === "owner" &&
          item.text === reply.text.trim() &&
          (!item.at || item.at >= reply.at),
      ),
  );
  const read: DetailReader = (tool) => api.tool(conversation, tool);
  const startedAt =
    [...items].reverse().find((item) => item.kind === "owner" || item.kind === "prompt")?.at ||
    status?.started_at ||
    "";

  return (
    <div className="space-y-1.5">
      {!items.length && state === "running" && (
        <p className="flex items-center gap-1.5 text-xs text-ink-4">
          <Loader2 size={12} className="animate-spin" /> {t("session_empty")}
        </p>
      )}
      <Rows
        rows={rows}
        read={read}
        conversation={conversation}
        live={live}
        stopped={state !== "running"}
        names={names}
        onFocus={onFocus}
      />
      {unseen.map((reply) => (
        <div key={reply.at} className="flex justify-end">
          <div className="max-w-[88%] rounded-2xl rounded-tr-md bg-brand-600/70 px-3.5 py-2 text-[13px] leading-5 text-white">
            {reply.text}
            <div className="mt-0.5 text-[10.5px] text-white/80">{t("session_sending")}</div>
          </div>
        </div>
      ))}
      {timeline?.record_missing && (
        <Notice level="warning" text={t("record_missing", { dir: timeline.record_missing })} />
      )}
      <Footer
        status={status}
        live={live}
        startedAt={startedAt}
        onReply={onReply}
        onStop={onStop}
        onViewFiles={onViewFiles}
      />
    </div>
  );
}

/** The rows of a conversation or of a role, each by its kind. */
function Rows({
  rows,
  read,
  conversation,
  live,
  stopped,
  names,
  onFocus,
  role = false,
}: {
  rows: Row[];
  read: DetailReader;
  conversation: string;
  live: boolean;
  stopped: boolean;
  names: Names;
  onFocus: (focus: Focus) => void;
  /** A role's rows: its first message is the task its loop gave it. */
  role?: boolean;
}) {
  return (
    <>
      {rows.map((row) => {
        if (row.type === "group")
          return <GroupRow key={row.id} items={row.items} running={row.running} read={read} />;
        if (row.type === "fold")
          return (
            <FoldRow key={row.id} row={row}>
              <Rows
                rows={row.rows}
                read={read}
                conversation={conversation}
                live={live}
                stopped={stopped}
                names={names}
                onFocus={onFocus}
                role={role}
              />
            </FoldRow>
          );
        if (row.type === "loop")
          return (
            <LoopCard
              key={row.item.id}
              item={row.item}
              conversation={conversation}
              live={live}
              stopped={stopped}
              names={names}
              onFocus={onFocus}
            />
          );
        return (
          <ItemRow
            key={row.item.id}
            item={row.item}
            read={read}
            names={names}
            onFocus={onFocus}
            role={role}
          />
        );
      })}
    </>
  );
}

function ItemRow({
  item,
  read,
  names,
  onFocus,
  role,
}: {
  item: TimelineItem;
  read: DetailReader;
  names: Names;
  onFocus: (focus: Focus) => void;
  role: boolean;
}) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  if (item.kind === "tool") return <ToolRow item={item} read={read} />;
  if (item.kind === "thinking") return <ThoughtRow />;
  if (item.kind === "prompt")
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-ink-4 hover:bg-canvas hover:text-ink-3"
        >
          <Play size={11} />
          {role
            ? t("role_task")
            : item.loop
              ? t("session_prompt", { loop: item.loop })
              : t("session_prompt_other")}
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </button>
        {open && (
          <pre className="ml-[26px] mt-0.5 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-white px-3 py-2 font-mono text-[11px] leading-5 text-ink-3">
            {item.args || item.text}
          </pre>
        )}
      </div>
    );
  if (item.kind === "owner")
    return (
      <div className="flex justify-end pt-1">
        <div className="max-w-[88%] rounded-2xl rounded-tr-md bg-brand-600 px-3.5 py-2 text-[13px] leading-5 text-white">
          {item.pointers.length > 0 && (
            <div className="mb-1 flex flex-wrap gap-1">
              {item.pointers.map((pointer) => (
                <span key={pointer} className="rounded bg-white/20 px-1 text-[11px]">
                  @{pointer}
                </span>
              ))}
            </div>
          )}
          <span className="whitespace-pre-wrap">{item.text}</span>
        </div>
      </div>
    );
  if (item.kind === "text")
    return (
      <div className="px-0.5 py-0.5">
        <Markdown
          text={item.text}
          roles={names.roles}
          onRole={(name) => onFocus({ kind: "role", name })}
          loops={names.loops}
          onLoop={(name) => onFocus({ kind: "loop", name })}
        />
      </div>
    );
  if (item.kind === "notice")
    return (
      <Notice
        level={item.level}
        text={
          item.text === "interrupted"
            ? t("notice_interrupted")
            : item.text === "compacted"
              ? t("notice_compacted")
              : item.text
        }
      />
    );
  if (item.kind === "turn-end")
    return (
      <div className="flex items-center gap-2 px-1.5 pb-1 text-[11px] text-ink-4">
        <span>{t("session_worked", { time: duration(item.durationMs) })}</span>
      </div>
    );
  return null;
}

/** A finished turn's work, under one line that says what it did. */
function FoldRow({
  row,
  children,
}: {
  row: Extract<Row, { type: "fold" }>;
  children: React.ReactNode;
}) {
  const { t, lang } = useLang();
  const [open, setOpen] = useState(false);
  const sentence = workSentence(summarize(row.items), t, lang);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={cx(
          "flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12px] text-ink-4 hover:bg-canvas hover:text-ink-3",
          open && "bg-canvas",
        )}
      >
        <ListCollapse size={13} />
        <span className="truncate">
          {sentence ? t("fold_label", { summary: sentence }) : t("fold_empty")}
        </span>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {open && (
        <div className="ml-[13px] space-y-1 border-l border-line pl-2.5 pt-1">{children}</div>
      )}
    </div>
  );
}

/** A loop the session ran: its roles as they go, each open to what it did. */
function LoopCard({
  item,
  conversation,
  live,
  stopped,
  names,
  onFocus,
}: {
  item: ToolItem;
  conversation: string;
  live: boolean;
  stopped: boolean;
  names: Names;
  onFocus: (focus: Focus) => void;
}) {
  const { t } = useLang();
  const running = item.status === "running" && !stopped;
  const [open, setOpen] = useState(running);
  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);
  const [role, setRole] = useState<string | null>(null);
  const roles = item.run?.roles ?? [];
  const waiting = item.result === "waiting:owner";
  return (
    <div className="rounded-xl border border-line bg-white">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-loop-50 text-loop-600">
          <Workflow size={13} />
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={cx(
              "block truncate text-[13px] font-semibold",
              running ? "shimmer-text" : "text-ink",
            )}
          >
            {t("tool_workflow")} {item.summary}
          </span>
          <span className="block truncate text-[11px] text-ink-4">
            {running
              ? t("loop_running", { n: roles.length })
              : item.status === "failed"
                ? t("loop_failed")
                : waiting
                  ? t("session_waiting")
                  : item.result || (item.status === "done" ? t("loop_done") : t("loop_stopped"))}
          </span>
        </span>
        {running ? (
          <Loader2 size={14} className="animate-spin text-brand-600" />
        ) : item.status === "failed" ? (
          <TriangleAlert size={14} className="text-bad-600" />
        ) : item.status === "done" ? (
          <Check size={14} className="text-ok-600" />
        ) : null}
        {open ? (
          <ChevronDown size={13} className="text-ink-4" />
        ) : (
          <ChevronRight size={13} className="text-ink-4" />
        )}
      </button>
      {open && (
        <div className="border-t border-line px-2 py-1.5">
          {!roles.length && <p className="px-1.5 py-1 text-xs text-ink-4">{t("loop_no_roles")}</p>}
          {roles.map((entry) => (
            <div key={entry.agent}>
              <button
                type="button"
                onClick={() => setRole((current) => (current === entry.agent ? null : entry.agent))}
                className={cx(
                  "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12.5px] hover:bg-canvas",
                  role === entry.agent && "bg-canvas",
                )}
              >
                <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center">
                  <RoleStatus done={entry.done} stopped={stopped && !entry.done} />
                </span>
                <span className="shrink-0 text-ink-3">{entry.phase}</span>
                <span className="truncate rounded-md bg-brand-50 px-1.5 font-mono text-[11px] leading-5 text-brand-700">
                  {entry.role || entry.label}
                </span>
                <span className="ml-auto shrink-0 text-ink-4">
                  {role === entry.agent ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </span>
              </button>
              {role === entry.agent && item.run && (
                <div className="mb-1 ml-[13px] border-l border-line pl-2.5">
                  <RoleView
                    conversation={conversation}
                    run={item.run.id}
                    agent={entry.agent}
                    live={live && !entry.done && !stopped}
                    names={names}
                    onFocus={onFocus}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** What one role of a loop did, read from its own transcript; followed while it works. */
function RoleView({
  conversation,
  run,
  agent,
  live,
  names,
  onFocus,
}: {
  conversation: string;
  run: string;
  agent: string;
  live: boolean;
  names: Names;
  onFocus: (focus: Focus) => void;
}) {
  const { t } = useLang();
  const [timeline, setTimeline] = useState<SessionTimeline | null>(null);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api.timeline(conversation, { run, agent });
        if (!stopped) setTimeline(next);
      } catch {
        // Tried again on the next round.
      }
      if (!stopped && live) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [conversation, run, agent, live]);
  if (!timeline)
    return (
      <p className="flex items-center gap-1.5 px-1.5 py-1 text-xs text-ink-4">
        <Loader2 size={12} className="animate-spin" /> {t("tool_detail_loading")}
      </p>
    );
  const read: DetailReader = (tool) => api.tool(conversation, tool, { run, agent });
  // The role's task, from the loop, is the first message: shown folded, as the Studio's prompt is.
  return (
    <div className="space-y-1 py-1">
      {!timeline.items.length && <p className="px-1.5 text-xs text-ink-4">{t("session_empty")}</p>}
      <Rows
        rows={groupRows(timeline.items)}
        read={read}
        conversation={conversation}
        live={live}
        stopped={!live}
        names={names}
        onFocus={onFocus}
        role
      />
    </div>
  );
}

function Notice({ level, text }: { level: "info" | "warning" | "error"; text: string }) {
  const Icon = level === "error" ? XCircle : level === "warning" ? TriangleAlert : Info;
  return (
    <div
      className={cx(
        "flex gap-2 rounded-lg px-2.5 py-1.5 text-[12px] leading-5",
        level === "error" && "bg-bad-50 text-bad-600",
        level === "warning" && "bg-wait-50 text-wait-600",
        level === "info" && "bg-brand-50 text-brand-700",
      )}
    >
      <Icon size={14} className="mt-0.5 shrink-0" />
      <span className="min-w-0 select-text whitespace-pre-wrap break-words">{text}</span>
    </div>
  );
}

/** How long it has been going, ticking each second. */
function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const start = Date.parse(since);
  if (!Number.isFinite(start)) return null;
  return <span className="tabular-nums">{duration(now - start)}</span>;
}

/** What the conversation is doing now, at its end: working, waiting for the owner, or over. */
function Footer({
  status,
  live,
  startedAt,
  onReply,
  onStop,
  onViewFiles,
}: {
  status: AuthoringStatus | null;
  live: boolean;
  startedAt: string;
  onReply?: (text: string) => void;
  onStop?: () => Promise<void>;
  onViewFiles: (files: { name: string; text: string; original: string | null }[]) => void;
}) {
  const { t } = useLang();
  const [stopping, setStopping] = useState(false);
  const stopOnce = useRef(false);
  if (!status || status.state === "running") {
    if (!live) return null;
    return (
      <div className="flex items-center gap-2 px-1.5 pt-1 text-[12px] text-ink-3">
        <Loader2 size={14} className="animate-spin text-brand-600" />
        <span>{t("session_running")}</span>
        {startedAt && <Elapsed since={startedAt} />}
        {onStop && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            disabled={stopping}
            onClick={async () => {
              if (stopOnce.current) return;
              stopOnce.current = true;
              setStopping(true);
              try {
                await onStop();
              } finally {
                stopOnce.current = false;
                setStopping(false);
              }
            }}
          >
            {stopping ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Square size={11} fill="currentColor" />
            )}
            {stopping ? t("session_stopping") : t("session_stop")}
          </Button>
        )}
      </div>
    );
  }
  if (status.state === "waiting")
    return (
      <div className="space-y-2 rounded-xl border border-wait-500/40 bg-wait-50/50 px-3 py-2.5">
        <div className="text-[12.5px] font-semibold text-wait-600">
          {status.reply_failed
            ? t("reply_blocked")
            : status.draft
              ? status.draft.roles.length
                ? t("waiting_draft", { roles: status.draft.roles.join(", ") })
                : t("waiting_draft_plain")
              : t("session_waiting")}
        </div>
        {status.draft && !status.draft.flow && status.draft.files.length > 0 && (
          <Button size="sm" onClick={() => onViewFiles(status.draft!.files)}>
            <Eye size={13} /> {t("view_role_draft")}
          </Button>
        )}
        {status.reply_failed && status.last_words && (
          <div className="max-h-48 overflow-y-auto rounded-lg bg-white px-2.5 py-1">
            <Markdown text={status.last_words} />
          </div>
        )}
        {status.note && (
          <div className="scroll-thin max-h-[360px] overflow-y-auto rounded-lg bg-white px-3 py-1">
            <Markdown text={status.note} />
          </div>
        )}
        {status.review?.question && (
          <p className="text-[13px] font-semibold text-ink">{status.review.question}</p>
        )}
        {onReply && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="primary" onClick={() => onReply(t("approve_word"))}>
              <Check size={13} /> {t("approve")}
            </Button>
            <Button size="sm" onClick={() => onReply(t("cancel_word"))}>
              <X size={13} /> {t("cancel")}
            </Button>
            <span className="text-[11px] text-ink-4">{t("revise_hint")}</span>
          </div>
        )}
      </div>
    );
  if (status.state === "done") {
    const outcome = outcomeOf(status.result);
    // A loop run, not a change: said as what it is.
    const words =
      status.purpose === "run" && outcome.key === "authoring_done"
        ? t("run_done", { loop: status.loop, result: outcome.values.result ?? "" })
        : t(outcome.key, outcome.values);
    return (
      <div className="flex items-center gap-1.5 px-1.5 pt-0.5 text-[12px] text-ok-600">
        <Check size={13} /> <span className="text-ink-2">{words}</span>
      </div>
    );
  }
  if (status.state === "gone")
    return <Notice level="warning" text={t("authoring_gone", { session: status.session })} />;
  // Stopped with no result: what it said is in the rows above; how to look at it, here.
  return (
    <div className="space-y-1">
      <Notice
        level="warning"
        text={`${t("session_stopped")} ${t("session_attach", { session: status.session })}`}
      />
      {status.note && (
        <details className="px-1.5 text-[11.5px] text-ink-4">
          <summary className="cursor-pointer">{t("session_last_words")}</summary>
          <div className="mt-1 max-h-48 overflow-y-auto rounded-lg border border-line bg-white px-2.5 py-1 text-ink-2">
            <Markdown text={status.note} />
          </div>
        </details>
      )}
    </div>
  );
}
