/**
 * How a session's rows are shown: runs of tool calls folded into one row that
 * says what they did, a loop's run on a card of its own, and a finished turn's
 * work folded under its last words. The rules follow Paseo's chat
 * (https://github.com/getpaseo/paseo, Apache-2.0): group consecutive tool calls
 * of a turn, fold a turn only once it is finished, keep its last message open.
 */
import type { TimelineItem } from "../../../src/tools/studio-types.js";

export type ToolItem = Extract<TimelineItem, { kind: "tool" }>;
export type WorkItem = ToolItem | Extract<TimelineItem, { kind: "thinking" }>;

export type Row =
  | { type: "item"; item: TimelineItem }
  | { type: "loop"; item: ToolItem }
  | { type: "group"; id: string; items: WorkItem[]; running: boolean }
  | { type: "fold"; id: string; rows: Row[]; items: WorkItem[] };

/** What a stretch of work did, counted: files edited and read once each, however often. */
export interface WorkSummary {
  edited: number;
  commands: number;
  read: number;
  searches: number;
  other: number;
  thoughts: number;
}
export function summarize(items: WorkItem[]): WorkSummary {
  const edited = new Set<string>();
  const read = new Set<string>();
  const summary: WorkSummary = {
    edited: 0,
    commands: 0,
    read: 0,
    searches: 0,
    other: 0,
    thoughts: 0,
  };
  for (const item of items) {
    if (item.kind === "thinking") summary.thoughts += 1;
    else if (item.tool === "edit" || item.tool === "write") edited.add(item.summary);
    else if (item.tool === "shell") summary.commands += 1;
    else if (item.tool === "read") read.add(item.summary);
    else if (item.tool === "search") summary.searches += 1;
    else summary.other += 1;
  }
  return { ...summary, edited: edited.size, read: read.size };
}

const isWork = (item: TimelineItem): item is WorkItem =>
  item.kind === "thinking" || (item.kind === "tool" && item.tool !== "workflow");

/** The rows of a conversation: consecutive work of one turn grouped, a loop's run a card of its own. */
export function groupRows(items: TimelineItem[]): Row[] {
  const rows: Row[] = [];
  let run: WorkItem[] = [];
  const close = () => {
    if (!run.length) return;
    // One step alone is its own row; more are a group.
    if (run.length === 1) rows.push({ type: "item", item: run[0]! });
    else
      rows.push({
        type: "group",
        id: run[0]!.id,
        items: run,
        running: run.some((item) => item.kind === "tool" && item.status === "running"),
      });
    run = [];
  };
  for (const item of items) {
    if (item.kind === "tool" && item.tool === "workflow") {
      close();
      rows.push({ type: "loop", item });
    } else if (isWork(item)) {
      if (run.length && run[0]!.turn !== item.turn) close();
      run.push(item);
    } else {
      close();
      rows.push({ type: "item", item });
    }
  }
  close();
  return rows;
}

/**
 * Fold each finished turn: what it did before its last words goes under one row,
 * which opens. What the owner and the Studio said, a loop's card, errors and the
 * turn's end stay in view; the turn still going on is never folded.
 */
export function foldTurns(rows: Row[], openTurn: number | null): Row[] {
  const turnOf = (row: Row): number =>
    row.type === "fold" ? -1 : row.type === "group" ? row.items[0]!.turn : row.item.turn;
  const out: Row[] = [];
  let index = 0;
  while (index < rows.length) {
    const turn = turnOf(rows[index]!);
    let end = index;
    while (end < rows.length && turnOf(rows[end]!) === turn) end += 1;
    const inTurn = rows.slice(index, end);
    index = end;
    const finished =
      turn !== openTurn &&
      inTurn.some((row) => row.type === "item" && row.item.kind === "turn-end");
    if (!finished) {
      out.push(...inTurn);
      continue;
    }
    // Notices stay: an error, or the retries the session went through, tell what happened.
    const kept = (row: Row) =>
      row.type === "loop" ||
      (row.type === "item" &&
        (row.item.kind === "prompt" ||
          row.item.kind === "owner" ||
          row.item.kind === "turn-end" ||
          row.item.kind === "notice"));
    let last = -1;
    inTurn.forEach((row, at) => {
      if (row.type === "item" && row.item.kind === "text") last = at;
    });
    const folded: Row[] = [];
    const flush = () => {
      if (!folded.length) return;
      const items = folded.flatMap((row) =>
        row.type === "group"
          ? row.items
          : row.type === "item" && isWork(row.item)
            ? [row.item]
            : [],
      );
      // Only what did some work is folded: a lone message stays in view.
      if (!items.length) out.push(...folded);
      else
        out.push({
          type: "fold",
          id: `fold:${turnOfRow(folded[0]!)}:${out.length}`,
          rows: [...folded],
          items,
        });
      folded.length = 0;
    };
    inTurn.forEach((row, at) => {
      if (kept(row) || at === last || at > last) {
        flush();
        out.push(row);
      } else folded.push(row);
    });
    flush();
  }
  return out;
}
const turnOfRow = (row: Row): string =>
  row.type === "group" ? row.id : row.type === "fold" ? row.id : row.item.id;

/** How long something took, as a person says it: 45s, 3m 05s, 1h 02m. */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
