import * as Dialog from "@radix-ui/react-dialog";
import { LayoutPanelLeft, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { Flow, LoopSource } from "../../src/tools/studio-types.js";
import { api } from "./api.js";
import { FlowCanvas } from "./canvas/FlowCanvas.js";
import { useLang } from "./i18n.js";
import { Markdown } from "./Markdown.js";
import { Button, formatValue, LoopBadges, RoleChip } from "./ui.js";

export interface LoopRef {
  name: string;
  source: LoopSource;
}

/** A candidate loop, drawn as a flow before the owner puts it on the canvas. */
export function PreviewDialog({
  target,
  onClose,
  onOpen,
}: {
  target: LoopRef | null;
  onClose: () => void;
  onOpen: (target: LoopRef) => void;
}) {
  const { t } = useLang();
  const [flow, setFlow] = useState<Flow | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setFlow(null);
    setError(null);
    if (!target) return;
    api
      .flow(target.name, target.source)
      .then(setFlow)
      .catch((reason: Error) => setError(reason.message));
  }, [target]);

  return (
    <Dialog.Root open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/30 backdrop-blur-[1px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex h-[84vh] w-[min(1200px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-float outline-none">
          <header className="flex items-start gap-3 border-b border-line px-5 py-4">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="flex flex-wrap items-center gap-2 font-mono text-[15px] font-semibold">
                {target?.name}
                {flow && <LoopBadges loop={flow.loop} />}
              </Dialog.Title>
              <Dialog.Description className="mt-1 line-clamp-2 text-[13px] text-ink-3">
                {flow?.loop.description ?? t("loading")}
              </Dialog.Description>
            </div>
            <Dialog.Close className="rounded-md p-1 text-ink-4 hover:bg-canvas hover:text-ink-2">
              <X size={18} />
            </Dialog.Close>
          </header>
          <div className="flex min-h-0 flex-1">
            <div className="relative min-w-0 flex-1 bg-canvas">
              {flow && <FlowCanvas flow={flow} preview />}
              {error && <p className="p-6 text-sm text-bad-600">{t("load_failed") + error}</p>}
            </div>
            {flow && (
              <aside className="scroll-thin w-[320px] shrink-0 space-y-4 overflow-y-auto border-l border-line px-4 py-4">
                <section>
                  <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-4">
                    {t("purpose")}
                  </h4>
                  <Markdown text={flow.purpose} />
                </section>
                <section>
                  <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-4">
                    {t("roles")}
                  </h4>
                  <div className="flex flex-wrap gap-1">
                    {flow.roles.map((role) => (
                      <RoleChip key={role.name} name={role.name} />
                    ))}
                  </div>
                </section>
                {flow.params.length > 0 && (
                  <section>
                    <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-4">
                      {t("params")}
                    </h4>
                    <ul className="space-y-2">
                      {flow.params.map((param) => (
                        <li key={param.name} className="text-xs">
                          <div className="flex items-baseline gap-2">
                            <code className="font-mono font-semibold text-ink-2">{param.name}</code>
                            <span className="text-ink-4">
                              {t("param_default")} {formatValue(param.default)}
                            </span>
                          </div>
                          <p className="leading-5 text-ink-3">{param.description}</p>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </aside>
            )}
          </div>
          <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">
            <Button onClick={onClose}>{t("close")}</Button>
            <Button variant="primary" disabled={!target} onClick={() => target && onOpen(target)}>
              <LayoutPanelLeft size={14} /> {t("open")}
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The definition as written, Markdown. */
export function DefinitionDialog({
  target,
  onClose,
}: {
  target: LoopRef | null;
  onClose: () => void;
}) {
  const { t } = useLang();
  const [text, setText] = useState<string>("");
  useEffect(() => {
    setText("");
    if (!target) return;
    api
      .loop(target.name, target.source)
      .then((detail) => setText(detail.definition.replace(/^---\n[\s\S]*?\n---\n?/, "")))
      .catch((reason: Error) => setText(t("load_failed") + reason.message));
  }, [target, t]);
  return (
    <Dialog.Root open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex h-[84vh] w-[min(860px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-float outline-none">
          <header className="flex items-center gap-3 border-b border-line px-5 py-3">
            <Dialog.Title className="flex-1 font-mono text-[15px] font-semibold">
              {target?.name} · {t("definition")}
            </Dialog.Title>
            <Dialog.Description className="sr-only">{t("definition")}</Dialog.Description>
            <Dialog.Close className="rounded-md p-1 text-ink-4 hover:bg-canvas hover:text-ink-2">
              <X size={18} />
            </Dialog.Close>
          </header>
          <div className="scroll-thin flex-1 overflow-y-auto px-6 py-4">
            <Markdown text={text || t("loading")} />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
