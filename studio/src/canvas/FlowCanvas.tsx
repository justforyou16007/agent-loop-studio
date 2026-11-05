import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  useStore,
  type Edge,
  type Node,
} from "@xyflow/react";
import { useEffect, useMemo, useRef } from "react";
import type { Flow, FlowNode } from "../../../src/tools/studio-types.js";
import { useLang } from "../i18n.js";
import type { Focus, Pointable, Reference } from "../types.js";
import { aside, layoutFlow, paramId, type Size } from "./layout.js";
import { nodeTypes, type ParamData, type StepData } from "./nodes.js";

const GRAY = "#98a2b3";
const BRAND = "#3b6ff5";
const WAIT = "#f38744";

type Translate = ReturnType<typeof useLang>["t"];

export function nodeLabel(node: FlowNode, t: Translate): string {
  if (node.kind === "start") return t("start");
  if (node.kind === "end") return t("end");
  return `${t("step_n", { n: node.number ?? "" })}${node.title ? ` · ${node.title}` : ""}`;
}

/** An arrow, as the owner points at it: from which box to which. */
export function edgeLabel(flow: Flow, id: string, t: Translate): string {
  const edge = flow.edges.find((entry) => entry.id === id);
  if (!edge) return id;
  const from = flow.nodes.find((node) => node.id === edge.from);
  const to = flow.nodes.find((node) => node.id === edge.to);
  return t("edge_ref", {
    from: from ? nodeLabel(from, t) : edge.from,
    to: to ? nodeLabel(to, t) : edge.to,
  });
}

/** Everything on the canvas the owner can point at in the chat, named as clicking it names it. */
export function pointablesOf(flow: Flow, t: Translate): Pointable[] {
  return [
    ...flow.nodes.map((node) => ({
      kind: "node" as const,
      id: node.id,
      label: nodeLabel(node, t),
      detail: "",
    })),
    ...flow.params.map((param) => ({
      kind: "param" as const,
      id: paramId(param.name),
      label: param.name,
      detail: param.description,
    })),
    ...flow.edges.map((edge) => ({
      kind: "edge" as const,
      id: edge.id,
      label: edgeLabel(flow, edge.id, t),
      detail: edge.label,
    })),
  ];
}

/**
 * The boxes and arrows a focus lights up on this flow, the rest to be greyed:
 * empty when the flow has none of it.
 */
export function focusedIds(flow: Flow, focus: Focus): Set<string> {
  const ids = new Set<string>();
  if (focus.kind === "pointer") {
    const { reference } = focus;
    const edge = flow.edges.find((entry) => entry.id === reference.id);
    const param = flow.params.find((entry) => paramId(entry.name) === reference.id);
    if (edge) for (const id of [edge.id, edge.from, edge.to]) ids.add(id);
    else if (param) for (const id of [reference.id, ...param.links]) ids.add(id);
    else if (flow.nodes.some((node) => node.id === reference.id)) ids.add(reference.id);
    return ids;
  }
  for (const node of flow.nodes) {
    const lit =
      focus.kind === "role"
        ? node.roles.includes(focus.name) ||
          node.items.some((item) => item.roles.includes(focus.name))
        : focus.kind === "step"
          ? node.title === focus.name
          : node.loops.includes(focus.name) ||
            (focus.name === flow.loop.name && node.kind === "step");
    if (lit) ids.add(node.id);
  }
  return ids;
}

interface CanvasProps {
  flow: Flow;
  /** A preview only shows: no pointing, no inspector. */
  preview?: boolean;
  referenced?: Set<string>;
  selected?: string | null;
  onReference?: (reference: Reference) => void;
  onSelect?: (id: string | null) => void;
  /** Steps of the loop running now, by title: going on, or done. */
  activity?: Map<string, "running" | "done">;
  /** What the chat points out: these boxes and arrows stay lit, the rest is greyed. */
  focus?: Set<string> | null;
  onClearFocus?: () => void;
}

