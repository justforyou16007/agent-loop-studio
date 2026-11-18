import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Loader2,
  MessageSquare,
  Play,
  RefreshCw,
  Square,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { LoopRun, OutputList, RunStep } from "../../../src/tools/studio-types.js";
import { api } from "../api.js";
import { useLang, type TextKey } from "../i18n.js";
import { Badge, Button, cx, RoleChip } from "../ui.js";

/** A moment as the owner reads it. */
const when = (value: string | null, lang: string, seconds = false): string => {
  const date = new Date(value ?? "");
  return value && !Number.isNaN(date.getTime())
    ? date.toLocaleString(lang === "zh" ? "zh-CN" : "en-GB", {
        dateStyle: "short",
        timeStyle: seconds ? "medium" : "short",
      })
    : "—";
};
/** How long something took, or has taken so far. */
const took = (from: string, to: string | null): string => {
  const start = Date.parse(from);
  const end = to ? Date.parse(to) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "";
  const seconds = Math.round((end - start) / 1000);
  return seconds < 60
    ? `${seconds}s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m${seconds % 60 ? ` ${seconds % 60}s` : ""}`
      : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
};
/** An output as it reads best: text as it is, anything else as indented JSON. */
const shown = (output: unknown): string =>
  typeof output === "string" ? output : JSON.stringify(output, null, 2);
const TONE = {
  running: "brand",
  waiting: "wait",
  done: "ok",
  stopped: "gray",
  failed: "bad",
} as const;

/**
 * The side of the creation area: the loop on the canvas as it runs, every run
 * newest first, each open to what each of its roles did and gave and what the
 * loop returned, with its controls; and what the loop's runs gave, at or before
 * a moment. The canvas shows the run picked here, step by step.
 */
export function RunPanel({
  loop,
  following,
  titleOf,
  onShown,
  onOpenConversation,
  onStop,
  onResume,
  onRun,
}: {
  /** The project's loop on the canvas. */
  loop: string;
  /** How the conversation the chat follows stands: a change reads the runs again. */
  following: string;
  /** A phase as the canvas names its step, in the page's language. */
  titleOf: (phase: string) => string;
  /** The run the canvas shows, as it goes; null for none. */
  onShown: (run: LoopRun | null) => void;
  onOpenConversation: (conversation: string) => void;
  onStop: (conversation: string) => void;
  onResume: (conversation: string) => void;
  /** Run the loop (the owner confirms first). */
  onRun: () => void;
}) {
  const { t } = useLang();
  const [tab, setTab] = useState<"runs" | "outputs">("runs");
  const [runs, setRuns] = useState<LoopRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const load = useCallback(
    () =>
      api
        .runs(loop)
        .then((next) => {
          setRuns(next.runs);
          setError(null);
        })
        .catch((reason: Error) => setError(reason.message)),
    [loop],
  );
  // Another loop: its runs, none picked until they are read.
  useEffect(() => {
    setRuns(null);
    setPicked(null);
    void load();
  }, [load]);
  // Read again when the followed conversation changes, and every few seconds while a run works.
  useEffect(() => {
    void load();
  }, [following, load]);
  const working = Boolean(runs?.some((run) => run.state === "running")) || following === "running";
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [working, load]);
  // The canvas shows the run picked, else the newest one that works or waits.
  const shownRun =
    runs?.find((run) => run.id === picked) ??
    (picked === null
      ? runs?.find((run) => run.state === "running" || run.state === "waiting")
      : undefined) ??
    null;
  useEffect(() => onShown(shownRun), [shownRun, onShown]);

  return (
    <aside className="flex h-full w-[380px] shrink-0 flex-col border-l border-line bg-panel">
      <div className="flex items-center gap-1 border-b border-line px-3 pt-2">
        {(["runs", "outputs"] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cx(
              "-mb-px border-b-2 px-2.5 pb-2 text-[13px] font-medium",
              tab === key
                ? "border-brand-600 text-brand-700"
                : "border-transparent text-ink-3 hover:text-ink-2",
            )}
          >
            {t(key === "runs" ? "panel_runs" : "panel_outputs")}
            {key === "runs" && runs && runs.length > 0 && (
              <span className="ml-1 text-[11px] text-ink-4">{runs.length}</span>
            )}
          </button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          className="mb-1.5 ml-auto"
          title={t("refresh")}
          onClick={() => void load()}
        >
          <RefreshCw size={13} />
        </Button>
      </div>
      {tab === "runs" ? (
        <div className="scroll-thin min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
          {error && (
            <p className="rounded-lg bg-bad-50 px-3 py-2 text-xs text-bad-600">
              {t("load_failed") + error}
            </p>
          )}
          {runs && runs.length === 0 && (
            <div className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-xs leading-5 text-ink-4">
              <p>{t("runs_none_here")}</p>
              <Button size="sm" variant="primary" className="mt-2" onClick={onRun}>
                <Play size={12} /> {t("run_button")}
              </Button>
            </div>
          )}
          {!runs && !error && <p className="text-xs text-ink-4">{t("loading")}</p>}
          {runs?.map((run) => (
            <RunCard
              key={run.id}
              run={run}
              open={shownRun?.id === run.id}
              onToggle={() => setPicked(shownRun?.id === run.id ? "" : run.id)}
              titleOf={titleOf}
              onOpenConversation={onOpenConversation}
              onStop={onStop}
              onResume={onResume}
            />
          ))}
        </div>
      ) : (
        <OutputsTab loop={loop} />
      )}
    </aside>
  );
}

