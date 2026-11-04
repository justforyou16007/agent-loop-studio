import { PencilLine, Plus, Search, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Overview, RoleDetail } from "../../../src/tools/studio-types.js";
import { api } from "../api.js";
import { useLang } from "../i18n.js";
import { Markdown } from "../Markdown.js";
import { Badge, Button, cx, sourceKey } from "../ui.js";

export function RolesPage({
  overview,
  selected,
  onSelect,
  onOpenLoop,
  onEdit,
}: {
  overview: Overview;
  selected: string | null;
  onSelect: (name: string) => void;
  onOpenLoop: (name: string) => void;
  /** Change this role in the chat, or create one (null). */
  onEdit: (name: string | null, source?: string) => void;
}) {
  const { t } = useLang();
  const [needle, setNeedle] = useState("");
  const [role, setRole] = useState<RoleDetail | null>(null);
  // The project's own roles first, then the framework's as installed, then the library's.
  const shown = useMemo(
    () =>
      overview.roles
        .filter((entry) =>
          `${entry.name} ${entry.description}`.toLowerCase().includes(needle.trim().toLowerCase()),
        )
        .sort(
          (a, b) =>
            Number(a.framework) - Number(b.framework) ||
            Number(a.source === "library") - Number(b.source === "library"),
        ),
    [overview.roles, needle],
  );
  const current = selected ?? shown[0]?.name ?? null;
  useEffect(() => {
    setRole(null);
    if (current)
      api
        .role(current)
        .then(setRole)
        .catch(() => setRole(null));
  }, [current]);
  const names = useMemo(() => new Set(overview.roles.map((entry) => entry.name)), [overview.roles]);

  return (
    <div className="flex h-full min-h-0">
      <nav className="flex w-[320px] shrink-0 flex-col border-r border-line bg-panel">
        <div className="flex items-center gap-2 px-3 pt-3">
          <Button size="sm" variant="primary" className="w-full" onClick={() => onEdit(null)}>
            <Plus size={13} /> {t("role_new_button")}
          </Button>
        </div>
        <label className="m-3 flex items-center gap-2 rounded-lg border border-line bg-canvas px-2.5">
          <Search size={14} className="text-ink-4" />
          <input
            value={needle}
            onChange={(event) => setNeedle(event.target.value)}
            placeholder={t("roles_search")}
            className="h-8 flex-1 bg-transparent text-[13px] outline-none"
          />
        </label>
        <ul className="scroll-thin flex-1 space-y-1 overflow-y-auto px-2 pb-3">
          {shown.map((entry) => (
            <li key={entry.name}>
              <button
                type="button"
                onClick={() => onSelect(entry.name)}
                className={cx(
                  "w-full rounded-xl px-3 py-2 text-left",
                  current === entry.name ? "bg-brand-50" : "hover:bg-canvas",
                )}
              >
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-mono text-[12.5px] font-semibold">
                    {entry.name}
                  </span>
                  <Badge tone="outline">{t(sourceKey(entry))}</Badge>
                </div>
                <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-ink-3">
                  {entry.description}
                </p>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <main className="scroll-thin min-w-0 flex-1 overflow-y-auto px-8 py-6">
        {role ? (
          <article className="mx-auto max-w-3xl">
            <h1 className="flex flex-wrap items-center gap-2 font-mono text-lg font-semibold">
              {role.name}
              <Badge tone="outline">{t(sourceKey(role))}</Badge>
              <Badge>{role.side}</Badge>
            </h1>
            <p className="mt-1 text-[13px] leading-6 text-ink-3">{role.description}</p>
            <div className="mt-3">
              <Button size="sm" onClick={() => onEdit(role.name, role.source)}>
                <PencilLine size={13} /> {t("role_edit")}
              </Button>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-3">
              <Fact label={t("tools")} value={role.tools || t("all_tools")} />
              <Fact label={t("effort")} value={role.effort || "—"} />
              <div className="rounded-xl border border-line bg-panel px-3 py-2">
                <div className="text-[11px] text-ink-4">{t("used_by")}</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {role.used_by.length ? (
                    role.used_by.map((loop) => (
                      <button key={loop} type="button" onClick={() => onOpenLoop(loop)}>
                        <Badge tone="loop">
                          <Workflow size={11} /> {loop}
                        </Badge>
                      </button>
                    ))
                  ) : (
                    <span className="text-xs text-ink-4">{t("not_used")}</span>
                  )}
                </div>
              </div>
            </div>
            <div className="mt-5 rounded-2xl border border-line bg-panel px-5 py-3">
              <Markdown text={role.body} roles={names} onRole={onSelect} />
            </div>
          </article>
        ) : (
          <p className="text-sm text-ink-4">{t("loading")}</p>
        )}
      </main>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel px-3 py-2">
      <div className="text-[11px] text-ink-4">{label}</div>
      <div className="mt-0.5 truncate font-mono text-[12.5px] text-ink-2" title={value}>
        {value}
      </div>
    </div>
  );
}
