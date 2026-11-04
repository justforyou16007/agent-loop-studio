import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowUp,
  CheckCircle2,
  Folder,
  FolderOpen,
  Play,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { Flow, FlowParam, FolderListing } from "../../src/tools/studio-types.js";
import { api } from "./api.js";
import { useLang } from "./i18n.js";
import { Markdown } from "./Markdown.js";
import { Badge, Button, cx, formatValue } from "./ui.js";

function Frame({
  open,
  onClose,
  title,
  description,
  width = "min(640px,92vw)",
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  width?: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/30" />
        <Dialog.Content
          style={{ width }}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[86vh] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-float outline-none"
        >
          <header className="flex items-start gap-3 border-b border-line px-5 py-4">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-[15px] font-semibold">{title}</Dialog.Title>
              <Dialog.Description className="mt-1 text-[13px] leading-5 text-ink-3">
                {description ?? ""}
              </Dialog.Description>
            </div>
            <Dialog.Close className="rounded-md p-1 text-ink-4 hover:bg-canvas hover:text-ink-2">
              <X size={18} />
            </Dialog.Close>
          </header>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">
            {footer}
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A value as the owner types it, read back as the parameter's type. */
function parse(param: FlowParam, raw: string | boolean): unknown {
  if (param.type === "boolean") return Boolean(raw);
  if (param.type === "integer" || param.type === "number") return raw === "" ? NaN : Number(raw);
  return String(raw);
}
function problem(param: FlowParam, value: unknown): boolean {
  if (param.type === "integer") return !Number.isInteger(value);
  if (param.type === "number") return typeof value !== "number" || !Number.isFinite(value);
  if (typeof value === "number" && param.min !== undefined && value < param.min) return true;
  if (typeof value === "number" && param.max !== undefined && value > param.max) return true;
  if (param.type === "enum") return !(param.choices ?? []).includes(String(value));
  return false;
}

/** The loop's parameters, and making it the loop this project runs with these values. */
export function ParamsDialog({
  flow,
  open,
  onClose,
  onUse,
}: {
  flow: Flow;
  open: boolean;
  onClose: () => void;
  onUse: (params: Record<string, unknown>) => Promise<void>;
}) {
  const { t } = useLang();
  const initial = () =>
    Object.fromEntries(flow.params.map((param) => [param.name, param.value ?? param.default]));
  const [values, setValues] = useState<Record<string, unknown>>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setValues(initial());
      setError(null);
    }
    // Reset to the loop's values each time the dialog opens.
  }, [open, flow]);
  const task = flow.loop.kind === "task";
  const invalid = flow.params.some((param) => problem(param, values[param.name]));
  return (
    <Frame
      open={open}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <span className="font-mono">{flow.loop.name}</span> · {t("params_title")}
        </span>
      }
      description={
        task
          ? flow.loop.source === "library"
            ? t("use_library_note")
            : t("params_hint")
          : t("use_not_task")
      }
      footer={
        <>
          <Button onClick={onClose}>{t("close")}</Button>
          <Button
            variant="primary"
            disabled={!task || invalid || busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onUse(values);
              } catch (reason) {
                setError((reason as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <CheckCircle2 size={14} /> {t("use_as_task")}
          </Button>
        </>
      }
    >
      {flow.params.length === 0 && <p className="text-sm text-ink-3">{t("no_params")}</p>}
      <ul className="space-y-3">
        {flow.params.map((param) => {
          const value = values[param.name];
          const bad = problem(param, value);
          const range =
            param.min !== undefined || param.max !== undefined
              ? `${param.min ?? "…"} – ${param.max ?? "…"}`
              : "";
          return (
            <li key={param.name} className="rounded-xl border border-line px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <code className="font-mono text-[13px] font-semibold">{param.name}</code>
                <Badge>{param.type}</Badge>
                {range && <Badge tone="outline">{range}</Badge>}
                <span className="ml-auto text-xs text-ink-4">
                  {t("param_default")} {formatValue(param.default)}
                </span>
              </div>
              <p className="mt-1 text-xs leading-5 text-ink-3">{param.description}</p>
              <div className="mt-2 flex items-center gap-2">
                {param.type === "boolean" ? (
                  <input
                    type="checkbox"
                    checked={Boolean(value)}
                    disabled={!task}
                    onChange={(event) =>
                      setValues({ ...values, [param.name]: event.target.checked })
                    }
                  />
                ) : param.type === "enum" ? (
                  <select
                    value={String(value)}
                    disabled={!task}
                    onChange={(event) => setValues({ ...values, [param.name]: event.target.value })}
                    className="h-8 rounded-lg border border-line-strong bg-white px-2 text-[13px]"
                  >
                    {(param.choices ?? []).map((choice) => (
                      <option key={choice}>{choice}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={
                      typeof value === "number" && Number.isNaN(value) ? "" : String(value ?? "")
                    }
                    disabled={!task}
                    inputMode={param.type === "string" ? "text" : "decimal"}
                    onChange={(event) =>
                      setValues({ ...values, [param.name]: parse(param, event.target.value) })
                    }
                    className={cx(
                      "h-8 w-40 rounded-lg border bg-white px-2 font-mono text-[13px] outline-none focus:ring-2 focus:ring-brand-100",
                      bad ? "border-bad-600" : "border-line-strong",
                    )}
                  />
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!task}
                  onClick={() => setValues({ ...values, [param.name]: param.default })}
                >
                  <RotateCcw size={12} /> {t("reset")}
                </Button>
                {bad && <span className="text-xs text-bad-600">{t("invalid")}</span>}
              </div>
            </li>
          );
        })}
      </ul>
      {error && (
        <p className="mt-3 rounded-lg bg-bad-50 px-3 py-2 text-[13px] text-bad-600">{error}</p>
      )}
    </Frame>
  );
}

/** Starting a loop in a background session: what it means, before it starts. */
export function RunDialog({
  loop,
  open,
  onClose,
  onRun,
}: {
  loop: string;
  open: boolean;
  onClose: () => void;
  onRun: () => void;
}) {
  const { t } = useLang();
  return (
    <Frame
      open={open}
      onClose={onClose}
      title={t("run_title", { loop })}
      footer={
        <>
          <Button onClick={onClose}>{t("close")}</Button>
          <Button
            variant="primary"
            onClick={() => {
              onRun();
              onClose();
            }}
          >
            <Play size={14} /> {t("run_button")}
          </Button>
        </>
      }
    >
      <p className="text-[13px] leading-6 text-ink-2">{t("run_body")}</p>
    </Frame>
  );
}

/** A role's draft beside the version the project has now. */
export function RoleDraftDialog({
  files,
  onClose,
}: {
  files: { name: string; text: string; original: string | null }[] | null;
  onClose: () => void;
}) {
  const { t } = useLang();
  const strip = (text: string) => text.replace(/^---\n[\s\S]*?\n---\n?/, "");
  return (
    <Frame
      open={files !== null}
      onClose={onClose}
      width="min(1180px,94vw)"
      title={t("view_role_draft")}
      footer={<Button onClick={onClose}>{t("close")}</Button>}
    >
      {(files ?? []).map((file) => (
        <section key={file.name} className="mb-5">
          <h3 className="mb-2 font-mono text-[14px] font-semibold">{file.name}</h3>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-wait-500/40 bg-wait-50/40 px-3 py-1">
              <div className="pt-1 text-[11px] font-semibold uppercase tracking-wide text-wait-600">
                {t("draft_role")}
              </div>
              <Markdown text={strip(file.text)} />
            </div>
            <div className="rounded-xl border border-line px-3 py-1">
              <div className="pt-1 text-[11px] font-semibold uppercase tracking-wide text-ink-4">
                {t("current_role")}
              </div>
              {file.original ? (
                <Markdown text={strip(file.original)} />
              ) : (
                <p className="py-2 text-xs text-ink-4">{t("none")}</p>
              )}
            </div>
          </div>
        </section>
      ))}
    </Frame>
  );
}

/** Deleting a project: what goes with it, and its name typed to confirm. */
export function DeleteProjectDialog({
  project,
  onClose,
  onDelete,
}: {
  project: { name: string; root: string } | null;
  onClose: () => void;
  onDelete: (name: string) => Promise<void>;
}) {
  const { t } = useLang();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setTyped("");
    setError(null);
  }, [project]);
  const name = project?.name ?? "";
  return (
    <Frame
      open={project !== null}
      onClose={onClose}
      title={t("project_delete_title", { name })}
      description={t("project_delete_body", { root: project?.root ?? "" })}
      footer={
        <>
          <Button onClick={onClose}>{t("close")}</Button>
          <Button
            variant="danger"
            disabled={busy || typed !== name}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onDelete(name);
              } catch (reason) {
                setError((reason as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Trash2 size={14} /> {t("project_delete_button")}
          </Button>
        </>
      }
    >
      <label className="block text-xs text-ink-3">
        {t("project_delete_confirm", { name })}
        <input
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          autoFocus
          spellCheck={false}
          className="mt-1 block h-8 w-full rounded-lg border border-line-strong px-2 font-mono text-[13px] outline-none focus:border-bad-600"
        />
      </label>
      {error && (
        <p className="mt-3 rounded-lg bg-bad-50 px-3 py-2 text-[13px] text-bad-600">{error}</p>
      )}
    </Frame>
  );
}

/** Choosing the folder of projects: browse to it, type it, or pick one used before. */
export function WorkspaceDialog({
  open,
  current,
  recent,
  onClose,
  onChosen,
}: {
  open: boolean;
  current: string;
  recent: string[];
  onClose: () => void;
  onChosen: (result: { workspace: string; current: string | null }) => Promise<void>;
}) {
  const { t } = useLang();
  const [typed, setTyped] = useState(current);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const browse = async (where: string): Promise<FolderListing | null> => {
    setError(null);
    try {
      const next = await api.folders(where);
      setListing(next);
      setTyped(next.path);
      return next;
    } catch (reason) {
      setError((reason as Error).message);
      return null;
    }
  };
  useEffect(() => {
    if (open) void browse(current);
    // Each time the dialog opens, it starts at the workspace in use.
  }, [open, current]);
  /** The folder typed, once listed: a folder that does not exist yet is created only after the owner has seen so. */
  const use = async () => {
    setBusy(true);
    try {
      let target = listing;
      if (!target || typed !== target.path) {
        target = await browse(typed);
        if (!target?.exists) return;
      }
      await onChosen(await api.useWorkspace(target.path, !target.exists));
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const missing = listing !== null && typed === listing.path && !listing.exists;
  return (
    <Frame
      open={open}
      onClose={onClose}
      width="min(720px,94vw)"
      title={t("workspace_title")}
      description={t("workspace_hint", { workspace: current })}
      footer={
        <>
          <Button onClick={onClose}>{t("close")}</Button>
          <Button variant="primary" disabled={busy || !typed.trim()} onClick={() => void use()}>
            <FolderOpen size={14} /> {t(missing ? "workspace_create_use" : "workspace_use")}
          </Button>
        </>
      }
    >
      <div className="flex gap-2">
        <input
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void browse(typed);
            }
          }}
          spellCheck={false}
          className="h-8 min-w-0 flex-1 rounded-lg border border-line-strong px-2 font-mono text-[13px] outline-none focus:ring-2 focus:ring-brand-100"
        />
        <Button onClick={() => void browse(typed)}>{t("workspace_go")}</Button>
      </div>
      {error && (
        <p className="mt-3 rounded-lg bg-bad-50 px-3 py-2 text-[13px] text-bad-600">{error}</p>
      )}
      {listing && (
        <>
          <div className="mt-3 flex items-center gap-2 text-xs text-ink-3">
            <Button
              size="sm"
              disabled={!listing.parent}
              onClick={() => listing.parent && void browse(listing.parent)}
            >
              <ArrowUp size={12} /> {t("workspace_up")}
            </Button>
            <span className="truncate font-mono text-ink-4" title={listing.path}>
              {listing.path}
            </span>
            <span className="ml-auto shrink-0">
              {!listing.exists
                ? t("workspace_missing")
                : listing.projects
                  ? t("workspace_here_projects", { n: listing.projects })
                  : t("workspace_here_empty")}
            </span>
          </div>
          {listing.exists && (
            <ul className="scroll-thin mt-2 max-h-72 overflow-y-auto rounded-xl border border-line py-1">
              {listing.folders.length === 0 ? (
                <li className="px-3 py-2 text-xs text-ink-4">{t("workspace_no_folders")}</li>
              ) : (
                listing.folders.map((folder) => (
                  <li key={folder.path}>
                    <button
                      type="button"
                      onClick={() => void browse(folder.path)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-ink-2 hover:bg-canvas"
                    >
                      <Folder size={14} className="shrink-0 text-ink-4" />
                      <span className="truncate">{folder.name}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
        </>
      )}
      {recent.length > 0 && (
        <div className="mt-4">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-4">
            {t("workspace_recent")}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {recent.map((entry) => (
              <button
                key={entry}
                type="button"
                title={entry}
                onClick={() => void browse(entry)}
                className="max-w-full truncate rounded-lg border border-line px-2 py-1 font-mono text-[12px] text-ink-2 hover:bg-canvas"
              >
                {entry}
              </button>
            ))}
          </div>
        </div>
      )}
    </Frame>
  );
}