/** One run: how it stands at a glance, and, open, each of its roles and what the loop returned. */
function RunCard({
  run,
  open,
  onToggle,
  titleOf,
  onOpenConversation,
  onStop,
  onResume,
}: {
  run: LoopRun;
  open: boolean;
  onToggle: () => void;
  titleOf: (phase: string) => string;
  onOpenConversation: (conversation: string) => void;
  onStop: (conversation: string) => void;
  onResume: (conversation: string) => void;
}) {
  const { t, lang } = useLang();
  const [step, setStep] = useState<string | null>(null);
  const done = run.steps.filter((entry) => entry.state === "done").length;
  const waiting =
    run.state === "waiting" && run.result && typeof run.result === "object"
      ? String((run.result as { question?: unknown }).question ?? "")
      : "";
  return (
    <div
      className={cx(
        "rounded-xl border bg-white shadow-card",
        open ? "border-brand-500/50" : "border-line",
      )}
    >
      <button type="button" onClick={onToggle} className="w-full px-3 py-2 text-left">
        <div className="flex items-center gap-1.5">
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <Badge tone={TONE[run.state]}>{t(`run_state_${run.state}` as TextKey)}</Badge>
          <span className="text-xs text-ink-3">{when(run.started_at, lang)}</span>
          <span className="ml-auto text-[11px] text-ink-4">
            {took(run.started_at, run.state === "running" ? null : (run.ended_at ?? null))}
          </span>
        </div>
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-canvas">
          <div
            className={cx(
              "h-full rounded-full",
              run.state === "failed" ? "bg-bad-600" : "bg-brand-500",
            )}
            style={{ width: `${run.steps.length ? (done / run.steps.length) * 100 : 0}%` }}
          />
        </div>
        <p className="mt-1 text-[11px] text-ink-4">
          {t("exec_steps", { done, n: run.steps.length })} ·{" "}
          <span className="font-mono">{run.id}</span>
        </p>
      </button>
      {open && (
        <div className="border-t border-line px-3 py-2">
          <div className="mb-2 flex flex-wrap gap-1.5">
            {run.conversation && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onOpenConversation(run.conversation!)}
              >
                <MessageSquare size={12} /> {t("exec_open")}
              </Button>
            )}
            {run.conversation && run.state === "running" && (
              <Button size="sm" onClick={() => onStop(run.conversation!)}>
                <Square size={12} /> {t("exec_stop")}
              </Button>
            )}
            {run.conversation && run.state === "stopped" && (
              <Button
                size="sm"
                variant="primary"
                title={t("exec_resume_hint")}
                onClick={() => onResume(run.conversation!)}
              >
                <Play size={12} /> {t("exec_resume")}
              </Button>
            )}
          </div>
          <ol className="space-y-1">
            {run.steps.map((entry) => (
              <StepRow
                key={entry.key}
                step={entry}
                title={titleOf(entry.phase)}
                open={step === entry.key}
                onToggle={() => setStep(step === entry.key ? null : entry.key)}
              />
            ))}
            {run.steps.length === 0 && <li className="text-xs text-ink-4">{t("run_no_steps")}</li>}
          </ol>
          {run.state === "waiting" && (
            <div className="mt-2 rounded-lg bg-wait-50 px-2.5 py-2 text-xs leading-5 text-wait-600">
              <p>{t("exec_waiting_for", { question: waiting || "—" })}</p>
              {run.conversation && (
                <Button
                  size="sm"
                  variant="primary"
                  className="mt-1.5"
                  onClick={() => onOpenConversation(run.conversation!)}
                >
                  <MessageSquare size={12} /> {t("run_answer")}
                </Button>
              )}
            </div>
          )}
          {run.state !== "waiting" && run.result !== null && (
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer font-medium text-ink-2">{t("run_result")}</summary>
              <pre className="scroll-thin mt-1 max-h-[280px] overflow-auto rounded-lg bg-canvas px-2.5 py-2 font-mono text-[11.5px] leading-5 whitespace-pre-wrap">
                {shown(run.result)}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

/** One role of a run: its step, how it stands, how long it took; open, what it gave. */
function StepRow({
  step,
  title,
  open,
  onToggle,
}: {
  step: RunStep;
  title: string;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useLang();
  const Icon = step.state === "done" ? CheckCircle2 : step.state === "running" ? Loader2 : XCircle;
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        disabled={step.state !== "done"}
        className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left hover:bg-canvas disabled:cursor-default disabled:hover:bg-transparent"
      >
        <Icon
          size={13}
          className={cx(
            "shrink-0",
            step.state === "done" && "text-ok-600",
            step.state === "running" && "animate-spin text-brand-600",
            step.state === "stopped" && "text-ink-4",
          )}
        />
        <span className="truncate text-[12.5px] font-medium text-ink-2">
          {title || step.phase || "—"}
        </span>
        {step.role && <RoleChip name={step.role} />}
        <span className="ml-auto shrink-0 text-[11px] text-ink-4">
          {step.state === "stopped" ? t("run_step_stopped") : took(step.started_at, step.ended_at)}
        </span>
      </button>
      {open && (
        <pre className="scroll-thin ml-5 max-h-[280px] overflow-auto rounded-lg bg-canvas px-2.5 py-2 font-mono text-[11.5px] leading-5 whitespace-pre-wrap">
          {shown(step.output)}
        </pre>
      )}
    </li>
  );
}

/** What the loop's runs gave, newest first, at or before the moment the owner picks. */
function OutputsTab({ loop }: { loop: string }) {
  const { t, lang } = useLang();
  // The picker's local time; empty means now.
  const [before, setBefore] = useState("");
  const [kind, setKind] = useState<"" | "role" | "loop">("");
  const [list, setList] = useState<OutputList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => {
    api
      .outputs({
        loop,
        before: before ? new Date(before).toISOString() : undefined,
        kind: kind || undefined,
      })
      .then((next) => {
        setList(next);
        setError(null);
      })
      .catch((reason: Error) => setError(reason.message));
  }, [loop, before, kind]);
  useEffect(() => {
    load();
  }, [load]);
  const field = "h-7 rounded-lg border border-line-strong bg-white px-1.5 text-xs";
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 py-3">
      <div className="flex flex-wrap items-end gap-1.5">
        <label className="text-[11px] text-ink-4">
          {t("outputs_before")}
          <input
            type="datetime-local"
            step={1}
            value={before}
            onChange={(event) => setBefore(event.target.value)}
            className={`mt-0.5 block ${field}`}
          />
        </label>
        <Button size="sm" disabled={!before} onClick={() => setBefore("")}>
          {t("outputs_now")}
        </Button>
        <select
          value={kind}
          onChange={(event) => setKind(event.target.value as "" | "role" | "loop")}
          className={field}
        >
          <option value="">{t("outputs_kind_all")}</option>
          <option value="role">{t("outputs_kind_role")}</option>
          <option value="loop">{t("outputs_kind_loop")}</option>
        </select>
      </div>
      {error && <p className="mt-2 rounded-lg bg-bad-50 px-3 py-2 text-xs text-bad-600">{error}</p>}
      {list && list.items.length === 0 && (
        <p className="mt-4 text-xs text-ink-4">{t("outputs_none")}</p>
      )}
      <ul className="mt-3 space-y-1.5">
        {list?.items.map((item, index) => {
          const key = `${item.session}:${item.run ?? ""}:${item.kind}:${item.name}:${item.at}:${index}`;
          return (
            <li key={key} className="rounded-lg border border-line bg-white">
              <button
                type="button"
                onClick={() => setOpen(open === key ? null : key)}
                className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
              >
                {open === key ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <Badge tone={item.kind === "role" ? "brand" : "loop"}>
                  {item.kind === "role" ? <CircleDot size={10} /> : null}
                  {item.kind === "role" ? item.name : t("outputs_loop")}
                </Badge>
                {item.step && (
                  <span className="truncate text-[11.5px] text-ink-3">{item.step}</span>
                )}
                <span className="ml-auto shrink-0 font-mono text-[10.5px] text-ink-4">
                  {when(item.at, lang, true)}
                </span>
              </button>
              {open === key && (
                <pre className="scroll-thin max-h-[320px] overflow-auto border-t border-line bg-canvas px-2.5 py-2 font-mono text-[11.5px] leading-5 whitespace-pre-wrap">
                  {shown(item.output)}
                </pre>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
