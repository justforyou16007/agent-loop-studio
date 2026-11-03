import dagre from "@dagrejs/dagre";
import type { Flow } from "../../../src/tools/studio-types.js";

export interface Size {
  width: number;
  height: number;
}
export interface Point {
  x: number;
  y: number;
}
export const paramId = (name: string): string => `p:${name}`;
/** Arrows drawn around the side of the column: back to an earlier step, or out to the end on a condition. */
export const aside = (edge: Flow["edges"][number]): boolean =>
  edge.kind === "back" || (edge.kind === "end" && edge.label !== "");

/**
 * Where each box goes: the steps top to bottom along the ways forward (arrows
 * back are drawn around the side), the parameters in a column to their right,
 * each beside the steps it affects.
 */
export function layoutFlow(flow: Flow, size: (id: string) => Size): Map<string, Point> {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "TB", nodesep: 56, ranksep: 64, marginx: 24, marginy: 24 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of flow.nodes) graph.setNode(node.id, { ...size(node.id) });
  for (const edge of flow.edges)
    if (!aside(edge) && edge.from !== edge.to) graph.setEdge(edge.from, edge.to);
  dagre.layout(graph);

  const positions = new Map<string, Point>();
  let right = 0;
  for (const node of flow.nodes) {
    const placed = graph.node(node.id) as { x: number; y: number; width: number; height: number };
    positions.set(node.id, { x: placed.x - placed.width / 2, y: placed.y - placed.height / 2 });
    right = Math.max(right, placed.x + placed.width / 2);
  }

  const column = right + 140;
  const wanted = flow.params.map((param) => {
    const centres = param.links
      .map((id) => {
        const at = positions.get(id);
        return at ? at.y + size(id).height / 2 : null;
      })
      .filter((value): value is number => value !== null);
    const centre = centres.length ? centres.reduce((a, b) => a + b, 0) / centres.length : 0;
    return { id: paramId(param.name), y: centre - size(paramId(param.name)).height / 2 };
  });
  wanted.sort((a, b) => a.y - b.y);
  let floor = -Infinity;
  for (const entry of wanted) {
    const y = Math.max(entry.y, floor);
    positions.set(entry.id, { x: column, y });
    floor = y + size(entry.id).height + 16;
  }
  return positions;
}