export function FlowCanvas(props: CanvasProps) {
  // Another loop, or the same one changed (a draft installed, say), is laid out afresh: the boxes are made once.
  const version = useMemo(() => JSON.stringify(props.flow), [props.flow]);
  return (
    <ReactFlowProvider>
      <Canvas key={version} {...props} />
    </ReactFlowProvider>
  );
}

function fallbackSize(node: Node): Size {
  if (node.type === "param") return { width: 230, height: 90 };
  if (node.type === "start" || node.type === "end") return { width: 140, height: 40 };
  return { width: 300, height: 140 };
}

function Canvas({
  flow,
  preview = false,
  referenced,
  selected = null,
  onReference,
  onSelect,
  activity,
  focus = null,
  onClearFocus,
}: CanvasProps) {
  const { t } = useLang();
  const initial = useMemo<Node[]>(
    () => [
      ...flow.nodes.map(
        (node, index): Node<StepData> => ({
          id: node.id,
          type: node.kind,
          position: { x: 0, y: index * 180 },
          data: { node, referenced: false, selected: false },
          draggable: !preview,
        }),
      ),
      ...flow.params.map(
        (param, index): Node<ParamData> => ({
          id: paramId(param.name),
          type: "param",
          position: { x: 420, y: index * 110 },
          data: { param, referenced: false },
          draggable: !preview,
        }),
      ),
    ],
    [flow, preview],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(initial);
  const initialized = useNodesInitialized();
  const laidOut = useRef(false);
  const { getNodes, getNodesBounds, setViewport, fitView } = useReactFlow();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);

  // Lay the flow out once every box has been measured, then fit it into view.
  useEffect(() => {
    if (!initialized || laidOut.current) return;
    const measured = new Map(
      getNodes().map((node) => [
        node.id,
        node.measured?.width && node.measured?.height
          ? { width: node.measured.width, height: node.measured.height }
          : fallbackSize(node),
      ]),
    );
    const positions = layoutFlow(flow, (id) => measured.get(id) ?? { width: 300, height: 140 });
    setNodes((current) =>
      current.map((node) => ({ ...node, position: positions.get(node.id) ?? node.position })),
    );
    laidOut.current = true;
    // Readable from the top: the whole flow when it fits, otherwise its start at a zoom that can still be read.
    requestAnimationFrame(() => {
      const placed = getNodes();
      const bounds = getNodesBounds(placed);
      const fit = Math.min(width / (bounds.width + 80), height / (bounds.height + 80));
      const zoom = Math.min(1, Math.max(preview ? 0.55 : 0.72, fit));
      void setViewport({
        x: (width - bounds.width * zoom) / 2 - bounds.x * zoom,
        y:
          fit >= zoom
            ? (height - bounds.height * zoom) / 2 - bounds.y * zoom
            : 28 - bounds.y * zoom,
        zoom,
      });
    });
  }, [initialized, flow, getNodes, setNodes, setViewport, width, height, preview]);

  /** A box stays lit when nothing is pointed out, when it is, or, for a parameter, when a step it changes is. */
  const lit = (id: string): boolean =>
    !focus ||
    focus.has(id) ||
    flow.params.some(
      (param) => paramId(param.name) === id && param.links.some((link) => focus.has(link)),
    );
  useEffect(() => {
    setNodes((current) =>
      current.map((node) => ({
        ...node,
        data: {
          ...node.data,
          referenced: referenced?.has(node.id) ?? false,
          selected: selected === node.id,
          activity:
            node.type === "step"
              ? activity?.get(String((node.data as StepData).node.title))
              : undefined,
          focused: Boolean(focus?.has(node.id)),
          dimmed: !lit(node.id),
        },
      })),
    );
    // `lit` reads only flow and focus.
  }, [referenced, selected, activity, focus, flow, setNodes]);

  // What the chat points out is brought into view.
  const focusKey = focus ? [...focus].sort().join(" ") : "";
  useEffect(() => {
    if (!focus?.size || !laidOut.current) return;
    const boxes = [...focus].filter((id) => flow.nodes.some((node) => node.id === id));
    if (boxes.length)
      void fitView({ nodes: boxes.map((id) => ({ id })), duration: 350, padding: 0.4, maxZoom: 1 });
    // Only a new focus moves the view.
  }, [focusKey]);

  const edges = useMemo<Edge[]>(() => {
    // Arrows around the side each get their own lane, so they do not lie on top of one another.
    const lanes = new Map(flow.edges.filter(aside).map((edge, index) => [edge.id, index]));
    const out: Edge[] = flow.edges.map((edge) => {
      const color = edge.kind === "back" ? WAIT : edge.kind === "branch" ? BRAND : GRAY;
      const back = edge.kind === "back";
      const side = aside(edge);
      return {
        id: edge.id,
        source: edge.from,
        target: edge.to,
        sourceHandle: side ? "back-out" : "out",
        targetHandle: side ? "back-in" : "in",
        type: "smoothstep",
        label: edge.label || undefined,
        labelStyle: {
          fill: back ? WAIT : edge.kind === "branch" ? BRAND : "#667085",
          fontWeight: 500,
        },
        labelBgPadding: [6, 3] as [number, number],
        labelBgBorderRadius: 6,
        labelBgStyle: { fill: "#ffffff", stroke: "#eaecf0" },
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color },
        style: {
          stroke: color,
          strokeWidth: referenced?.has(edge.id) ? 2.5 : 1.5,
          strokeDasharray: back ? "6 4" : undefined,
        },
        pathOptions: { borderRadius: 14, offset: side ? 28 + (lanes.get(edge.id) ?? 0) * 16 : 20 },
        zIndex: back ? 0 : 1,
        // An arrow stays lit when it is pointed out, or runs between two lit boxes.
        className:
          focus && !(focus.has(edge.id) || (focus.has(edge.from) && focus.has(edge.to)))
            ? "opacity-15 transition-opacity"
            : "transition-opacity",
      };
    });
    for (const param of flow.params)
      for (const link of param.links)
        out.push({
          id: `${paramId(param.name)}->${link}`,
          source: paramId(param.name),
          target: link,
          sourceHandle: "out",
          targetHandle: "param",
          type: "default",
          style: { stroke: "#b9c0cc", strokeWidth: 1.25, strokeDasharray: "4 4" },
          selectable: false,
          focusable: false,
          className: focus && !focus.has(link) ? "opacity-15" : undefined,
        });
    return out;
  }, [flow, referenced, focus]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      nodesConnectable={false}
      edgesFocusable={!preview}
      elementsSelectable={!preview}
      minZoom={0.2}
      maxZoom={1.6}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, node) => {
        if (preview) return;
        if (node.type === "param") {
          const param = (node.data as ParamData).param;
          onReference?.({ kind: "param", id: node.id, label: param.name });
        } else onSelect?.(node.id);
      }}
      onEdgeClick={(_, edge) => {
        if (preview || edge.id.startsWith("p:")) return;
        onReference?.({ kind: "edge", id: edge.id, label: edgeLabel(flow, edge.id, t) });
      }}
      onPaneClick={() => {
        onSelect?.(null);
        onClearFocus?.();
      }}
    >
      <Background variant={BackgroundVariant.Dots} gap={16} size={1.3} color="#d0d5dd" />
      <Controls showInteractive={false} position="bottom-left" />
      {!preview && (
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          nodeColor={(node) => (node.type === "param" ? "#eaecf0" : "#c7d7fe")}
          maskColor="rgba(242,244,247,0.7)"
          style={{ width: 160, height: 110, borderRadius: 10, border: "1px solid #eaecf0" }}
        />
      )}
    </ReactFlow>
  );
}
