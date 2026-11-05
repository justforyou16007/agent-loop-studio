import {
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  Globe,
  ListTodo,
  Loader2,
  Pencil,
  Search,
  Sparkles,
  SquareTerminal,
  TriangleAlert,
  Workflow,
  Wrench,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { ToolDetail, ToolKind } from "../../../src/tools/studio-types.js";
import { useLang, type TextKey } from "../i18n.js";
import { cx } from "../ui.js";
import { summarize, type ToolItem, type WorkItem, type WorkSummary } from "./timeline.js";

/** Reads one tool call in full; the caller knows the conversation, and the role when it is one's. */
export type DetailReader = (tool: string) => Promise<ToolDetail>;

const ICONS: Record<ToolKind | "thinking", typeof Bot> = {
  shell: SquareTerminal,
  read: Eye,
  write: Pencil,
  edit: Pencil,
  search: Search,
  fetch: Globe,
  agent: Bot,
  workflow: Workflow,
  skill: Sparkles,
  todo: ListTodo,
  other: Wrench,
  thinking: Brain,
};

/** A tool call's name as the owner reads it: the chat's own for the tools it knows. */
export function toolTitle(item: ToolItem, t: ReturnType<typeof useLang>["t"]): string {
  if (item.tool === "other" || (item.tool === "agent" && item.title))
    return item.title || item.name;
  return t(`tool_${item.tool}` as TextKey);
}

/** One sentence of what a stretch of work did: "edited 2 files and ran 3 commands". */
export function workSentence(
  summary: WorkSummary,
  t: ReturnType<typeof useLang>["t"],
  lang: string,
): string {
  const plural = (n: number) => ({ n, s: n === 1 ? "" : "s" });
  const parts = [
    summary.edited ? t("work_edited", plural(summary.edited)) : "",
    summary.commands ? t("work_commands", plural(summary.commands)) : "",
    summary.read ? t("work_read", plural(summary.read)) : "",
    summary.searches ? t("work_searches", plural(summary.searches)) : "",
    summary.other ? t("work_other", plural(summary.other)) : "",
  ].filter(Boolean);
  if (!parts.length) return summary.thoughts ? t("work_thought") : "";
  const joined =
    lang === "zh"
      ? parts.join("，")
      : parts.length === 1
        ? parts[0]!
        : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)!}`;
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/** The one line a row shows: icon, name, what it was about; a running one shimmers, a failed one is marked. */
function Line({
  icon: Icon,
  title,
  summary,
  running,
  failed,
  open,
  expandable,
  onToggle,
  trailing,
}: {
  icon: typeof Bot;
  title: string;
  summary: string;
  running: boolean;
  failed: boolean;
  open: boolean;
  expandable: boolean;
  onToggle: () => void;
  trailing?: ReactNode;
}) {
  const Lead = failed ? TriangleAlert : expandable && open ? ChevronDown : Icon;
  return (
    <button
      type="button"
      onClick={expandable ? onToggle : undefined}
      className={cx(
        "group flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12.5px]",
        expandable ? "hover:bg-canvas" : "cursor-default",
        open && "bg-canvas",
      )}
    >
      <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center">
        <Lead
          size={13}
          className={cx(
            failed ? "text-bad-600" : "text-ink-4",
            expandable && !failed && "group-hover:hidden",
          )}
        />
        {expandable && !failed && (
          <ChevronRight
            size={13}
            className={cx("hidden text-ink-3", !open && "group-hover:block")}
          />
        )}
      </span>
      <span className={cx("shrink-0 font-medium", running ? "shimmer-text" : "text-ink-3")}>
        {title}
      </span>
      {summary && (
        <span
          className={cx(
            "min-w-0 flex-1 truncate font-mono text-[11.5px]",
            running ? "shimmer-text" : "text-ink-4 group-hover:text-ink-3",
          )}
          title={summary}
        >
          {summary}
        </span>
      )}
      {trailing}
    </button>
  );
}

/** A tool call: one line, which opens to what it did in full. */
export function ToolRow({ item, read }: { item: ToolItem; read: DetailReader }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Line
        icon={ICONS[item.tool]}
        title={toolTitle(item, t)}
        summary={item.tool === "todo" ? t("tool_todo_n", { n: item.summary }) : item.summary}
        running={item.status === "running"}
        failed={item.status === "failed"}
        open={open}
        expandable
        onToggle={() => setOpen((value) => !value)}
      />
      {open && (
        <div className="mb-1 ml-[26px] mt-0.5 max-h-[400px] overflow-auto rounded-lg border border-line bg-white">
          <Detail read={read} tool={item.id} status={item.status} />
        </div>
      )}
    </div>
  );
}

/** A thought: the session reasoned here; Claude Code keeps no words of it. */
export function ThoughtRow() {
  const { t } = useLang();
  return (
    <Line
      icon={Brain}
      title={t("tool_thinking")}
      summary=""
      running={false}
      failed={false}
      open={false}
      expandable={false}
      onToggle={() => undefined}
    />
  );
}

/** A run of work: one line saying what it did, which opens to each step. */
export function GroupRow({
  items,
  running,
  read,
}: {
  items: WorkItem[];
  running: boolean;
  read: DetailReader;
}) {
  const { t, lang } = useLang();
  const [open, setOpen] = useState(false);
  const current = [...items]
    .reverse()
    .find((item): item is ToolItem => item.kind === "tool" && item.status === "running");
  const failed = items.some((item) => item.kind === "tool" && item.status === "failed");
  return (
    <div>
      <Line
        icon={Wrench}
        title={workSentence(summarize(items), t, lang)}
        summary={current ? `${toolTitle(current, t)} · ${current.summary}` : ""}
        running={running}
        failed={failed}
        open={open}
        expandable
        onToggle={() => setOpen((value) => !value)}
      />
      {open && (
        <div className="ml-[13px] border-l border-line pl-2.5">
          {items.map((item) =>
            item.kind === "thinking" ? (
              <ThoughtRow key={item.id} />
            ) : (
              <ToolRow key={item.id} item={item} read={read} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** What a tool call did in full, read when the owner opens it. */
function Detail({
  read,
  tool,
  status,
}: {
  read: DetailReader;
  tool: string;
  status: ToolItem["status"];
}) {
  const { t } = useLang();
  const [detail, setDetail] = useState<ToolDetail | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    read(tool)
      .then((found) => !gone && setDetail(found))
      .catch((reason: Error) => !gone && setProblem(reason.message));
    return () => {
      gone = true;
    };
    // Read again once its result has come.
  }, [tool, status]);
  if (problem) return <p className="px-3 py-2 text-xs text-ink-4">{t("tool_detail_none")}</p>;
  if (!detail)
    return (
      <p className="flex items-center gap-1.5 px-3 py-2 text-xs text-ink-4">
        <Loader2 size={12} className="animate-spin" /> {t("tool_detail_loading")}
      </p>
    );
  const error = detail.error ? (
    <section className="border-t border-bad-600/30 bg-bad-50 px-3 py-2">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-bad-600">
        {t("tool_error")}
      </div>
      <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-5 text-bad-600">
        {detail.error}
      </pre>
    </section>
  ) : null;
  if (detail.kind === "shell")
    return (
      <>
        <pre className="whitespace-pre-wrap break-words bg-ink px-3 py-2 font-mono text-[11.5px] leading-5 text-white">
          <span className="text-ink-4">$ </span>
          {detail.command}
          {detail.output ? `\n\n${detail.output}` : ""}
        </pre>
        {error}
      </>
    );
  if (detail.kind === "diff")
    return (
      <>
        <div className="border-b border-line px-3 py-1 font-mono text-[11px] text-ink-3">
          {detail.file}
        </div>
        <div className="font-mono text-[11.5px] leading-5">
          {detail.lines.map((line, index) => (
            <div
              key={index}
              className={cx(
                "whitespace-pre-wrap break-words px-3",
                line.kind === "add" && "bg-ok-50 text-ink",
                line.kind === "remove" && "bg-bad-50 text-ink-2",
                line.kind === "hunk" && "bg-canvas text-ink-4",
                line.kind === "context" && "text-ink-3",
              )}
            >
              <span className="mr-2 select-none text-ink-4">
                {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}
              </span>
              {line.text}
            </div>
          ))}
        </div>
        {error}
      </>
    );
  if (detail.kind === "content")
    return (
      <>
        <div className="border-b border-line px-3 py-1 font-mono text-[11px] text-ink-3">
          {detail.file}
        </div>
        <pre className="whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11.5px] leading-5 text-ink-2">
          {detail.content || t("tool_detail_none")}
        </pre>
        {error}
      </>
    );
  return (
    <>
      <section className="px-3 py-2">
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-4">
          {t("tool_input")}
        </div>
        <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-5 text-ink-2">
          {detail.input}
        </pre>
      </section>
      {detail.output && (
        <section className="border-t border-line px-3 py-2">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-4">
            {t("tool_output")}
          </div>
          <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-5 text-ink-2">
            {detail.output}
          </pre>
        </section>
      )}
      {error}
    </>
  );
}

/** Where a loop's role is: going on, or done. */
export function RoleStatus({ done, stopped }: { done: boolean; stopped: boolean }) {
  if (done) return <Check size={13} className="text-ok-600" />;
  if (stopped) return <span className="h-2 w-2 rounded-full bg-ink-4" />;
  return <Loader2 size={13} className="animate-spin text-brand-600" />;
}
