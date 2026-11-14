#!/usr/bin/env node
/**
 * Each role's memory: an LLM wiki in `memory/<role>/` that the role queries
 * before it works (when its frontmatter says `memory: on`) and that
 * `project-memory` writes, inserting and updating entries from what runs show.
 * Knowledge lives here, not in role files, which hold only the process.
 *
 * An entry is know-how (a way that worked), a lesson (a way that failed, and
 * why) or a fact, for the kinds of task it names, with its evidence. Every write
 * is an event in `events.jsonl`, appended under a lock and chained to the one
 * before it by its hash, so a hand edit shows; the pages (`pages/<id>.md`), the
 * index and the log are made again from the events, and nobody edits them. Keys
 * and tokens are refused; an entry whose text reads like an injection stays on
 * disk but no query returns it.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCli, runCli } from "../lib/cli.js";
import { canonicalJsonSha256 } from "./canonical-json.js";
import { keyShapesIn } from "./secrets.js";
import { withStateFileLock, writeStateFileAtomic } from "./state-file.js";
import { scanForThreats } from "./threat-scan.js";
import { failA1, isRecord } from "./validate.js";

export const MEMORY_KINDS = ["know-how", "lesson", "fact"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  title: string;
  /** The kinds of task it applies to, a few words each. */
  tasks: string[];
  body: string;
  /** Where it comes from: runs, files, results. */
  evidence: string[];
  status: "current" | "superseded";
  /** The entry that replaces it, once superseded. */
  superseded_by: string | null;
  added: string;
  updated: string;
}
/** What a write gives: an entry's fields, as `insert` and `update` take them. */
export interface MemoryFields {
  kind?: string;
  title?: string;
  tasks?: string[];
  body?: string;
  evidence?: string[];
  status?: string;
  superseded_by?: string | null;
}
interface MemoryEvent {
  schema_version: 1;
  seq: number;
  at: string;
  type: "insert" | "update";
  /** The entry inserted, or its id and the fields an update sets (its evidence is added). */
  entry: Record<string, unknown>;
  previous: string | null;
  hash: string;
}

const ROLE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
/** What a query returns at most, unless asked for more: enough to read before a step, no more. */
const QUERY_CHARS = 6000;

export function memoryDir(root: string, role: string): string {
  if (!ROLE.test(role))
    failA1("INVALID_VALUE", `a role's name is lowercase words joined by hyphens, not "${role}"`);
  return path.join(path.resolve(root), "memory", role);
}
const eventsFile = (dir: string): string => path.join(dir, "events.jsonl");

/** An entry's id from its title, lowercase words joined by hyphens; a title with none gets one from its hash. */
export function slugOf(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || `entry-${crypto.createHash("sha256").update(title).digest("hex").slice(0, 10)}`;
}

const hashOf = (event: Omit<MemoryEvent, "hash">): string => canonicalJsonSha256(event);

/** A role's events, each checked against the one before it: an edit by hand fails here. */
function readEvents(dir: string): MemoryEvent[] {
  const file = eventsFile(dir);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  // A last line without its newline is a write that never finished: it is not an event.
  lines.pop();
  const events: MemoryEvent[] = [];
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    let event: MemoryEvent;
    try {
      event = JSON.parse(line) as MemoryEvent;
    } catch {
      failA1("MEMORY_CORRUPT", `line ${index + 1} is not JSON`, file);
    }
    const { hash, ...rest } = event;
    const previous = events.length ? events[events.length - 1]!.hash : null;
    if (rest.seq !== events.length + 1 || rest.previous !== previous || hashOf(rest) !== hash)
      failA1(
        "MEMORY_CORRUPT",
        `line ${index + 1} was changed by hand: a memory changes only through memory.js`,
        file,
      );
    events.push(event);
  });
  return events;
}

