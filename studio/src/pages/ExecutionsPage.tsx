import { MessageSquare, Play, RefreshCw, Square } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { AuthoringStatus } from "../../../src/tools/studio-types.js";
import { api } from "../api.js";
import { useLang, type TextKey } from "../i18n.js";
import { Badge, Button } from "../ui.js";

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
/** How often the page asks again how the executions stand. */
const EVERY_MS = 3000;

/** Every loop the Studio runs in this project: how it stands, how far it got, and what the owner can do about it. */
export function ExecutionsPage({ onOpen }: { onOpen: (status: AuthoringStatus) => void }) {
  const { t, lang } = useLang();
  const [list, setList] = useState<AuthoringStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => {
    api
      .executions()
      .then((next) => {
        setList(next.executions);
        setError(null);
      })
      .catch((reason: Error) => setError(reason.message));
  }, []);
  useEffect(() => {
    load();
    const timer = setInterval(load, EVERY_MS);
    return () => clearInterval(timer);
  }, [load]);
  const act = async (id: string, work: () => Promise<string | null>) => {
    setBusy(id);
    setNotice(null);
    try {
      setNotice(await work());
      load();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="scroll-thin h-full overflow-y-auto px-8 py-6">
      <div className="mx-auto max-w-5xl">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold">{t("executions_title")}</h1>
            <p className="mt-1 text-[13px] text-ink-3">{t("executions_hint")}</p>
          </div>
          <Button size="sm" variant="ghost" onClick={load}>
            <RefreshCw size={13} /> {t("refresh")}
          </Button>
        </div>
        {error && (
          <p className="mt-3 rounded-lg bg-bad-50 px-3 py-2 text-[13px] text-bad-600">{error}</p>
        )}
        {notice && (
          <p className="mt-3 rounded-lg bg-ok-50 px-3 py-2 text-[13px] text-ok-600">{notice}</p>
        )}
        {list && list.length === 0 && (
          <p className="mt-6 text-sm text-ink-4">{t("executions_none")}</p>
        )}
        <div className="mt-4 space-y-3">
          {list?.map((status) => {
            const steps = status.run?.steps ?? [];
            const done = steps.filter((step) => step.done).length;
            const current = [...steps].reverse().find((step) => !step.done) ?? steps.at(-1);
            return (
              <div
                key={status.id}
                className="rounded-2xl border border-line bg-panel px-4 py-3 shadow-card"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[13px] font-semibold">{status.loop}</span>
                  <Badge tone="outline">
                    {t(status.purpose === "run" ? "exec_purpose_run" : "exec_purpose_authoring")}
                  </Badge>
                  <Badge tone={TONE[status.state]}>
                    {t(`exec_state_${status.state}` as TextKey)}
                  </Badge>
                  <span className="text-xs text-ink-4">{when(status.started_at, lang)}</span>
                  {status.run && (
                    <span className="ml-auto font-mono text-[11px] text-ink-4">
                      {status.run.id}
                    </span>
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
                {status.failure && <p className="mt-1 text-xs text-bad-600">{status.failure}</p>}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {status.state === "running" && (
                    <Button
                      size="sm"
                      disabled={busy === status.id}
                      onClick={() =>
                        void act(status.id, async () => {
                          await api.stop(status.id);
                          return null;
                        })
                      }
                    >
                      <Square size={12} /> {t("exec_stop")}
                    </Button>
                  )}
                  {status.resumable && status.run && (
                    <Button
                      size="sm"
                      variant="primary"
                      title={t("exec_resume_hint")}
                      disabled={busy === status.id}
                      onClick={() =>
                        void act(status.id, async () => {
                          const resumed = await api.resume(status.id);
                          return t("exec_resumed", { run: resumed.run });
                        })
                      }
                    >
                      <Play size={12} /> {t("exec_resume")}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => onOpen(status)}>
                    <MessageSquare size={12} /> {t("exec_open")}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
