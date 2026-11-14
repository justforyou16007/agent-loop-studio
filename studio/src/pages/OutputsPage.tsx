import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { OutputList } from "../../../src/tools/studio-types.js";
import { api } from "../api.js";
import { useLang } from "../i18n.js";
import { Badge, Button } from "../ui.js";

/** A moment as the owner reads it, to the second. */
const when = (value: string, lang: string): string => {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime())
    ? date.toLocaleString(lang === "zh" ? "zh-CN" : "en-GB", {
        dateStyle: "medium",
        timeStyle: "medium",
      })
    : "—";
};
/** An output as it reads best: text as it is, anything else as indented JSON. */
const shown = (output: unknown): string =>
  typeof output === "string" ? output : JSON.stringify(output, null, 2);

/** What the project's roles and loops gave, newest first, at or before the moment the owner picks. */
export function OutputsPage() {
  const { t, lang } = useLang();
  // The picker's local time; empty means now.
  const [before, setBefore] = useState("");
  const [kind, setKind] = useState<"" | "role" | "loop">("");
  const [name, setName] = useState("");
  const [list, setList] = useState<OutputList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const load = useCallback(() => {
    api
      .outputs({
        before: before ? new Date(before).toISOString() : undefined,
        kind: kind || undefined,
        name: name || undefined,
      })
      .then((next) => {
        setList(next);
        setError(null);
      })
      .catch((reason: Error) => setError(reason.message));
  }, [before, kind, name]);
  useEffect(() => {
    load();
  }, [load]);
  const names =
    kind === "role"
      ? (list?.roles ?? [])
      : kind === "loop"
        ? (list?.loops ?? [])
        : [...(list?.roles ?? []), ...(list?.loops ?? [])];
  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const field = "h-8 rounded-lg border border-line-strong bg-panel px-2 text-[13px]";

  return (
    <div className="scroll-thin h-full overflow-y-auto px-8 py-6">
      <div className="mx-auto max-w-5xl">
        <h1 className="text-lg font-semibold">{t("outputs_title")}</h1>
        <p className="mt-1 text-[13px] text-ink-3">{t("outputs_hint")}</p>
        <div className="mt-4 flex flex-wrap items-end gap-2">
          <label className="text-xs text-ink-3">
            {t("outputs_before")}
            <input
              type="datetime-local"
              step={1}
              value={before}
              onChange={(event) => setBefore(event.target.value)}
              className={`mt-1 block ${field}`}
            />
          </label>
          <Button size="sm" disabled={!before} onClick={() => setBefore("")}>
            {t("outputs_now")}
          </Button>
          <select
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as "" | "role" | "loop");
              setName("");
            }}
            className={field}
          >
            <option value="">{t("outputs_kind_all")}</option>
            <option value="role">{t("outputs_kind_role")}</option>
            <option value="loop">{t("outputs_kind_loop")}</option>
          </select>
          <select value={name} onChange={(event) => setName(event.target.value)} className={field}>
            <option value="">{t("outputs_name_all")}</option>
            {names.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
          <Button size="sm" variant="ghost" onClick={load}>
            <RefreshCw size={13} /> {t("refresh")}
          </Button>
        </div>
        {error && (
          <p className="mt-3 rounded-lg bg-bad-50 px-3 py-2 text-[13px] text-bad-600">{error}</p>
        )}
        {list && list.items.length === 0 && (
          <p className="mt-6 text-sm text-ink-4">{t("outputs_none")}</p>
        )}
        <ul className="mt-4 space-y-2">
          {list?.items.map((item, index) => {
            const key = `${item.session}:${item.run ?? ""}:${item.kind}:${item.name}:${item.at}:${index}`;
            return (
              <li key={key} className="rounded-xl border border-line bg-panel shadow-card">
                <button
                  type="button"
                  onClick={() => toggle(key)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left"
                >
                  {open.has(key) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span className="w-48 shrink-0 font-mono text-[12px] text-ink-3">
                    {when(item.at, lang)}
                  </span>
                  <Badge tone={item.kind === "role" ? "brand" : "loop"}>
                    {t(item.kind === "role" ? "outputs_role" : "outputs_loop")}
                  </Badge>
                  <span className="font-mono text-[13px] font-semibold">{item.name}</span>
                  {item.step && <span className="truncate text-xs text-ink-3">{item.step}</span>}
                  {item.run && (
                    <span className="ml-auto shrink-0 font-mono text-[11px] text-ink-4">
                      {t("outputs_run", { run: item.run })}
                    </span>
                  )}
                </button>
                {open.has(key) && (
                  <pre className="scroll-thin max-h-[420px] overflow-auto border-t border-line bg-canvas px-3 py-2 font-mono text-[12px] leading-5 whitespace-pre-wrap">
                    {shown(item.output)}
                  </pre>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
