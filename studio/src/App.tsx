import {
  CheckCircle2,
  Eye,
  FileText,
  History,
  Languages,
  LayoutPanelLeft,
  FlaskConical,
  Play,
  RefreshCw,
  SlidersHorizontal,
  Users,
  FolderKanban,
  Workflow,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AuthoringStatus, Flow, Overview } from "../../src/tools/studio-types.js";
import { api } from "./api.js";
import { Inspector } from "./canvas/Inspector.js";
import { FlowCanvas } from "./canvas/FlowCanvas.js";
import { ChatPanel } from "./chat/ChatPanel.js";
import { LangContext, translate, useLang, type Lang, type TextKey } from "./i18n.js";
import { ParamsDialog, RoleDraftDialog, RunDialog } from "./dialogs.js";
import { DefinitionDialog, PreviewDialog, type LoopRef } from "./PreviewDialog.js";
import { RolesPage } from "./pages/RolesPage.js";
import { ProjectsPage } from "./pages/ProjectsPage.js";
import { RunsPage } from "./pages/RunsPage.js";
import type { ChatMessage, Reference } from "./types.js";
import { Button, cx, LoopBadges } from "./ui.js";

type Page = "projects" | "compose" | "roles" | "runs";
const LANG_KEY = "contrejour-studio-lang";

function storedLang(): Lang | null {
  try {
    const value = localStorage.getItem(LANG_KEY);
    return value === "zh" || value === "en" ? value : null;
  } catch {
    return null;
  }
}

