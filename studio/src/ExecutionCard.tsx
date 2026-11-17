import { MessageSquare, Play, Square } from "lucide-react";
import type { AuthoringStatus } from "../../src/tools/studio-types.js";
import { useLang, type TextKey } from "./i18n.js";
import { Badge, Button, cx } from "./ui.js";

const when = (value: string, lang: string): string => {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime())
    ? date.toLocaleString(lang === "zh" ? "zh-CN" : "en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";
};
const TONE = {
  running: "brand",
  waiting: "wait",
  idle: "gray",
  done: "ok",
  stopped: "outline",
  gone: "gray",
} as const;

/**
 * One execution, as the Executions page and the chat's status report show it:
 * its loop, how it stands, how far its latest run got, and what the owner can
 * do about it (stop it, resume it where it stopped, see it in the chat).
 */
export function ExecutionCard({
  status,
  busy,
  onStop,
  onResume,
  onOpen,
  compact = false,
}: {
  status: AuthoringStatus;
  busy: boolean;
  onStop: () => void;
  onResume: () => void;
  onOpen: () => void;
  /** Smaller, for the chat. */
  compact?: boolean;
}) {
  const { t, lang } = useLang();
  const steps = status.run?.steps ?? [];
  const done = steps.filter((step) => step.done).length;
  const current = [...steps].reverse().find((step) => !step.done) ?? steps.at(-1);
  return (
    <div
      className={cx(
        "border border-line bg-panel shadow-card",
        compact ? "rounded-xl px-3 py-2" : "rounded-2xl px-4 py-3",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[13px] font-semibold">{status.loop}</span>
        <Badge tone="outline">
          {t(status.purpose === "run" ? "exec_purpose_run" : "exec_purpose_authoring")}
        </Badge>
        <Badge tone={TONE[status.state]}>{t(`exec_state_${status.state}` as TextKey)}</Badge>
        <span className="text-xs text-ink-4">{when(status.started_at, lang)}</span>
        {status.run && !compact && (
          <span className="ml-auto font-mono text-[11px] text-ink-4">{status.run.id}</span>
        )}
      </div>
      {status.run ? (
        <div className="mt-2">
          <div className="h-1.5 overflow-hidden rounded-full bg-canvas">
            <div
              className="h-full rounded-full bg-brand-500"
              style={{ width: `${steps.length ? (done / steps.length) * 100 : 0}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-ink-3">
            {t("exec_steps", { done, n: steps.length })}
            {current && !status.run.ended && status.state === "running"
              ? ` · ${t("exec_current", { phase: current.phase || "—", role: current.role || "—" })}`
              : ""}
          </p>
        </div>
      ) : (
        <p className="mt-2 text-xs text-ink-4">{t("exec_no_run")}</p>
      )}
      {status.state === "waiting" && status.review?.question && (
        <p className="mt-1 text-xs text-wait-600">
          {t("exec_waiting_for", { question: status.review.question })}
        </p>
      )}
      {status.failure && <p className="mt-1 text-xs text-bad-600">{status.failure}</p>}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {status.state === "running" && (
          <Button size="sm" disabled={busy} onClick={onStop}>
            <Square size={12} /> {t("exec_stop")}
          </Button>
        )}
        {status.resumable && status.run && (
          <Button
            size="sm"
            variant="primary"
            title={t("exec_resume_hint")}
            disabled={busy}
            onClick={onResume}
          >
            <Play size={12} /> {t("exec_resume")}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onOpen}>
          <MessageSquare size={12} /> {t("exec_open")}
        </Button>
      </div>
    </div>
  );
}