/** The entries a role's memory holds, from its events. */
function replay(events: readonly MemoryEvent[]): Map<string, MemoryEntry> {
  const entries = new Map<string, MemoryEntry>();
  for (const event of events) {
    const id = String(event.entry.id);
    if (event.type === "insert") {
      entries.set(id, { ...(event.entry as unknown as MemoryEntry) });
      continue;
    }
    const known = entries.get(id);
    if (!known) continue;
    const { evidence, ...fields } = event.entry;
    Object.assign(known, fields, { updated: event.at });
    if (Array.isArray(evidence)) known.evidence = [...known.evidence, ...evidence.map(String)];
  }
  return entries;
}

function pageOf(entry: MemoryEntry): string {
  return [
    "---",
    `id: ${entry.id}`,
    `kind: ${entry.kind}`,
    `tasks: ${entry.tasks.join(", ")}`,
    `status: ${entry.status}`,
    ...(entry.superseded_by ? [`superseded_by: ${entry.superseded_by}`] : []),
    `added: ${entry.added}`,
    `updated: ${entry.updated}`,
    "---",
    "",
    `# ${entry.title}`,
    "",
    entry.body.trim(),
    "",
    "## Evidence",
    "",
    ...(entry.evidence.length ? entry.evidence.map((item) => `- ${item}`) : ["- none recorded"]),
    "",
  ].join("\n");
}

/** The pages, the index and the log, made again from the events. */
function project(dir: string, events: readonly MemoryEvent[]): void {
  const entries = [...replay(events).values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  const pages = path.join(dir, "pages");
  fs.mkdirSync(pages, { recursive: true });
  const wanted = new Set(entries.map((entry) => `${entry.id}.md`));
  for (const file of fs.readdirSync(pages))
    if (!wanted.has(file)) fs.rmSync(path.join(pages, file));
  for (const entry of entries)
    writeStateFileAtomic(path.join(pages, `${entry.id}.md`), pageOf(entry));
  const line = (entry: MemoryEntry) =>
    `- [${entry.title}](pages/${entry.id}.md) — ${entry.kind}${entry.tasks.length ? `; ${entry.tasks.join(", ")}` : ""}; ${entry.updated.slice(0, 10)}${entry.superseded_by ? `; superseded by ${entry.superseded_by}` : ""}`;
  const current = entries.filter((entry) => entry.status === "current");
  const superseded = entries.filter((entry) => entry.status !== "current");
  writeStateFileAtomic(
    path.join(dir, "index.md"),
    [
      `# Memory of ${path.basename(dir)}`,
      "",
      "Made from events.jsonl by memory.js: it changes only through memory.js.",
      "",
      ...(current.length ? current.map(line) : ["Nothing yet."]),
      ...(superseded.length ? ["", "## Superseded", "", ...superseded.map(line)] : []),
      "",
    ].join("\n"),
  );
  writeStateFileAtomic(
    path.join(dir, "log.md"),
    [
      "# Log",
      "",
      ...events.map((event) => `- ${event.at} ${event.type} ${String(event.entry.id)}`),
      "",
    ].join("\n"),
  );
}

const strings = (value: unknown, what: string): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    failA1("INVALID_VALUE", `${what} is a list of text`);
  return (value as string[]).map((item) => item.trim()).filter(Boolean);
};
/** The fields a write sets, checked: known kinds and statuses, no keys or tokens. */
function checkedFields(fields: MemoryFields, insert: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (fields.kind !== undefined || insert) {
    if (!(MEMORY_KINDS as readonly string[]).includes(String(fields.kind)))
      failA1("INVALID_VALUE", `an entry's kind is one of ${MEMORY_KINDS.join(", ")}`);
    out.kind = fields.kind;
  }
  for (const key of ["title", "body"] as const)
    if (fields[key] !== undefined || insert) {
      const text = typeof fields[key] === "string" ? fields[key].trim() : "";
      if (!text) failA1("INVALID_VALUE", `an entry needs its ${key}`);
      out[key] = text;
    }
  if (fields.tasks !== undefined || insert) out.tasks = strings(fields.tasks, "tasks");
  if (fields.evidence !== undefined || insert) out.evidence = strings(fields.evidence, "evidence");
  if (fields.status !== undefined) {
    if (!["current", "superseded"].includes(fields.status))
      failA1("INVALID_VALUE", "an entry's status is current or superseded");
    out.status = fields.status;
  }
  if (fields.superseded_by !== undefined) {
    if (fields.superseded_by !== null && !ID.test(fields.superseded_by))
      failA1("INVALID_VALUE", "superseded_by names an entry by its id");
    out.superseded_by = fields.superseded_by;
  }
  const found = keyShapesIn(JSON.stringify(out));
  if (found.length)
    failA1(
      "SECRET_REFUSED",
      `a memory never holds keys or tokens, and this holds ${found.join(", ")}`,
    );
  return out;
}