export function App() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lang, setLang] = useState<Lang>(() => storedLang() ?? "zh");
  const [page, setPage] = useState<Page>("compose");
  const [flow, setFlow] = useState<Flow | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [references, setReferences] = useState<Reference[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<LoopRef | null>(null);
  const [definition, setDefinition] = useState<LoopRef | null>(null);
  const [busy, setBusy] = useState(false);
  const [role, setRole] = useState<string | null>(null);
  /** With a loop on the canvas, a message changes it; otherwise, or when asked, it finds loops. */
  const [mode, setMode] = useState<"change" | "find">("change");
  const [conversation, setConversation] = useState<string | null>(null);
  const [status, setStatus] = useState<AuthoringStatus | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  /** A role the chat changes, or a new one (name null), instead of the loop on the canvas. */
  const [roleTarget, setRoleTarget] = useState<{ name: string | null; source: string } | null>(
    null,
  );
  const [paramsOpen, setParamsOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [roleDraft, setRoleDraft] = useState<
    { name: string; text: string; original: string | null }[] | null
  >(null);
  const pendingMessage = useRef<number | null>(null);
  const handled = useRef("");
  const nextId = useRef(1);
  const t = useCallback(
    (key: TextKey, values?: Record<string, string | number>) => translate(lang, key, values),
    [lang],
  );
  const say = useCallback((message: Omit<ChatMessage, "id">): number => {
    const id = nextId.current++;
    setMessages((current) => [...current, { ...message, id }]);
    return id;
  }, []);
  const replace = useCallback((id: number, message: Omit<ChatMessage, "id">) => {
    setMessages((current) =>
      current.map((entry) => (entry.id === id ? { ...message, id } : entry)),
    );
  }, []);

  const open = useCallback(
    async (target: LoopRef, quiet = false) => {
      const next = await api.flow(target.name, target.source);
      setFlow(next);
      setSelected(null);
      setReferences([]);
      setPreview(null);
      setPage("compose");
      if (!quiet) say({ from: "studio", key: "opened", values: { loop: target.name } });
    },
    [say],
  );

  const load = useCallback(async () => {
    try {
      const data = await api.overview();
      setOverview(data);
      setError(null);
      return data;
    } catch (reason) {
      // No project is open in this workspace yet: the owner opens or starts one.
      if ((reason as { status?: number }).status === 409) {
        setOverview(null);
        setPage("projects");
        setError(null);
      } else setError((reason as Error).message);
      return null;
    }
  }, []);

  const begin = useCallback(() => {
    void load().then((data) => {
      if (!data) return;
      if (!storedLang()) setLang(data.project.language);
      say({ from: "studio", key: "welcome" });
      // A change still going on in the background is picked up where it is.
      void api
        .conversations()
        .then(({ conversations }) => {
          const open = conversations.find((entry) => ["running", "waiting"].includes(entry.state));
          if (!open) return;
          setConversation(open.id);
          if (open.state === "running")
            pendingMessage.current = say({
              from: "studio",
              key: "authoring_resumed",
              values: { session: open.session },
              pending: true,
              progress: open.progress,
            });
          setStatus(open);
        })
        .catch(() => undefined);
      // A project not set up yet opens with its setup loop, which the framework gives every project.
      const setup = data.loops.find((loop) => loop.kind === "setup" && loop.source === "project");
      if (!data.project.setup_finished && setup) {
        say({ from: "studio", key: "welcome_setup" });
        void open({ name: setup.name, source: "project" }, true);
        return;
      }
      const chosen = data.project.chosen?.loop;
      if (chosen && data.loops.some((loop) => loop.name === chosen && loop.source === "project")) {
        say({ from: "studio", key: "welcome_chosen", values: { loop: chosen } });
        void open({ name: chosen, source: "project" }, true);
      }
    });
  }, [load, say, open]);
  useEffect(() => {
    begin();
    // Runs once, when the page opens.
  }, []);
  /** Another project was opened, started or copied: everything on the page was the last one's. */
  const switched = () => {
    setFlow(null);
    setMessages([]);
    setReferences([]);
    setSelected(null);
    setConversation(null);
    setStatus(null);
    setRoleTarget(null);
    pendingMessage.current = null;
    handled.current = "";
    setPage("compose");
    begin();
  };

  const find = async (text: string) => {
    setBusy(true);
    const waiting = say({ from: "studio", key: "searching", pending: true });
    try {
      const result = await api.search(text);
      // Only the ones nearly as close as the closest: a weak match is noise beside a strong one.
      const best = result.candidates[0]?.score ?? 0;
      const close = result.candidates
        .filter((candidate) => candidate.score > 0 && candidate.score >= best * 0.4)
        .slice(0, 4);
      const shown = close.length ? close : result.candidates.slice(0, 8);
      replace(waiting, {
        from: "studio",
        key: close.length ? "found" : "found_none",
        values: { n: shown.length },
        candidates: shown,
      });
      const top = close[0];
      if (top) {
        await open({ name: top.name, source: top.source }, true);
        setMode("change");
      }
    } catch (reason) {
      replace(waiting, { from: "studio", text: t("load_failed") + (reason as Error).message });
    } finally {
      setBusy(false);
    }
  };

  /** A change to the loop on the canvas goes to loop-authoring; a reply goes to the loop that waits for it. */
  const change = async (text: string, pointed: Reference[]) => {
    setBusy(true);
    try {
      if (conversation && status?.state === "waiting") {
        await api.answer(conversation, text, pointed);
        pendingMessage.current = say({ from: "studio", key: "authoring_running", pending: true });
        setStatus({ ...status, state: "running", review: null });
      } else if (roleTarget) {
        const started = await api.startAuthoring({
          loop: "role-authoring",
          base: roleTarget.name
            ? { name: roleTarget.name, source: roleTarget.source as LoopRef["source"] }
            : null,
          text,
          references: [],
        });
        setConversation(started.id);
        setStatus(null);
        handled.current = "";
        pendingMessage.current = say({
          from: "studio",
          key: roleTarget.name ? "role_started" : "role_new_started",
          values: { role: roleTarget.name ?? "", session: started.session },
          pending: true,
        });
      } else {
        const started = await api.startAuthoring({
          loop: "loop-authoring",
          base: flow ? { name: flow.loop.name, source: flow.loop.source } : null,
          text,
          references: pointed,
        });
        setConversation(started.id);
        setStatus(null);
        handled.current = "";
        pendingMessage.current = say({
          from: "studio",
          key: flow ? "authoring_started" : "authoring_new",
          values: { loop: flow?.loop.name ?? "", session: started.session },
          pending: true,
        });
      }
    } catch (reason) {
      say({ from: "studio", text: t("failed_start") + (reason as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const send = async (text: string) => {
    const pointed = references;
    say({ from: "owner", text, references: pointed });
    setReferences([]);
    const canChange = Boolean(flow || roleTarget) || status?.state === "waiting";
    if (canChange && (mode === "change" || pointed.length)) await change(text, pointed);
    else if (text) await find(text);
  };

  // Follow the conversation: often while its loop works, now and then while it waits.
  useEffect(() => {
    if (!conversation) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const found = (await api.conversations()).conversations.find(
          (entry) => entry.id === conversation,
        );
        if (!stopped && found) setStatus(found);
        const settled = found && ["done", "gone"].includes(found.state);
        if (!stopped && !settled)
          timer = setTimeout(() => void poll(), found?.state === "running" ? 2500 : 8000);
      } catch {
        if (!stopped) timer = setTimeout(() => void poll(), 8000);
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [conversation, status?.state === "running"]);

  // While the loop works, its message lists the roles it has started.
  useEffect(() => {
    if (status?.state !== "running" || pendingMessage.current === null) return;
    const id = pendingMessage.current;
    setMessages((current) =>
      current.map((entry) => (entry.id === id ? { ...entry, progress: status.progress } : entry)),
    );
  }, [status]);

  // Tell the owner, once, when the conversation stops for them or ends.
  useEffect(() => {
    if (!status || status.state === "running") return;
    const key = `${status.id}:${status.state}:${status.review?.review_id ?? ""}:${status.reply_failed}`;
    if (handled.current === key) return;
    handled.current = key;
    const message: Omit<ChatMessage, "id"> =
      status.state === "waiting" && status.reply_failed
        ? {
            from: "studio",
            key: "reply_blocked",
            markdown: status.last_words,
            actions: true,
          }
        : status.state === "waiting"
          ? {
              from: "studio",
              key: status.draft
                ? status.draft.roles.length
                  ? "waiting_draft"
                  : "waiting_draft_plain"
                : "waiting",
              values: { roles: status.draft?.roles.join(", ") ?? "" },
              files: status.draft?.flow ? undefined : status.draft?.files,
              markdown: `${status.note}\n\n**${status.review?.question ?? ""}**`,
              actions: true,
            }
          : status.state === "done"
            ? ended(status.result)
            : status.state === "gone"
              ? { from: "studio", key: "authoring_gone", values: { session: status.session } }
              : {
                  from: "studio",
                  key: "authoring_idle",
                  values: { session: status.session },
                  markdown: status.note,
                };
    if (pendingMessage.current !== null) replace(pendingMessage.current, message);
    else say(message);
    pendingMessage.current = null;
    setShowOriginal(false);
    if (status.state === "done") {
      void load().then(() => {
        if (status.base)
          void open({ name: status.base.name, source: "project" }, true).catch(() => undefined);
      });
      setConversation(null);
    }
  }, [status, replace, say, load, open]);

  /** The owner makes the loop on the canvas the project's task loop, with these values. */
  const useThis = async (params: Record<string, unknown>) => {
    if (!flow) return;
    const used = await api.use(flow.loop.name, params);
    setParamsOpen(false);
    await load();
    await open({ name: used.loop, source: "project" }, true);
    say({ from: "studio", key: "use_done", values: { loop: used.loop } });
    if (used.added.length)
      say({ from: "studio", key: "use_added", values: { files: used.added.join(", ") } });
  };
  const runIt = async () => {
    if (!flow) return;
    try {
      const started = await api.run(flow.loop.name);
      setConversation(started.id);
      setStatus(null);
      handled.current = "";
      pendingMessage.current = say({
        from: "studio",
        key: "run_launched",
        values: { loop: flow.loop.name, session: started.session },
        pending: true,
      });
    } catch (reason) {
      say({ from: "studio", text: t("failed_start") + (reason as Error).message });
    }
  };
  /** The loop on the canvas, tried the way it will run: loop-trial asks in the chat whether it serves the goal. */
  const tryIt = async () => {
    if (!flow) return;
    try {
      const started = await api.trial(flow.loop.name, "");
      setConversation(started.id);
      setStatus(null);
      handled.current = "";
      pendingMessage.current = say({
        from: "studio",
        key: "trial_launched",
        values: { loop: flow.loop.name, session: started.session },
        pending: true,
      });
    } catch (reason) {
      say({ from: "studio", text: t("failed_start") + (reason as Error).message });
    }
  };
  const editRole = (name: string | null, source = "project") => {
    setRoleTarget({ name, source });
    setPage("compose");
    setMode("change");
    say({
      from: "studio",
      key: name ? "role_target" : "role_target_new",
      values: { role: name ?? "" },
    });
  };

  const point = (reference: Reference) => {
    setReferences((current) =>
      current.some((entry) => entry.id === reference.id) ? current : [...current, reference],
    );
  };
  const showRole = (name: string) => {
    setRole(name);
    setPage("roles");
  };
  const referencedIds = useMemo(() => new Set(references.map((entry) => entry.id)), [references]);
  const current: LoopRef | null = flow ? { name: flow.loop.name, source: flow.loop.source } : null;
  const draft = status?.state === "waiting" ? (status.draft?.flow ?? null) : null;
  const shown = draft && !showOriginal ? draft : flow;
  const activity = useMemo(() => {
    const map = new Map<string, "running" | "done">();
    if (status?.purpose !== "run" || status.state !== "running" || status.loop !== flow?.loop.name)
      return map;
    for (const step of status.progress)
      if (map.get(step.phase) !== "running") map.set(step.phase, step.done ? "done" : "running");
    return map;
  }, [status, flow]);

  const language = useMemo(() => ({ lang, t }), [lang, t]);
  return (
    <LangContext.Provider value={language}>
      <div className="flex h-full flex-col">
        <header className="flex h-14 shrink-0 items-center gap-4 border-b border-line bg-panel px-4">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-600 text-white">
              <Workflow size={16} />
            </span>
            <span className="text-[15px] font-semibold tracking-tight">{t("app")}</span>
          </div>
          {overview && (
            <span className="flex items-center gap-1.5 rounded-lg bg-canvas px-2.5 py-1 text-[13px]">
              <span className="font-medium">{overview.project.name}</span>
              <span className="text-ink-4">·</span>
              <span className="text-ink-3">{overview.project.side}</span>
            </span>
          )}
          <nav className="ml-2 flex items-center gap-1">
            {(
              [
                ["projects", "nav_projects", FolderKanban],
                ["compose", "nav_compose", LayoutPanelLeft],
                ["roles", "nav_roles", Users],
                ["runs", "nav_runs", History],
              ] as const
            ).map(([key, label, Icon]) => (
              <button
                key={key}
                type="button"
                onClick={() => setPage(key)}
                className={cx(
                  "flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium",
                  page === key
                    ? "bg-brand-50 text-brand-700"
                    : "text-ink-3 hover:bg-canvas hover:text-ink-2",
                )}
              >
                <Icon size={15} /> {t(label)}
              </button>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => void load()} title={t("refresh")}>
              <RefreshCw size={14} /> {t("refresh")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const next = lang === "zh" ? "en" : "zh";
                setLang(next);
                try {
                  localStorage.setItem(LANG_KEY, next);
                } catch {
                  // The page still switches.
                }
              }}
            >
              <Languages size={14} /> {t("lang_switch")}
            </Button>
          </div>
        </header>

        {error && (
          <p className="bg-bad-50 px-4 py-2 text-sm text-bad-600">{t("load_failed") + error}</p>
        )}
        {page === "projects" ? (
          <div className="min-h-0 flex-1">
            <ProjectsPage onOpened={switched} />
          </div>
        ) : !overview ? (
          <p className="p-6 text-sm text-ink-4">{t("loading")}</p>
        ) : (
          <div className="min-h-0 flex-1">
            {page === "compose" && (
              <div className="grid h-full grid-cols-[minmax(320px,380px)_minmax(0,1fr)]">
                <ChatPanel
                  messages={messages}
                  references={references}
                  busy={busy}
                  onSend={(text) => void send(text)}
                  onRemoveReference={(id) =>
                    setReferences((list) => list.filter((entry) => entry.id !== id))
                  }
                  onPreview={setPreview}
                  onOpen={(target) => void open(target)}
                  current={current}
                  mode={flow || roleTarget ? mode : "find"}
                  onMode={setMode}
                  canChange={Boolean(flow || roleTarget)}
                  target={
                    roleTarget
                      ? roleTarget.name
                        ? t("target_role", { role: roleTarget.name })
                        : t("target_role_new")
                      : null
                  }
                  onClearTarget={() => setRoleTarget(null)}
                  onViewFiles={setRoleDraft}
                  waiting={status?.state === "waiting"}
                />
                <section className="flex min-w-0 flex-col">
                  {flow ? (
                    <div className="flex items-center gap-3 border-b border-line bg-panel px-4 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-[14px] font-semibold">
                            {flow.loop.name}
                          </span>
                          <LoopBadges loop={flow.loop} />
                          <span className="text-xs text-ink-4">
                            {t("steps_n", { n: flow.loop.steps })}
                            {flow.loop.waits ? ` · ${t("waits_n", { n: flow.loop.waits })}` : ""}
                          </span>
                        </div>
                        <p
                          className="mt-0.5 truncate text-xs text-ink-3"
                          title={flow.loop.description}
                        >
                          {flow.loop.description}
                        </p>
                      </div>
                      <select
                        value={`${flow.loop.source}:${flow.loop.name}`}
                        onChange={(event) => {
                          const [source, name] = event.target.value.split(":") as [
                            LoopRef["source"],
                            string,
                          ];
                          void open({ name, source }, true);
                        }}
                        className="h-8 rounded-lg border border-line-strong bg-white px-2 text-[13px] text-ink-2"
                        title={t("pick_loop")}
                      >
                        {overview.loops.map((loop) => (
                          <option
                            key={`${loop.source}:${loop.name}`}
                            value={`${loop.source}:${loop.name}`}
                          >
                            {loop.name} · {t(`source_${loop.source}` as TextKey)}
                          </option>
                        ))}
                      </select>
                      <Button onClick={() => setDefinition(current)}>
                        <FileText size={14} /> {t("definition")}
                      </Button>
                      <Button onClick={() => setParamsOpen(true)}>
                        <SlidersHorizontal size={14} /> {t("params_title")}
                      </Button>
                      {flow.loop.source === "project" && (
                        <Button
                          onClick={() => setRunOpen(true)}
                          disabled={status?.state === "running"}
                        >
                          <Play size={14} /> {t("run_button")}
                        </Button>
                      )}
                      {flow.loop.source === "project" && flow.loop.trial && (
                        <Button
                          onClick={() => void tryIt()}
                          disabled={status?.state === "running"}
                          title={t("trial_hint")}
                        >
                          <FlaskConical size={14} /> {t("trial_button")}
                        </Button>
                      )}
                      <Button
                        variant="primary"
                        disabled={flow.loop.kind !== "task"}
                        title={flow.loop.kind !== "task" ? t("use_not_task") : undefined}
                        onClick={() => setParamsOpen(true)}
                      >
                        <CheckCircle2 size={14} /> {t("use_this")}
                      </Button>
                    </div>
                  ) : null}
                  {draft && (
                    <div className="flex items-center gap-3 border-b border-wait-500/30 bg-wait-50 px-4 py-2 text-[13px] text-wait-600">
                      <span className="font-medium">{t("draft_badge")}</span>
                      <span className="truncate text-ink-3">{t("draft_hint")}</span>
                      <Button
                        size="sm"
                        className="ml-auto"
                        onClick={() => setShowOriginal((value) => !value)}
                      >
                        {showOriginal ? t("show_draft") : t("show_original")}
                      </Button>
                    </div>
                  )}
                  <div className="relative min-h-0 flex-1">
                    {shown ? (
                      <FlowCanvas
                        key={shown === draft ? "draft" : "loop"}
                        flow={shown}
                        referenced={referencedIds}
                        selected={selected}
                        onReference={point}
                        onSelect={setSelected}
                        activity={activity}
                      />
                    ) : (
                      <EmptyCanvas
                        overview={overview}
                        onOpen={(target) => void open(target, true)}
                        onPreview={setPreview}
                      />
                    )}
                    {shown && selected && (
                      <Inspector
                        flow={shown}
                        id={selected}
                        referenced={referencedIds.has(selected)}
                        onClose={() => setSelected(null)}
                        onReference={point}
                        onRole={showRole}
                      />
                    )}
                  </div>
                </section>
              </div>
            )}
            {page === "roles" && (
              <RolesPage
                overview={overview}
                selected={role}
                onSelect={setRole}
                onEdit={editRole}
                onOpenLoop={(name) => {
                  const loop =
                    overview.loops.find(
                      (entry) => entry.name === name && entry.source === "project",
                    ) ?? overview.loops.find((entry) => entry.name === name);
                  if (loop) void open({ name: loop.name, source: loop.source }, true);
                }}
              />
            )}
            {page === "runs" && <RunsPage overview={overview} />}
          </div>
        )}
      </div>
      <PreviewDialog
        target={preview}
        onClose={() => setPreview(null)}
        onOpen={(target) => void open(target)}
      />
      <DefinitionDialog target={definition} onClose={() => setDefinition(null)} />
      {flow && (
        <ParamsDialog
          flow={flow}
          open={paramsOpen}
          onClose={() => setParamsOpen(false)}
          onUse={useThis}
        />
      )}
      {flow && (
        <RunDialog
          loop={flow.loop.name}
          open={runOpen}
          onClose={() => setRunOpen(false)}
          onRun={() => void runIt()}
        />
      )}
      <RoleDraftDialog files={roleDraft} onClose={() => setRoleDraft(null)} />
    </LangContext.Provider>
  );
}

function EmptyCanvas({
  overview,
  onOpen,
  onPreview,
}: {
  overview: Overview;
  onOpen: (target: LoopRef) => void;
  onPreview: (target: LoopRef) => void;
}) {
  const { t } = useLang();
  return (
    <div className="scroll-thin h-full overflow-y-auto px-8 py-8">
      <p className="mb-4 text-sm text-ink-3">{t("canvas_empty")}</p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
        {overview.loops.map((loop) => (
          <div
            key={`${loop.source}:${loop.name}`}
            className="rounded-2xl border border-line bg-panel px-4 py-3 shadow-card"
          >
            <div className="font-mono text-[13px] font-semibold">{loop.name}</div>
            <div className="mt-1">
              <LoopBadges loop={loop} compact />
            </div>
            <p className="mt-1.5 line-clamp-3 text-xs leading-5 text-ink-3">{loop.description}</p>
            <div className="mt-2 flex gap-1.5">
              <Button size="sm" onClick={() => onPreview({ name: loop.name, source: loop.source })}>
                <Eye size={13} /> {t("preview")}
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => onOpen({ name: loop.name, source: loop.source })}
              >
                <LayoutPanelLeft size={13} /> {t("open")}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The end of a change, as the owner reads it: installed, not installed and why, or what the loop returned. */
function ended(result: unknown): Omit<ChatMessage, "id"> {
  const fields = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const name =
    typeof fields.loop === "string"
      ? fields.loop
      : typeof fields.role === "string"
        ? fields.role
        : "";
  if (fields.installed === true || typeof fields.installed === "string")
    return {
      from: "studio",
      key: "authoring_installed",
      values: { name: typeof fields.installed === "string" ? fields.installed : name },
    };
  if (fields.installed === false)
    return {
      from: "studio",
      key: "authoring_not_installed",
      values: { name, reason: String(fields.reason ?? "") },
    };
  return { from: "studio", key: "authoring_done", values: { result: summary(result) } };
}

/** What a loop returned, in a line: the name it installed, or its result as it is. */
function summary(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const fields = result as Record<string, unknown>;
    for (const key of ["installed", "loop", "role", "name", "reason"])
      if (typeof fields[key] === "string") return String(fields[key]);
    return JSON.stringify(result).slice(0, 300);
  }
  return String(result ?? "");
}
