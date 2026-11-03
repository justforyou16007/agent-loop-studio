import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Bot, Check, Flag, Play, SlidersHorizontal, UserCheck, Workflow } from "lucide-react";
import type { FlowNode, FlowParam } from "../../../src/tools/studio-types.js";
import { useLang } from "../i18n.js";
import { Badge, cx, formatValue, RoleChip } from "../ui.js";

export interface StepData extends Record<string, unknown> {
  node: FlowNode;
  referenced: boolean;
  selected: boolean;
  /** In the loop running now: going on, or done. */
  activity?: "running" | "done";
}
export interface ParamData extends Record<string, unknown> {
  param: FlowParam;
  referenced: boolean;
}
export type StepNodeType = Node<StepData, "step">;
export type EdgeNodeType = Node<StepData, "start" | "end">;
export type ParamNodeType = Node<ParamData, "param">;

/** The first lines of a step as plain words: no backticks, no inline JSON. */
export function plain(text: string): string {
  return text
    .replace(/\s*\(`\{[^`]*\}`\)/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

const hidden = "!h-2 !w-2 !min-h-0 !min-w-0 !border-0 !bg-transparent";

export function StepNode({ data }: NodeProps<StepNodeType>) {
  const { t } = useLang();
  const { node, referenced, selected, activity } = data;
  const runsLoop = node.loops.length > 0;
  const tone = node.waits
    ? "bg-wait-500 text-white"
    : runsLoop
      ? "bg-loop-600 text-white"
      : "bg-brand-600 text-white";
  const Icon = node.waits ? UserCheck : runsLoop ? Workflow : Bot;
  return (
    <div
      className={cx(
        "relative w-[300px] rounded-2xl border bg-panel shadow-card transition-shadow",
        selected ? "border-brand-500 shadow-float" : "border-line hover:shadow-float",
        referenced && "ring-2 ring-brand-500 ring-offset-2 ring-offset-canvas",
        activity === "running" && "animate-pulse border-brand-500 ring-2 ring-brand-100",
        activity === "done" && "border-ok-600/50",
      )}
    >
      {activity === "done" && (
        <span className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-ok-600 text-white shadow-card">
          <Check size={12} strokeWidth={3} />
        </span>
      )}
      <Handle type="target" position={Position.Top} id="in" className={hidden} />
      <Handle type="source" position={Position.Bottom} id="out" className={hidden} />
      <Handle
        type="source"
        position={Position.Left}
        id="back-out"
        className={hidden}
        style={{ top: "60%" }}
      />
      <Handle
        type="target"
        position={Position.Left}
        id="back-in"
        className={hidden}
        style={{ top: "30%" }}
      />
      <Handle type="target" position={Position.Right} id="param" className={hidden} />
      <div className="flex items-center gap-2 px-3 pt-3">
        <span className={cx("flex h-6 w-6 shrink-0 items-center justify-center rounded-lg", tone)}>
          <Icon size={14} strokeWidth={2.2} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
          {node.title || t("step_n", { n: node.number ?? "" })}
        </span>
        <span className="shrink-0 text-[11px] text-ink-4">
          {t("step_n", { n: node.number ?? "" })}
        </span>
      </div>
      <div className="space-y-2 px-3 pb-3 pt-2">
        {(node.group || node.waits) && (
          <div className="flex flex-wrap gap-1">
            {node.group && (
              <Badge tone="outline">
                {t("stage")} · {node.group}
              </Badge>
            )}
            {node.waits && <Badge tone="wait">{t("waits")}</Badge>}
          </div>
        )}
        {node.text && (
          <p className="line-clamp-3 text-xs leading-5 text-ink-3">{plain(node.text)}</p>
        )}
        {node.items.length > 0 && (
          <ul className="space-y-1">
            {node.items.map((item, index) => (
              <li key={index} className="rounded-lg bg-canvas px-2 py-1.5">
                <div className="flex flex-wrap items-center gap-1">
                  {item.roles.map((role) => (
                    <RoleChip key={role} name={role} />
                  ))}
                  {item.params.map((param) => (
                    <Badge key={param} tone="outline">
                      × {param}
                    </Badge>
                  ))}
                </div>
                {!item.roles.length && (
                  <p className="line-clamp-2 text-[11px] text-ink-3">{plain(item.text)}</p>
                )}
              </li>
            ))}
          </ul>
        )}
        {(node.roles.length > 0 || runsLoop) && (
          <div className="flex flex-wrap gap-1">
            {node.roles
              .filter((role) => !node.items.some((item) => item.roles.includes(role)))
              .map((role) => (
                <RoleChip key={role} name={role} />
              ))}
            {node.loops.map((loop) => (
              <Badge key={loop} tone="loop">
                <Workflow size={11} /> {loop}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function StartNode({ data }: NodeProps<EdgeNodeType>) {
  const { t } = useLang();
  return (
    <div
      className={cx(
        "flex h-10 w-[140px] items-center justify-center gap-2 rounded-full border border-line bg-panel text-[13px] font-medium text-ink-2 shadow-card",
        data.referenced && "ring-2 ring-brand-500 ring-offset-2 ring-offset-canvas",
      )}
    >
      <Handle type="source" position={Position.Bottom} id="out" className={hidden} />
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-ok-600 text-white">
        <Play size={11} fill="currentColor" />
      </span>
      {t("start")}
    </div>
  );
}

export function EndNode({ data }: NodeProps<EdgeNodeType>) {
  const { t } = useLang();
  return (
    <div
      className={cx(
        "flex h-10 w-[140px] items-center justify-center gap-2 rounded-full border border-line bg-panel text-[13px] font-medium text-ink-2 shadow-card",
        data.referenced && "ring-2 ring-brand-500 ring-offset-2 ring-offset-canvas",
      )}
    >
      <Handle type="target" position={Position.Top} id="in" className={hidden} />
      <Handle type="target" position={Position.Left} id="back-in" className={hidden} />
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-ink-4 text-white">
        <Flag size={11} />
      </span>
      {t("end")}
    </div>
  );
}

export function ParamNode({ data }: NodeProps<ParamNodeType>) {
  const { t } = useLang();
  const { param, referenced } = data;
  const changed =
    param.value !== undefined && JSON.stringify(param.value) !== JSON.stringify(param.default);
  const range =
    param.min !== undefined || param.max !== undefined
      ? `${param.min ?? "…"} – ${param.max ?? "…"}`
      : param.choices?.join(" / ");
  return (
    <div
      title={param.description}
      className={cx(
        "w-[230px] rounded-xl border border-dashed border-line-strong bg-panel/90 px-3 py-2.5 shadow-card",
        referenced && "ring-2 ring-brand-500 ring-offset-2 ring-offset-canvas",
      )}
    >
      <Handle type="source" position={Position.Left} id="out" className={hidden} />
      <div className="flex items-center gap-1.5">
        <SlidersHorizontal size={13} className="shrink-0 text-ink-3" />
        <span className="truncate font-mono text-[12px] font-semibold text-ink">{param.name}</span>
      </div>
      <div className="mt-1.5 flex items-baseline gap-2 text-xs">
        {param.value !== undefined && (
          <span className={cx("font-semibold", changed ? "text-wait-600" : "text-ink")}>
            {t("param_value")} {formatValue(param.value)}
          </span>
        )}
        <span className="text-ink-4">
          {t("param_default")} {formatValue(param.default)}
        </span>
        {range && <span className="ml-auto text-ink-4">{range}</span>}
      </div>
      <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-ink-3">{param.description}</p>
    </div>
  );
}

export const nodeTypes = { step: StepNode, start: StartNode, end: EndNode, param: ParamNode };
