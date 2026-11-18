import { Check, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { PublishPlan, PublishUnit } from "../../src/tools/studio-types.js";
import { Frame } from "./dialogs.js";
import { useLang, type TextKey } from "./i18n.js";
import {
  alreadyThere,
  choosable,
  leaves,
  memoryByRole,
  plannedTicks,
  selectionChange,
} from "./publish-review.js";
import { Badge, Button, cx } from "./ui.js";

const KINDS = new Set(["know-how", "lesson", "fact"]);
const STATES = new Set([
  "new",
  "changed",
  "excluded",
  "blocked",
  "conflict",
  "in-library",
  "already-sent",
  "invalid",
  "wrong-side",
  "unknown-base",
]);
const keyOf = (prefix: string, value: string) => `${prefix}${value.replace(/-/g, "_")}` as TextKey;

/**
 * The publish loop's review, as a page: every memory entry that would leave,
 * by role, each with a tick (all ticked to begin with), and the loops, roles
 * and project description that would leave, to read. Approving sends the
 * approval; a changed selection sends the entries to leave out or put back,
 * and the loop plans again and asks again.
 */
export function PublishReviewDialog({
  plan,
  onClose,
  onReply,
}: {
  plan: PublishPlan | null;
  onClose: () => void;
  onReply: (text: string) => void;
}) {
  const { t } = useLang();
  const groups = useMemo(() => (plan ? memoryByRole(plan) : []), [plan]);
  const planned = useMemo(() => (plan ? plannedTicks(plan) : new Set<string>()), [plan]);
  const [ticked, setTicked] = useState<Set<string>>(planned);
  useEffect(() => setTicked(new Set(planned)), [planned]);
  const { leaveOut, putBack } = plan
    ? selectionChange(plan, ticked)
    : { leaveOut: [], putBack: [] };
  const changed = leaveOut.length > 0 || putBack.length > 0;
  const defects = plan?.library_check && !plan.library_check.ok ? plan.library_check.defects : [];
  const others = plan
    ? [...plan.selected, ...plan.not_selected].filter((unit) => unit.kind !== "memory")
    : [];
  const choosableNames = groups
    .flatMap((group) => group.units.filter(choosable))
    .map((unit) => unit.name);
  const toggle = (name: string, on: boolean) =>
    setTicked((current) => {
      const next = new Set(current);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  const reply = () => {
    const join = (names: string[]) => names.join(t("list_join"));
    onReply(
      changed
        ? [
            leaveOut.length ? t("publish_leave_out", { names: join(leaveOut) }) : "",
            putBack.length ? t("publish_put_back", { names: join(putBack) }) : "",
          ]
            .filter(Boolean)
            .join(" ")
        : t("approve_word"),
    );
  };
  const state = (unit: PublishUnit) =>
    STATES.has(unit.state) ? t(keyOf("publish_state_", unit.state)) : unit.state;

  return (
    <Frame
      open={plan !== null}
      onClose={onClose}
      width="min(860px,94vw)"
      title={t("publish_review_title", { name: plan?.name ?? "" })}
      description={t("publish_review_body")}
      footer={
        <>
          {changed && (
            <span className="mr-auto self-center text-[11.5px] text-ink-4">
              {t("publish_replan_hint")}
            </span>
          )}
          <Button onClick={onClose}>{t("close")}</Button>
          <Button variant="primary" disabled={!changed && defects.length > 0} onClick={reply}>
            {changed ? <RotateCcw size={14} /> : <Check size={14} />}
            {changed ? t("publish_replan") : t("publish_approve")}
          </Button>
        </>
      }
    >
      {defects.length > 0 && (
        <div className="mb-4 rounded-lg bg-bad-50 px-3 py-2 text-[12.5px] text-bad-600">
          <p className="font-semibold">{t("publish_defects")}</p>
          <ul className="mt-1 list-disc pl-5">
            {defects.map((defect) => (
              <li key={defect}>{defect}</li>
            ))}
          </ul>
        </div>
      )}
      <section>
        <div className="mb-2 flex items-center gap-2">
          <h3 className="text-[13.5px] font-semibold">{t("publish_memory")}</h3>
          {choosableNames.length > 0 && (
            <>
              <Badge tone="brand">
                {t("publish_memory_count", {
                  checked: choosableNames.filter((name) => ticked.has(name)).length,
                  n: choosableNames.length,
                })}
              </Badge>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={() => setTicked(new Set(choosableNames))}
              >
                {t("publish_all")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setTicked(new Set())}>
                {t("publish_none")}
              </Button>
            </>
          )}
        </div>
        {groups.length === 0 && <p className="text-xs text-ink-4">{t("publish_memory_none")}</p>}
        {groups.map((group) => (
          <div key={group.role} className="mb-3">
            <div className="mb-1.5 font-mono text-[12.5px] font-semibold text-brand-700">
              {group.role}
            </div>
            <div className="space-y-1.5">
              {group.units.map((unit) => {
                const entry = unit.memory!;
                const open = choosable(unit);
                const on = open ? ticked.has(unit.name) : alreadyThere(unit);
                return (
                  <label
                    key={unit.name}
                    className={cx(
                      "flex gap-2.5 rounded-xl border px-3 py-2",
                      on ? "border-brand-500/40 bg-brand-50/40" : "border-line",
                      open ? "cursor-pointer" : "opacity-75",
                    )}
                  >
                    <input
                      type="checkbox"
                      className="mt-1 shrink-0"
                      checked={on}
                      disabled={!open}
                      onChange={(event) => toggle(unit.name, event.target.checked)}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[13px] font-semibold">{entry.title}</span>
                        <Badge tone="outline">
                          {KINDS.has(entry.kind)
                            ? t(keyOf("publish_kind_", entry.kind))
                            : entry.kind}
                        </Badge>
                        {!leaves(unit) && (
                          <Badge tone={unit.state === "blocked" ? "bad" : "gray"}>
                            {state(unit)}
                          </Badge>
                        )}
                        <span className="ml-auto font-mono text-[11px] text-ink-4">{entry.id}</span>
                      </div>
                      {entry.tasks.length > 0 && (
                        <p className="mt-0.5 text-[11.5px] text-ink-4">
                          {t("publish_tasks", { tasks: entry.tasks.join(t("list_join")) })}
                        </p>
                      )}
                      <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-5 text-ink-2">
                        {entry.body}
                      </p>
                      {entry.evidence.length > 0 && (
                        <details className="mt-1 text-[11.5px] text-ink-4">
                          <summary className="cursor-pointer">{t("publish_evidence")}</summary>
                          <ul className="mt-0.5 list-disc pl-5">
                            {entry.evidence.map((line, index) => (
                              <li key={index}>{line}</li>
                            ))}
                          </ul>
                        </details>
                      )}
                      {unit.reason && !leaves(unit) && unit.state !== "excluded" && (
                        <p className="mt-1 text-[11.5px] text-bad-600">{unit.reason}</p>
                      )}
                      {unit.warnings.map((warning) => (
                        <p key={warning} className="mt-1 text-[11.5px] text-wait-600">
                          {warning}
                        </p>
                      ))}
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </section>
      <section className="mt-5">
        <h3 className="mb-2 text-[13.5px] font-semibold">{t("publish_units")}</h3>
        {others.length === 0 && <p className="text-xs text-ink-4">{t("publish_units_none")}</p>}
        <ul className="space-y-1">
          {others.map((unit) => (
            <li key={`${unit.kind}:${unit.name}`} className="text-[12.5px] leading-5">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone="outline">{unit.kind}</Badge>
                <span className="font-mono font-semibold">{unit.name}</span>
                <Badge tone={leaves(unit) ? "ok" : unit.state === "blocked" ? "bad" : "gray"}>
                  {state(unit)}
                </Badge>
              </div>
              {unit.description && <p className="text-ink-3">{unit.description}</p>}
              {unit.reason && !leaves(unit) && (
                <p className="text-[11.5px] text-ink-4">{unit.reason}</p>
              )}
              {unit.warnings.map((warning) => (
                <p key={warning} className="text-[11.5px] text-wait-600">
                  {warning}
                </p>
              ))}
            </li>
          ))}
        </ul>
      </section>
      {plan && plan.removed.length > 0 && (
        <section className="mt-5">
          <h3 className="mb-2 text-[13.5px] font-semibold">{t("publish_removed")}</h3>
          <ul className="list-disc pl-5 font-mono text-[12px] text-ink-3">
            {plan.removed.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        </section>
      )}
    </Frame>
  );
}
