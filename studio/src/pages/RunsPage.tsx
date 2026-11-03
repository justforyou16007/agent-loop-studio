import { useEffect, useMemo, useState } from "react";
import type { LoopDetail, Overview } from "../../../src/tools/studio-types.js";
import { api } from "../api.js";
import { useLang } from "../i18n.js";
import { cx, LoopBadges, RoleChip } from "../ui.js";

const when = (value: string, lang: string): string => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(lang === "zh" ? "zh-CN" : "en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
      });
};

export function RunsPage({ overview }: { overview: Overview }) {
  const { t, lang } = useLang();
  const loops = useMemo(
    () => overview.loops.filter((loop) => loop.source === "project"),
    [overview.loops],
  );
  const [name, setName] = useState<string | null>(
    () => overview.project.chosen?.loop ?? loops[0]?.name ?? null,
  );
  const [detail, setDetail] = useState<LoopDetail | null>(null);
  useEffect(() => {
    setDetail(null);
    if (name)
      api
        .loop(name, "project")
        .then(setDetail)
        .catch(() => setDetail(null));
  }, [name]);

  return (
    <div className="flex h-full min-h-0">
      <nav className="scroll-thin w-[280px] shrink-0 space-y-1 overflow-y-auto border-r border-line bg-panel p-3">
        {loops.map((loop) => (
          <button
            key={loop.name}
            type="button"
            onClick={() => setName(loop.name)}
            className={cx(
              "w-full rounded-xl px-3 py-2 text-left",
              name === loop.name ? "bg-brand-50" : "hover:bg-canvas",
            )}
          >
            <div className="font-mono text-[12.5px] font-semibold">{loop.name}</div>
            <div className="mt-1">
              <LoopBadges loop={loop} compact />
            </div>
          </button>
        ))}
      </nav>
      <main className="scroll-thin min-w-0 flex-1 overflow-y-auto px-8 py-6">
        <h1 className="font-mono text-lg font-semibold">
          {name} · {t("runs_of")}
        </h1>
        {!detail ? (
          <p className="mt-4 text-sm text-ink-4">{t("loading")}</p>
        ) : detail.runs.length === 0 ? (
          <p className="mt-4 text-sm text-ink-4">{t("no_runs")}</p>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-2xl border border-line bg-panel">
            <table className="w-full text-[13px]">
              <thead className="bg-canvas text-left text-[11px] uppercase tracking-wide text-ink-4">
                <tr>
                  <th className="px-4 py-2 font-semibold">{t("run")}</th>
                  <th className="whitespace-nowrap px-4 py-2 font-semibold">{t("run_started")}</th>
                  <th className="whitespace-nowrap px-4 py-2 font-semibold">{t("run_ended")}</th>
                  <th className="px-4 py-2 font-semibold">{t("run_roles")}</th>
                  <th className="whitespace-nowrap px-4 py-2 font-semibold">
                    {t("run_submissions")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {detail.runs.map((run) => {
                  const times = new Map<string, number>();
                  for (const entry of run.roles)
                    times.set(entry.role, (times.get(entry.role) ?? 0) + 1);
                  return (
                    <tr key={run.id} className="border-t border-line align-top">
                      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs">{run.id}</td>
                      <td className="whitespace-nowrap px-4 py-2.5">{when(run.started, lang)}</td>
                      <td className="whitespace-nowrap px-4 py-2.5">{when(run.ended, lang)}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          {[...times].map(([role, count]) => (
                            <span key={role} className="inline-flex items-center gap-0.5">
                              <RoleChip name={role} />
                              {count > 1 && (
                                <span className="text-[11px] text-ink-4">×{count}</span>
                              )}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5">
                        {run.submissions.join(", ")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
