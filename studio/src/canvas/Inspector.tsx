import { AtSign, Bot, UserCheck, Workflow, X } from "lucide-react";
import type { Flow } from "../../../src/tools/studio-types.js";
import { useLang } from "../i18n.js";
import { Markdown } from "../Markdown.js";
import type { Reference } from "../types.js";
import { Badge, Button, formatValue, RoleChip } from "../ui.js";
import { nodeLabel } from "./FlowCanvas.js";

/** What one step of the flow says, in full, beside the canvas. */
export function Inspector({
  flow,
  id,
  referenced,
  onClose,
  onReference,
  onRole,
}: {
  flow: Flow;
  id: string;
  referenced: boolean;
  onClose: () => void;
  onReference: (reference: Reference) => void;
  onRole: (name: string) => void;
}) {
  const { t } = useLang();
  const node = flow.nodes.find((entry) => entry.id === id);
  if (!node) return null;
  const roles = new Set(flow.roles.map((role) => role.name));
  const params = flow.params.filter((param) => param.links.includes(node.id));
  const Icon = node.waits ? UserCheck : node.loops.length ? Workflow : Bot;
  return (
    <aside className="absolute right-3 top-3 bottom-3 z-10 flex w-[380px] flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-float">
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-600 text-white">
          <Icon size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{node.title || nodeLabel(node, t)}</div>
          <div className="text-[11px] text-ink-4">{nodeLabel(node, t)}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-ink-4 hover:bg-canvas hover:text-ink-2"
        >
          <X size={16} />
        </button>
      </header>
      <div className="scroll-thin flex-1 space-y-4 overflow-y-auto px-4 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {node.group && (
            <Badge tone="outline">
              {t("stage")} · {node.group}
            </Badge>
          )}
          {node.waits && <Badge tone="wait">{t("waits")}</Badge>}
          <Button
            size="sm"
            variant={referenced ? "secondary" : "primary"}
            className="ml-auto"
            onClick={() => onReference({ kind: "node", id: node.id, label: nodeLabel(node, t) })}
          >
            <AtSign size={13} /> {referenced ? t("referenced") : t("reference")}
          </Button>
        </div>
        {node.notes.length > 0 && (
          <section className="rounded-xl bg-canvas px-3 py-2">
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-ink-4">
              {t("notes")}
            </h4>
            <Markdown text={node.notes.join("\n\n")} roles={roles} onRole={onRole} />
          </section>
        )}
        {node.text && <Markdown text={node.text} roles={roles} onRole={onRole} />}
        {node.items.length > 0 && (
          <section>
            <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-4">
              {t("items")}
            </h4>
            <ul className="space-y-1.5">
              {node.items.map((item, index) => (
                <li key={index} className="rounded-lg border border-line px-2.5 py-1.5">
                  <Markdown text={item.text} roles={roles} onRole={onRole} />
                </li>
              ))}
            </ul>
          </section>
        )}
        {node.roles.length > 0 && (
          <section>
            <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-4">
              {t("roles")}
            </h4>
            <ul className="space-y-1.5">
              {node.roles.map((name) => (
                <li key={name} className="rounded-lg border border-line px-2.5 py-2">
                  <RoleChip name={name} onClick={() => onRole(name)} />
                  <p className="mt-1 text-xs leading-5 text-ink-3">
                    {flow.roles.find((role) => role.name === name)?.description}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}
        {node.loops.length > 0 && (
          <section>
            <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-4">
              {t("runs_loop")}
            </h4>
            <div className="flex flex-wrap gap-1">
              {node.loops.map((loop) => (
                <Badge key={loop} tone="loop">
                  <Workflow size={11} /> {loop}
                </Badge>
              ))}
            </div>
          </section>
        )}
        {params.length > 0 && (
          <section>
            <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-4">
              {t("params")}
            </h4>
            <ul className="space-y-1">
              {params.map((param) => (
                <li key={param.name} className="flex items-baseline gap-2 text-xs">
                  <code className="font-mono text-ink-2">{param.name}</code>
                  <span className="text-ink-4">
                    {param.value !== undefined
                      ? `${t("param_value")} ${formatValue(param.value)} · `
                      : ""}
                    {t("param_default")} {formatValue(param.default)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </aside>
  );
}
