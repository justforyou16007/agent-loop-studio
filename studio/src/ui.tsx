import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { LoopSummary } from "../../src/tools/studio-types.js";
import { useLang, type TextKey } from "./i18n.js";

export const cx = (...names: (string | false | null | undefined)[]): string =>
  names.filter(Boolean).join(" ");

export function Badge({
  tone = "gray",
  children,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-px text-[11px] font-medium leading-5",
        TONES[tone],
      )}
    >
      {children}
    </span>
  );
}
type Tone = "gray" | "brand" | "wait" | "loop" | "ok" | "bad" | "outline";
const TONES: Record<Tone, string> = {
  gray: "bg-canvas text-ink-3",
  brand: "bg-brand-50 text-brand-700",
  wait: "bg-wait-50 text-wait-600",
  loop: "bg-loop-50 text-loop-600",
  ok: "bg-ok-50 text-ok-600",
  bad: "bg-bad-50 text-bad-600",
  outline: "border border-line text-ink-3",
};

export function LoopBadges({ loop, compact = false }: { loop: LoopSummary; compact?: boolean }) {
  const { t } = useLang();
  const check: Record<LoopSummary["check"], Tone> = {
    ok: "ok",
    stale: "wait",
    failed: "bad",
    none: "gray",
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge tone={loop.kind === "task" ? "brand" : loop.kind === "setup" ? "loop" : "gray"}>
        {t(`kind_${loop.kind}` as TextKey)}
      </Badge>
      <Badge tone="outline">{t(`source_${loop.source}` as TextKey)}</Badge>
      {loop.chosen && <Badge tone="wait">★ {t("chosen")}</Badge>}
      {!compact && loop.source === "project" && (
        <Badge tone={check[loop.check]}>{t(`check_${loop.check}` as TextKey)}</Badge>
      )}
    </span>
  );
}

export function RoleChip({ name, onClick }: { name: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "inline-flex max-w-full items-center truncate rounded-md bg-brand-50 px-1.5 font-mono text-[11px] leading-5 text-brand-700",
        onClick ? "hover:bg-brand-100" : "cursor-default",
      )}
    >
      {name}
    </button>
  );
}

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md";
}) {
  return (
    <button
      type="button"
      {...rest}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-[13px]",
        variant === "primary" && "bg-brand-600 text-white shadow-card hover:bg-brand-700",
        variant === "secondary" &&
          "border border-line-strong bg-white text-ink-2 shadow-card hover:bg-canvas",
        variant === "ghost" && "text-ink-3 hover:bg-canvas hover:text-ink-2",
        className,
      )}
    />
  );
}

export function formatValue(value: unknown): string {
  if (value === undefined) return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
