import { FileText, LayoutPanelLeft, Search, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Flow, LoopSource, Overview, RoleDetail } from "../../../src/tools/studio-types.js";
import { api } from "../api.js";
import { FlowCanvas } from "../canvas/FlowCanvas.js";
import { useLang } from "../i18n.js";
import { Markdown } from "../Markdown.js";
import { Badge, Button, cx, formatValue, LoopBadges, RoleChip, sourceKey } from "../ui.js";

/** What the browser shows: a loop (with where it comes from) or a role. */
export type BrowseTarget =
  | { kind: "loop"; name: string; source: LoopSource }
  | { kind: "role"; name: string };

/**
 * The project's loops and roles, to read: each loop's flow and sections, each
 * role's file, in the page's language. Nothing changes here; a loop or a role is
 * made or changed in the creation area's chat.
 */
export function BrowsePage({
  overview,
  target,
  onTarget,
  onOpenLoop,
  onDefinition,
}: {
  overview: Overview;
  target: BrowseTarget | null;
  onTarget: (target: BrowseTarget) => void;
  /** Put a loop on the creation area's canvas. */
  onOpenLoop: (loop: { name: string; source: LoopSource }) => void;
  /** The loop's definition as written, in English: what it runs by. */
  onDefinition: (loop: { name: string; source: LoopSource }) => void;
}) {
  const { t, lang } = useLang();
  const [tab, setTab] = useState<"loop" | "role">(target?.kind ?? "loop");
  const [needle, setNeedle] = useState("");
  useEffect(() => {
    if (target) setTab(target.kind);
  }, [target]);
  const matches = (text: string) => text.toLowerCase().includes(needle.trim().toLowerCase());
  // The project's own first, then the framework's as installed, then the library's.
  const order = (entry: { framework: boolean; source: string }) =>
    Number(entry.framework) + 2 * Number(entry.source === "library");
  const loops = useMemo(
    () =>
      overview.loops
        .filter((loop) => matches(`${loop.name} ${loop.description}`))
        .sort((a, b) => order(a) - order(b)),
    [overview.loops, needle],
  );
  const roles = useMemo(
    () =>
      overview.roles
        .filter((role) => matches(`${role.name} ${role.description}`))
        .sort((a, b) => order(a) - order(b)),
    [overview.roles, needle],
  );
  // With nothing chosen: the project's task loop, else the first loop.
  const shown: BrowseTarget | null =
    target ??
    (() => {
      const loop =
        overview.loops.find(
          (entry) => entry.name === overview.project.chosen?.loop && entry.source === "project",
        ) ?? loops[0];
      return loop ? { kind: "loop" as const, name: loop.name, source: loop.source } : null;
    })();

  return (
    <div className="flex h-full min-h-0">
      <nav className="flex w-[320px] shrink-0 flex-col border-r border-line bg-panel">
        <div className="mx-3 mt-3 grid grid-cols-2 gap-1 rounded-lg bg-canvas p-1">
          {(["loop", "role"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => setTab(kind)}
              className={cx(
                "h-7 rounded-md text-[12.5px] font-medium",
                tab === kind ? "bg-white text-ink shadow-card" : "text-ink-3 hover:text-ink-2",
              )}
            >
              {t(kind === "loop" ? "browse_loops" : "browse_roles", {
                n: kind === "loop" ? loops.length : roles.length,
              })}
            </button>
          ))}
        </div>
        <label className="m-3 flex items-center gap-2 rounded-lg border border-line bg-canvas px-2.5">
          <Search size={14} className="text-ink-4" />
          <input
            value={needle}
            onChange={(event) => setNeedle(event.target.value)}
            placeholder={t("browse_search")}
            className="h-8 flex-1 bg-transparent text-[13px] outline-none"
          />
        </label>
        <ul className="scroll-thin flex-1 space-y-1 overflow-y-auto px-2 pb-3">
          {(tab === "loop" ? loops : roles).map((entry) => {
            const on =
              shown?.kind === tab &&
              shown.name === entry.name &&
              (shown.kind === "role" || shown.source === entry.source);
            return (
              <li key={`${entry.source}:${entry.name}`}>
                <button
                  type="button"
                  onClick={() =>
                    onTarget(
                      tab === "loop"
                        ? { kind: "loop", name: entry.name, source: entry.source }
                        : { kind: "role", name: entry.name },
                    )
                  }
                  className={cx(
                    "w-full rounded-xl px-3 py-2 text-left",
                    on ? "bg-brand-50" : "hover:bg-canvas",
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
            );
          })}
        </ul>
        <p className="border-t border-line px-3 py-2 text-[11.5px] leading-5 text-ink-4">
          {t("browse_view_only")}
        </p>
      </nav>
      <main className="scroll-thin min-w-0 flex-1 overflow-y-auto px-8 py-6">
        {shown?.kind === "loop" && (
          <LoopView
            key={`${shown.source}:${shown.name}:${lang}`}
            loop={shown}
            onRole={(name) => onTarget({ kind: "role", name })}
            onOpenLoop={onOpenLoop}
            onDefinition={onDefinition}
          />
        )}
        {shown?.kind === "role" && (
          <RoleView
            key={`${shown.name}:${lang}`}
            name={shown.name}
            onLoop={(name) => {
              const loop =
                overview.loops.find((entry) => entry.name === name && entry.source === "project") ??
                overview.loops.find((entry) => entry.name === name);
              if (loop) onTarget({ kind: "loop", name: loop.name, source: loop.source });
            }}
            roles={new Set(overview.roles.map((entry) => entry.name))}
            onRole={(name) => onTarget({ kind: "role", name })}
          />
        )}
        {!shown && <p className="text-sm text-ink-4">{t("browse_empty")}</p>}
      </main>
    </div>
  );
}

const Heading = ({ children }: { children: string }) => (
  <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-4">
    {children}
  </h3>
);

/** A loop to read: what it is for, its flow as a drawing, its parameters, roles and other sections. */
function LoopView({
  loop,
  onRole,
  onOpenLoop,
  onDefinition,
}: {
  loop: { name: string; source: LoopSource };
  onRole: (name: string) => void;
  onOpenLoop: (loop: { name: string; source: LoopSource }) => void;
  onDefinition: (loop: { name: string; source: LoopSource }) => void;
}) {
  const { t } = useLang();
  const [flow, setFlow] = useState<Flow | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .flow(loop.name, loop.source)
      .then(setFlow)
      .catch((reason: Error) => setError(reason.message));
  }, [loop.name, loop.source]);
  if (error) return <p className="text-sm text-bad-600">{t("load_failed") + error}</p>;
  if (!flow) return <p className="text-sm text-ink-4">{t("loading")}</p>;
  return (
    <article className="mx-auto max-w-5xl space-y-5">
      <header>
        <h1 className="flex flex-wrap items-center gap-2 font-mono text-lg font-semibold">
          {flow.loop.name}
          <LoopBadges loop={flow.loop} />
        </h1>
        <p className="mt-1 text-[13px] leading-6 text-ink-3">{flow.loop.description}</p>
        <div className="mt-3 flex gap-2">
          <Button size="sm" variant="primary" onClick={() => onOpenLoop(loop)}>
            <LayoutPanelLeft size={13} /> {t("browse_open_create")}
          </Button>
          <Button size="sm" onClick={() => onDefinition(loop)}>
            <FileText size={13} /> {t("definition")}
          </Button>
        </div>
      </header>
      <div className="relative h-[440px] overflow-hidden rounded-2xl border border-line bg-canvas">
        <FlowCanvas flow={flow} preview />
      </div>
      <section>
        <Heading>{t("purpose")}</Heading>
        <Markdown text={flow.purpose} />
      </section>
      <section>
        <Heading>{t("roles")}</Heading>
        <div className="flex flex-wrap gap-1">
          {flow.roles.map((role) => (
            <RoleChip key={role.name} name={role.name} onClick={() => onRole(role.name)} />
          ))}
        </div>
      </section>
      {flow.params.length > 0 && (
        <section>
          <Heading>{t("params")}</Heading>
          <ul className="space-y-2">
            {flow.params.map((param) => (
              <li key={param.name} className="text-[13px]">
                <div className="flex items-baseline gap-2">
                  <code className="font-mono font-semibold text-ink-2">{param.name}</code>
                  <span className="text-xs text-ink-4">
                    {t("param_default")} {formatValue(param.default)}
                    {param.value !== undefined &&
                      ` · ${t("param_value")} ${formatValue(param.value)}`}
                  </span>
                </div>
                <p className="leading-6 text-ink-3">{param.description}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {flow.sections.map((section) => (
        <section key={section.title}>
          <Heading>{section.title}</Heading>
          <Markdown text={section.markdown} />
        </section>
      ))}
    </article>
  );
}

/** A role to read: what it is, which loops use it, and its file, section by section. */
function RoleView({
  name,
  onLoop,
  roles,
  onRole,
}: {
  name: string;
  onLoop: (name: string) => void;
  roles: Set<string>;
  onRole: (name: string) => void;
}) {
  const { t } = useLang();
  const [role, setRole] = useState<RoleDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .role(name)
      .then(setRole)
      .catch((reason: Error) => setError(reason.message));
  }, [name]);
  if (error) return <p className="text-sm text-bad-600">{t("load_failed") + error}</p>;
  if (!role) return <p className="text-sm text-ink-4">{t("loading")}</p>;
  return (
    <article className="mx-auto max-w-3xl">
      <h1 className="flex flex-wrap items-center gap-2 font-mono text-lg font-semibold">
        {role.name}
        <Badge tone="outline">{t(sourceKey(role))}</Badge>
        <Badge>{role.side}</Badge>
      </h1>
      <p className="mt-1 text-[13px] leading-6 text-ink-3">{role.description}</p>
      <div className="mt-4 grid grid-cols-3 gap-3">
        <Fact label={t("tools")} value={role.tools || t("all_tools")} />
        <Fact label={t("effort")} value={role.effort || "—"} />
        <div className="rounded-xl border border-line bg-panel px-3 py-2">
          <div className="text-[11px] text-ink-4">{t("used_by")}</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {role.used_by.length ? (
              role.used_by.map((loop) => (
                <button key={loop} type="button" onClick={() => onLoop(loop)}>
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
        <Markdown text={role.body} roles={roles} onRole={onRole} />
      </div>
    </article>
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