/** Append one event to a role's memory, under its lock, and make its pages again. */
function append(
  root: string,
  role: string,
  make: (entries: Map<string, MemoryEntry>, at: string) => Pick<MemoryEvent, "type" | "entry">,
): MemoryEntry {
  const dir = memoryDir(root, role);
  fs.mkdirSync(dir, { recursive: true });
  const file = eventsFile(dir);
  return withStateFileLock(file, () => {
    // A write that never finished leaves a last line without its newline: it goes before the next.
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, "utf8");
      if (text && !text.endsWith("\n"))
        fs.writeFileSync(file, text.slice(0, text.lastIndexOf("\n") + 1));
    }
    const events = readEvents(dir);
    const at = new Date().toISOString();
    const { type, entry } = make(replay(events), at);
    const base: Omit<MemoryEvent, "hash"> = {
      schema_version: 1,
      seq: events.length + 1,
      at,
      type,
      entry,
      previous: events.length ? events[events.length - 1]!.hash : null,
    };
    const event: MemoryEvent = { ...base, hash: hashOf(base) };
    const fd = fs.openSync(file, "a");
    try {
      fs.writeSync(fd, `${JSON.stringify(event)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const all = [...events, event];
    project(dir, all);
    return replay(all).get(String(entry.id))!;
  });
}

/** Add an entry to a role's memory; its id comes from its title unless given. */
export function insertMemory(
  root: string,
  role: string,
  fields: MemoryFields & { id?: string },
): MemoryEntry {
  const values = checkedFields(fields, true);
  const id = fields.id ?? slugOf(String(values.title));
  if (!ID.test(id)) failA1("INVALID_VALUE", "an entry's id is lowercase words joined by hyphens");
  return append(root, role, (entries, at) => {
    if (entries.has(id))
      failA1("ALREADY_EXISTS", `the memory of ${role} already has ${id}: update it instead`);
    return {
      type: "insert",
      entry: { id, ...values, status: "current", superseded_by: null, added: at, updated: at },
    };
  });
}

/** Change an entry: the fields given replace its own, and evidence given is added to its own. */
export function updateMemory(
  root: string,
  role: string,
  id: string,
  fields: MemoryFields,
): MemoryEntry {
  const values = checkedFields(fields, false);
  if (!Object.keys(values).length) failA1("INVALID_VALUE", "an update sets at least one field");
  return append(root, role, (entries) => {
    if (!entries.has(id)) failA1("NOT_FOUND", `the memory of ${role} has no entry ${id}`);
    return { type: "update", entry: { id, ...values } };
  });
}

/** Lowercase words, and two-character pieces of Chinese, Japanese or Korean, to match entries by. */
function termsOf(text: string): string[] {
  const out = new Set<string>();
  for (const word of text.toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? [])
    if (word.length > 1) out.add(word);
  for (const run of text.match(/[぀-ヿ㐀-鿿가-힯]+/g) ?? []) {
    if (run.length === 1) out.add(run);
    for (let index = 0; index + 2 <= run.length; index += 1) out.add(run.slice(index, index + 2));
  }
  return [...out];
}

export interface MemoryQuery {
  role: string;
  task: string;
  /** The entries that apply, best first, within the budget. */
  entries: Omit<MemoryEntry, "status" | "superseded_by">[];
  /** How many more apply than fit the budget. */
  more: number;
  /** Entries that read like an injection: kept on disk, never returned. */
  flagged: string[];
}
/**
 * The current entries of a role's memory for a kind of task, best match first:
 * a word of the task in an entry's tasks counts most, then in its title, then in
 * its text. With no task, or `all`, every current entry, newest first.
 */
export function queryMemory(
  root: string,
  role: string,
  task: string,
  options: { maxChars?: number; all?: boolean } = {},
): MemoryQuery {
  const dir = memoryDir(root, role);
  const terms = termsOf(task);
  const scoreOf = (entry: MemoryEntry): number => {
    const tasks = entry.tasks.join(" ").toLowerCase();
    const title = entry.title.toLowerCase();
    const body = entry.body.toLowerCase();
    return terms.reduce(
      (score, term) =>
        score +
        (tasks.includes(term) ? 3 : 0) +
        (title.includes(term) ? 2 : 0) +
        (body.includes(term) ? 1 : 0),
      0,
    );
  };
  const flagged: string[] = [];
  const ranked = [...replay(readEvents(dir)).values()]
    .filter((entry) => entry.status === "current")
    .filter((entry) => {
      const text = [entry.title, entry.body, ...entry.tasks, ...entry.evidence].join("\n");
      if (!scanForThreats(text, "strict").length) return true;
      flagged.push(entry.id);
      return false;
    })
    .map((entry) => ({ entry, score: scoreOf(entry) }))
    .filter(({ score }) => options.all || !terms.length || score > 0)
    .sort((a, b) => b.score - a.score || (a.entry.updated < b.entry.updated ? 1 : -1));
  const budget = options.maxChars ?? QUERY_CHARS;
  const entries: MemoryQuery["entries"] = [];
  let used = 0;
  for (const { entry } of ranked) {
    const { status: _status, superseded_by: _by, ...shown } = entry;
    const size = JSON.stringify(shown).length;
    if (entries.length && used + size > budget) break;
    entries.push(shown);
    used += size;
  }
  return { role, task, entries, more: ranked.length - entries.length, flagged };
}

/** The roles that have a memory, with how many current entries each holds. */
export function memoryRoles(root: string): { role: string; entries: number }[] {
  const base = path.join(path.resolve(root), "memory");
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && ROLE.test(entry.name))
    .filter((entry) => fs.existsSync(eventsFile(path.join(base, entry.name))))
    .map((entry) => ({
      role: entry.name,
      entries: [...replay(readEvents(path.join(base, entry.name))).values()].filter(
        (known) => known.status === "current",
      ).length,
    }))
    .sort((a, b) => (a.role < b.role ? -1 : 1));
}

/** Make a role's pages again from its events, after checking them. */
export function rebuildMemory(root: string, role: string): { role: string; events: number } {
  const dir = memoryDir(root, role);
  const events = withStateFileLock(eventsFile(dir), () => {
    const read = readEvents(dir);
    project(dir, read);
    return read;
  });
  return { role, events: events.length };
}

/** The seed entries a draft carries for a role: one JSON object per line, as `insert` takes them. */
export function readSeeds(file: string): (MemoryFields & { id?: string })[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line, index) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        failA1("INVALID_VALUE", `line ${index + 1} is not JSON`, file);
      }
      if (!isRecord(parsed)) failA1("INVALID_VALUE", `line ${index + 1} is not an entry`, file);
      checkedFields(parsed as MemoryFields, true);
      return parsed as MemoryFields & { id?: string };
    });
}

function cli(): void {
  const program = createCli("memory", "Each role's memory: query it, insert and update entries");
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  const failed = (error: unknown) => {
    console.error(
      JSON.stringify(
        {
          status: "failed",
          reason: (error as { code?: string }).code ?? "memory_failed",
          message: (error as Error).message,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  };
  const list = (value: string, previous: string[] = []) => [...previous, value];
  const words = (value?: string) =>
    value === undefined
      ? undefined
      : value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
  program
    .command("query")
    .description("What a role's memory holds for a kind of task, best match first")
    .requiredOption("--project <dir>")
    .requiredOption("--role <role>")
    .option("--task <words>", "the kind of task, in a few words", "")
    .option("--max-chars <n>", "how much to return at most", String(QUERY_CHARS))
    .option("--all", "every current entry, whatever the task")
    .action(
      (options: {
        project: string;
        role: string;
        task: string;
        maxChars: string;
        all?: boolean;
      }) => {
        try {
          print(
            queryMemory(options.project, options.role, options.task, {
              maxChars: Number(options.maxChars) || QUERY_CHARS,
              all: Boolean(options.all),
            }),
          );
        } catch (error) {
          failed(error);
        }
      },
    );
  program
    .command("insert")
    .description("Add an entry to a role's memory")
    .requiredOption("--project <dir>")
    .requiredOption("--role <role>")
    .requiredOption("--kind <kind>", MEMORY_KINDS.join(", "))
    .requiredOption("--title <title>")
    .requiredOption("--body <text>")
    .option("--tasks <a,b>", "the kinds of task it applies to")
    .option("--evidence <text>", "where it comes from (repeat for more)", list)
    .option("--id <id>", "its id (from its title otherwise)")
    .action(
      (options: {
        project: string;
        role: string;
        kind: string;
        title: string;
        body: string;
        tasks?: string;
        evidence?: string[];
        id?: string;
      }) => {
        try {
          print(
            insertMemory(options.project, options.role, {
              kind: options.kind,
              title: options.title,
              body: options.body,
              tasks: words(options.tasks) ?? [],
              evidence: options.evidence ?? [],
              ...(options.id ? { id: options.id } : {}),
            }),
          );
        } catch (error) {
          failed(error);
        }
      },
    );
  program
    .command("update")
    .description("Change an entry: the fields given replace its own; evidence given is added")
    .requiredOption("--project <dir>")
    .requiredOption("--role <role>")
    .requiredOption("--id <id>")
    .option("--kind <kind>")
    .option("--title <title>")
    .option("--body <text>")
    .option("--tasks <a,b>")
    .option("--evidence <text>", "evidence to add (repeat for more)", list)
    .option("--status <status>", "current or superseded")
    .option("--superseded-by <id>", "the entry that replaces it")
    .action(
      (options: {
        project: string;
        role: string;
        id: string;
        kind?: string;
        title?: string;
        body?: string;
        tasks?: string;
        evidence?: string[];
        status?: string;
        supersededBy?: string;
      }) => {
        try {
          print(
            updateMemory(options.project, options.role, options.id, {
              ...(options.kind !== undefined ? { kind: options.kind } : {}),
              ...(options.title !== undefined ? { title: options.title } : {}),
              ...(options.body !== undefined ? { body: options.body } : {}),
              ...(options.tasks !== undefined ? { tasks: words(options.tasks) } : {}),
              ...(options.evidence !== undefined ? { evidence: options.evidence } : {}),
              ...(options.status !== undefined ? { status: options.status } : {}),
              ...(options.supersededBy !== undefined
                ? { superseded_by: options.supersededBy }
                : {}),
            }),
          );
        } catch (error) {
          failed(error);
        }
      },
    );
  program
    .command("list")
    .description("The roles that have a memory, or one role's current entries")
    .requiredOption("--project <dir>")
    .option("--role <role>")
    .action((options: { project: string; role?: string }) => {
      try {
        print(
          options.role
            ? queryMemory(options.project, options.role, "", { all: true, maxChars: Infinity })
            : memoryRoles(options.project),
        );
      } catch (error) {
        failed(error);
      }
    });
  program
    .command("rebuild")
    .description("Make a role's pages, index and log again from its events")
    .requiredOption("--project <dir>")
    .requiredOption("--role <role>")
    .action((options: { project: string; role: string }) => {
      try {
        print(rebuildMemory(options.project, options.role));
      } catch (error) {
        failed(error);
      }
    });
  runCli(program);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli();
