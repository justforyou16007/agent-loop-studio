import { Copy, DownloadCloud, FolderOpen, Plus, Send } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProjectsInfo } from "../../../src/tools/studio-types.js";
import { api } from "../api.js";
import { useLang } from "../i18n.js";
import { Badge, Button, cx } from "../ui.js";

/** The workspace's projects: open one, copy one, or start one from a reference project. */
export function ProjectsPage({ onOpened }: { onOpened: () => void }) {
  const { t, lang } = useLang();
  const [info, setInfo] = useState<ProjectsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [reference, setReference] = useState<string | null>(null);
  const [copying, setCopying] = useState<string | null>(null);
  const [copyName, setCopyName] = useState("");
  const load = () =>
    api
      .projects()
      .then((next) => {
        setInfo(next);
        setReference((current) => current ?? next.references[0]?.name ?? null);
      })
      .catch((reason: Error) => setError(reason.message));
  useEffect(() => {
    void load();
  }, []);
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      onOpened();
    } catch (reason) {
      setError(t("project_failed") + (reason as Error).message);
      void load();
    } finally {
      setBusy(false);
    }
  };
  const valid = /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name);
  /** Fetch the community library beside the Studio, or bring it up to date: its projects become examples. */
  const fetchCommunity = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.fetchCommunity();
      await load();
    } catch (reason) {
      setError(t("project_failed") + (reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="scroll-thin h-full overflow-y-auto px-8 py-6">
      <div className="mx-auto max-w-5xl space-y-8">
        <section>
          <h1 className="text-lg font-semibold">{t("projects_title")}</h1>
          <p className="mt-1 text-[13px] text-ink-3">
            {t("projects_hint", { workspace: info?.workspace ?? "" })}
          </p>
          {error && (
            <p className="mt-3 rounded-lg bg-bad-50 px-3 py-2 text-[13px] text-bad-600">{error}</p>
          )}
          {info && info.projects.length === 0 && (
            <p className="mt-4 text-sm text-ink-4">{t("project_none")}</p>
          )}
          <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
            {info?.projects.map((project) => (
              <div
                key={project.name}
                className={cx(
                  "rounded-2xl border bg-panel px-4 py-3 shadow-card",
                  project.name === info.current ? "border-brand-500" : "border-line",
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="truncate font-mono text-[13px] font-semibold">
                    {project.name}
                  </span>
                  {project.name === info.current && (
                    <Badge tone="brand">{t("project_current")}</Badge>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {project.package && <Badge tone="outline">{project.package}</Badge>}
                  {project.profile && <Badge>{project.profile}</Badge>}
                </div>
                <p className="mt-1.5 text-xs text-ink-3">
                  {project.loop ? `${t("project_loop")}: ${project.loop}` : t("project_no_loop")}
                </p>
                <p className="mt-0.5 flex items-center gap-1 text-xs text-ink-4">
                  {project.published ? (
                    <>
                      <Send size={11} />
                      {project.published.pull_request ? (
                        <a
                          href={project.published.pull_request}
                          target="_blank"
                          rel="noreferrer"
                          className="underline"
                        >
                          {t("project_published", { name: project.published.name })}
                        </a>
                      ) : (
                        t("project_published", { name: project.published.name })
                      )}
                    </>
                  ) : (
                    t("project_draft")
                  )}
                </p>
                {copying === project.name ? (
                  <div className="mt-2 flex gap-1.5">
                    <input
                      value={copyName}
                      onChange={(event) => setCopyName(event.target.value)}
                      placeholder={t("project_copy_name")}
                      className="h-7 min-w-0 flex-1 rounded-lg border border-line-strong px-2 font-mono text-xs"
                    />
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(copyName)}
                      onClick={() => void act(() => api.copyProject(project.name, copyName))}
                    >
                      <Copy size={12} /> {t("project_copy")}
                    </Button>
                  </div>
                ) : (
                  <div className="mt-2 flex gap-1.5">
                    <Button
                      size="sm"
                      variant={project.name === info.current ? "secondary" : "primary"}
                      disabled={busy}
                      onClick={() => void act(() => api.openProject(project.name))}
                    >
                      <FolderOpen size={12} /> {t("project_open")}
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setCopying(project.name);
                        setCopyName(`${project.name}-copy`);
                      }}
                    >
                      <Copy size={12} /> {t("project_copy")}
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-line bg-panel px-5 py-4 shadow-card">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold">
            <Plus size={16} /> {t("project_new")}
          </h2>
          {info && !info.can_create ? (
            <p className="mt-2 text-[13px] text-ink-3">{t("project_no_create")}</p>
          ) : (
            <>
              <label className="mt-3 block text-xs text-ink-3">
                {t("project_name")} · <span className="text-ink-4">{t("project_name_hint")}</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="mt-1 block h-8 w-72 rounded-lg border border-line-strong px-2 font-mono text-[13px]"
                />
              </label>
              <div className="mt-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-ink-4">
                {t("project_from")}
                {info?.community.present && (
                  <Button size="sm" disabled={busy} onClick={() => void fetchCommunity()}>
                    <DownloadCloud size={12} /> {t("community_update")}
                  </Button>
                )}
              </div>
              {info && !info.community.present && (
                <div className="mt-2 flex items-center gap-2 rounded-lg bg-canvas px-3 py-2 text-xs text-ink-3">
                  <span className="flex-1">{t("community_missing")}</span>
                  <Button size="sm" disabled={busy} onClick={() => void fetchCommunity()}>
                    <DownloadCloud size={12} /> {t("community_fetch")}
                  </Button>
                </div>
              )}
              <div className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
                {info?.references.map((entry) => (
                  <button
                    key={entry.name}
                    type="button"
                    onClick={() => setReference(entry.name)}
                    className={cx(
                      "rounded-xl border px-3 py-2.5 text-left",
                      reference === entry.name
                        ? "border-brand-500 bg-brand-50"
                        : "border-line hover:bg-canvas",
                    )}
                  >
                    <div className="flex items-center gap-1.5 text-[13px] font-semibold">
                      {entry.title[lang]}
                      <Badge tone={entry.source === "community" ? "brand" : "outline"}>
                        {t(
                          entry.source === "community"
                            ? "project_source_community"
                            : "project_source_framework",
                        )}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-ink-3">{entry.description[lang]}</p>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setReference(null)}
                  className={cx(
                    "rounded-xl border px-3 py-2.5 text-left",
                    reference === null
                      ? "border-brand-500 bg-brand-50"
                      : "border-line hover:bg-canvas",
                  )}
                >
                  <div className="text-[13px] font-semibold">{t("project_empty")}</div>
                  <p className="mt-1 text-xs leading-5 text-ink-3">{t("project_empty_hint")}</p>
                </button>
              </div>
              <div className="mt-4">
                <Button
                  variant="primary"
                  disabled={busy || !valid}
                  onClick={() => void act(() => api.newProject(name, reference))}
                >
                  <Plus size={14} /> {t("project_create")}
                </Button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
