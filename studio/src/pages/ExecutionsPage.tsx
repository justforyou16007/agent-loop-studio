import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { AuthoringStatus } from "../../../src/tools/studio-types.js";
import { api } from "../api.js";
import { ExecutionCard } from "../ExecutionCard.js";
import { useLang } from "../i18n.js";
import { Button } from "../ui.js";

/** How often the page asks again how the executions stand. */
const EVERY_MS = 3000;

/** Every loop the Studio runs in this project: how it stands, how far it got, and what the owner can do about it. */
export function ExecutionsPage({ onOpen }: { onOpen: (status: AuthoringStatus) => void }) {
  const { t } = useLang();
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
          {list?.map((status) => (
            <ExecutionCard
              key={status.id}
              status={status}
              busy={busy === status.id}
              onStop={() =>
                void act(status.id, async () => {
                  await api.stop(status.id);
                  return null;
                })
              }
              onResume={() =>
                void act(status.id, async () => {
                  const resumed = await api.resume(status.id);
                  return t("exec_resumed", { run: resumed.run });
                })
              }
              onOpen={() => onOpen(status)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
