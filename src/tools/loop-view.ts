#!/usr/bin/env node
/**
 * The owner's view of a project's loops: a read-only page, served on this
 * machine or written as one self-contained HTML file. For each loop it shows
 * what its definition says (purpose, the steps and the roles that do them,
 * bounds, waiting points, the parameters with this project's values), whether
 * its script passes the loop check, the roles it calls, and its recent runs from
 * the trajectory index. It reads loop, role and trajectory-index files only: it
 * changes nothing, and never reads transcripts or a project's hidden data.
 * The page loads nothing from the network.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCli, runCli } from "../lib/cli.js";
import { installedLibrary, installedRole, libraryRoots } from "./installation.js";
import { checkLoop, splitScript, type LoopReport } from "./loop-check.js";
import { client } from "./loop-view-client.js";
import {
  frontmatter,
  listLoops,
  loopDefinitionPath,
  loopParameters,
  loopScriptPath,
  parseTriggers,
  rolesDir,
  selectedLoopPath,
  setupFinishedAt,
} from "./loops.js";
import { isRecord } from "./validate.js";

export interface StepView {
  kind: "step" | "note";
  number: number | null;
  title: string;
  text: string;
  roles: string[];
  loops: string[];
  group: string | null;
}
export interface ParameterView {
  name: string;
  type: string;
  default: unknown;
  min?: number;
  max?: number;
  choices?: string[];
  description: string;
  value?: unknown;
}
export interface RunView {
  id: string;
  started: string;
  ended: string;
  roles: { role: string; at: string }[];
  submissions: string[];
}
export interface LoopView {
  name: string;
  source: "project" | "library";
  side: string;
  kind: string;
  description: string;
  triggers: string[];
  chosen: boolean;
  parameters: ParameterView[];
  parameter_problem: string | null;
  purpose: string;
  steps: StepView[];
  sections: { title: string; markdown: string }[];
  roles: string[];
  children: string[];
  definition: string;
  script: string | null;
  check: LoopReport | null;
  runs: RunView[];
}
export interface RoleView {
  name: string;
  source: "project" | "library";
  side: string;
  description: string;
  tools: string;
  effort: string;
  body: string;
  used_by: string[];
}
export interface ViewData {
  project: {
    name: string;
    root: string;
    side: string;
    library: string | null;
    language: "zh" | "en";
    chosen: { loop: string; params: Record<string, unknown> } | null;
    /** When the project's setup loop last finished; null while the project is not set up. */
    setup_finished: string | null;
    generated_at: string;
    /** Served by the helper, so the page can reload it; false in a written snapshot. */
    live: boolean;
  };
  loops: LoopView[];
  roles: RoleView[];
}

const RUNS_SHOWN = 20;
const normal = (text: string): string => text.replace(/\r\n/g, "\n");
const readText = (file: string): string | null =>
  fs.existsSync(file) ? normal(fs.readFileSync(file, "utf8")) : null;
const readJson = (file: string): unknown => {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  } catch {
    return null;
  }
};
/** The side folders under a library's `loops/` or `roles/` (a placeholder file such as `.gitkeep` is not a side). */
const sideFolders = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : [];
const markdownFiles = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((file) => file.endsWith(".md"))
        .sort()
    : [];

/** A document without its frontmatter, split at its `## ` headings. */
export function sectionsOf(markdown: string): { title: string; body: string }[] {
  const text = normal(markdown).replace(/^---\n[\s\S]*?\n---\n?/, "");
  const sections: { title: string; lines: string[] }[] = [{ title: "", lines: [] }];
  for (const line of text.split("\n")) {
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading) sections.push({ title: heading[1]!.trim(), lines: [] });
    else sections.at(-1)!.lines.push(line);
  }
  return sections
    .map((section) => ({
      title: section.title,
      body: section.lines
        .filter((line) => !/^#\s/.test(line))
        .join("\n")
        .trim(),
    }))
    .filter((section) => section.title || section.body);
}

const backticked = (text: string, known: Set<string>): string[] => [
  ...new Set(
    [...text.matchAll(/`([a-z0-9][a-z0-9-]*)`/g)]
      .map((match) => match[1]!)
      .filter((name) => known.has(name)),
  ),
];
/** Remove the indentation the continuation lines of a list item share. */
function dedent(lines: string[]): string[] {
  const indents = lines.filter((line) => line.trim()).map((line) => /^\s*/.exec(line)![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(cut));
}

/**
 * The numbered steps of a definition's Steps section, with the roles and loops
 * each names in backticks; a `` `label`: `` line starts a group (such as a stage),
 * and other paragraphs between steps are notes.
 */
export function parseSteps(body: string, roles: Set<string>, loops: Set<string>): StepView[] {
  const steps: StepView[] = [];
  let current: (StepView & { rest: string[] }) | null = null;
  let group: string | null = null;
  const finish = () => {
    if (!current) return;
    const { rest, ...step } = current;
    step.text = [step.text, ...dedent(rest)].join("\n").trim();
    step.roles = backticked(`${step.title} ${step.text}`, roles);
    step.loops = backticked(step.text, loops);
    steps.push(step);
    current = null;
  };
  for (const line of normal(body).split("\n")) {
    const numbered = /^(\d+)\.\s+(.*)$/.exec(line);
    const label = /^`([^`]+)`:\s*$/.exec(line);
    if (numbered) {
      finish();
      const titled = /^\*\*(.+?)\*\*\s*(?:[—–-]+\s*)?(.*)$/.exec(numbered[2]!);
      current = {
        kind: "step",
        number: Number(numbered[1]),
        title: titled ? titled[1]! : "",
        text: titled ? titled[2]! : numbered[2]!,
        roles: [],
        loops: [],
        group,
        rest: [],
      };
    } else if (label) {
      finish();
      group = label[1]!;
    } else if (current && (/^\s+\S/.test(line) || !line.trim())) current.rest.push(line);
    else if (line.trim()) {
      finish();
      steps.push({
        kind: "note",
        number: null,
        title: "",
        text: line.trim(),
        roles: backticked(line, roles),
        loops: backticked(line, loops),
        group,
      });
    }
  }
  finish();
  return steps;
}

interface RoleFile {
  name: string;
  source: "project" | "library";
  text: string;
}
interface LoopFile {
  name: string;
  source: "project" | "library";
  definition: string;
  script: string | null;
}

/** The library the project was installed from, by side, for loops and roles the project lacks. */
function libraryFiles(roots: string[], side: string) {
  const loops: LoopFile[] = [];
  const roles: RoleFile[] = [];
  for (const library of roots) {
    // The framework's files and the project's own side's; without a profile, every side the library has.
    const present = fs.existsSync(path.join(library, "library", "loops"))
      ? sideFolders(path.join(library, "library", "loops"))
      : ["framework"];
    const sides = present.includes(side) ? ["framework", side] : present;
    for (const dir of sides) {
      const loopDir = path.join(library, "library", "loops", dir);
      for (const file of markdownFiles(loopDir))
        if (!loops.some((known) => known.name === file.slice(0, -3)))
          loops.push({
            name: file.slice(0, -3),
            source: "library",
            definition: readText(path.join(loopDir, file)) ?? "",
            script: readText(path.join(loopDir, `${file.slice(0, -3)}.js`)),
          });
      const roleDir = path.join(library, "library", "roles", dir);
      for (const file of markdownFiles(roleDir))
        if (!roles.some((known) => known.name === file.slice(0, -3)))
          roles.push({
            name: file.slice(0, -3),
            source: "library",
            text: readText(path.join(roleDir, file)) ?? "",
          });
    }
  }
  return { loops, roles };
}

/** The runs of each loop in the trajectory index: which roles finished in them, and when. */
function runsByLoop(root: string, names: Map<string, string>): Map<string, RunView[]> {
  const index = readText(path.join(root, ".contrejour", "trajectories", "index.jsonl"));
  const runs = new Map<string, Map<string, RunView>>();
  for (const line of (index ?? "").split("\n")) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry) || !Array.isArray(entry.workflows)) continue;
    const at = typeof entry.at === "string" ? entry.at : "";
    for (const workflow of entry.workflows) {
      if (!isRecord(workflow) || typeof workflow.id !== "string") continue;
      // The index names a run by its loop, or by the description its script declares.
      const loop = names.get(String(workflow.name ?? ""));
      if (!loop) continue;
      const loopRuns = runs.get(loop) ?? new Map<string, RunView>();
      runs.set(loop, loopRuns);
      const run = loopRuns.get(workflow.id) ?? {
        id: workflow.id,
        started: at,
        ended: at,
        roles: [],
        submissions: [],
      };
      if (at && (!run.started || at < run.started)) run.started = at;
      if (at > run.ended) run.ended = at;
      run.roles.push({ role: String(entry.agent_type ?? "unknown"), at });
      if (typeof entry.submission === "string" && !run.submissions.includes(entry.submission))
        run.submissions.push(entry.submission);
      loopRuns.set(workflow.id, run);
    }
  }
  return new Map(
    [...runs].map(([loop, byId]) => [
      loop,
      [...byId.values()].sort((a, b) => b.ended.localeCompare(a.ended)).slice(0, RUNS_SHOWN),
    ]),
  );
}

/** The language the owner writes the task in: Chinese when task.md has Chinese in it, or when there is no task yet. */
function projectLanguage(root: string): "zh" | "en" {
  const task = readText(path.join(root, "task.md"));
  if (task === null || !task.trim()) return "zh";
  return /[\u4e00-\u9fff]/.test(task) ? "zh" : "en";
}

interface LoopContext {
  root: string;
  roleNames: Set<string>;
  loopNames: Set<string>;
  chosen: { loop: string; params: Record<string, unknown> } | null;
  runs: Map<string, RunView[]>;
  /** Run the loop check on the project's own loops. */
  check: boolean;
}

/** One loop as the page shows it: what its definition says, its check, its runs. */
async function describeLoop(file: LoopFile, context: LoopContext): Promise<LoopView> {
  const { root, roleNames, loopNames, chosen, runs } = context;
  const fields = frontmatter(file.definition);
  const sections = sectionsOf(file.definition);
  const section = (title: string) => sections.find((entry) => entry.title === title)?.body ?? "";
  let parameters: ParameterView[] = [];
  let problem: string | null = null;
  try {
    parameters = loopParameters(file.definition);
  } catch (error) {
    problem = (error as Error).message;
  }
  const isChosen = file.source === "project" && chosen?.loop === file.name;
  if (isChosen && chosen)
    parameters = parameters.map((parameter) =>
      parameter.name in chosen.params
        ? { ...parameter, value: chosen.params[parameter.name] }
        : parameter,
    );
  const steps = parseSteps(section("Steps"), roleNames, loopNames);
  let check: LoopReport | null = null;
  if (file.source === "project" && context.check)
    try {
      check = await checkLoop(root, file.name);
    } catch (error) {
      check = {
        loop: file.name,
        ok: false,
        stale: false,
        roles_called: [],
        defects: [`the check could not run: ${(error as Error).message}`],
      };
    }
  const roles = [
    ...new Set([...steps.flatMap((step) => step.roles), ...(check?.roles_called ?? [])]),
  ];
  const children = [
    ...new Set([
      ...[...(file.script ?? "").matchAll(/\bworkflow\s*\(\s*(['"`])([^'"`]+)\1/g)].map(
        (match) => match[2]!,
      ),
      ...steps.flatMap((step) => step.loops),
    ]),
  ].filter((name) => name !== file.name);
  return {
    name: file.name,
    source: file.source,
    side: fields.side ?? "unknown",
    kind: fields.kind ?? "task",
    description: fields.description ?? "",
    triggers: parseTriggers(fields.triggers),
    chosen: isChosen,
    parameters,
    parameter_problem: problem,
    purpose: section("Purpose"),
    steps,
    sections: sections
      .filter((entry) => !["", "Purpose", "Steps", "Parameters"].includes(entry.title))
      .map((entry) => ({ title: entry.title, markdown: entry.body })),
    roles,
    children,
    definition: file.definition,
    script: file.script,
    check,
    runs: runs.get(file.name) ?? [],
  };
}

function describeRole(file: RoleFile, loops: LoopView[]): RoleView {
  const fields = frontmatter(file.text);
  return {
    name: file.name,
    source: file.source,
    side: fields.side ?? "unknown",
    description: fields.description ?? "",
    tools: fields.tools ?? "",
    effort: fields.effort ?? "",
    body: sectionsOf(file.text)
      .map((entry) => (entry.title ? `## ${entry.title}\n\n${entry.body}` : entry.body))
      .join("\n\n"),
    used_by: loops.filter((loop) => loop.roles.includes(file.name)).map((loop) => loop.name),
  };
}

/** Everything the page shows, read from the project (and its library) as it is now. */
export async function collectView(projectRoot: string, live = false): Promise<ViewData> {
  const root = path.resolve(projectRoot);
  let side = "unknown";
  let library: string | null = null;
  try {
    side = installedRole(root);
    library = installedLibrary(root);
  } catch {
    // A project that is not installed still shows the loops it has.
  }
  const chosenFile = readJson(selectedLoopPath(root));
  const chosen =
    isRecord(chosenFile) && typeof chosenFile.loop === "string" && isRecord(chosenFile.params)
      ? { loop: chosenFile.loop, params: chosenFile.params }
      : null;

  const extra = libraryFiles(library ? libraryRoots(root) : [], side);
  const roleFiles: RoleFile[] = markdownFiles(rolesDir(root)).map((file) => ({
    name: file.slice(0, -3),
    source: "project",
    text: readText(path.join(rolesDir(root), file)) ?? "",
  }));
  for (const role of extra.roles)
    if (!roleFiles.some((known) => known.name === role.name)) roleFiles.push(role);
  const loopFiles: LoopFile[] = listLoops(root).map((name) => ({
    name,
    source: "project",
    definition: readText(loopDefinitionPath(root, name)) ?? "",
    script: readText(loopScriptPath(root, name)),
  }));
  for (const loop of extra.loops)
    if (!loopFiles.some((known) => known.name === loop.name)) loopFiles.push(loop);

  const roleNames = new Set(roleFiles.map((role) => role.name));
  const loopNames = new Set(loopFiles.map((loop) => loop.name));
  const runNames = new Map<string, string>();
  for (const loop of loopFiles) {
    if (loop.source !== "project") continue;
    runNames.set(loop.name, loop.name);
    try {
      const description = splitScript(loop.script ?? "").meta.description;
      if (typeof description === "string" && description) runNames.set(description, loop.name);
    } catch {
      // The loop check reports a script that does not parse.
    }
  }
  const runs = runsByLoop(root, runNames);

  const context: LoopContext = { root, roleNames, loopNames, chosen, runs, check: true };
  const loops: LoopView[] = [];
  for (const file of loopFiles) loops.push(await describeLoop(file, context));
  const roles = roleFiles.map((file) => describeRole(file, loops));

  return {
    project: {
      name: path.basename(root),
      root,
      side,
      library,
      language: projectLanguage(root),
      chosen,
      setup_finished: setupFinishedAt(root),
      generated_at: new Date().toISOString(),
      live,
    },
    loops,
    roles,
  };
}

/** A draft in `.contrejour/drafts/<draft>/`: the loops and roles it holds, as the page shows them. */
export interface DraftView {
  draft: string;
  /** The project as it would be with the draft installed. */
  view: ViewData;
  loops: string[];
  roles: string[];
}
export async function collectDraftView(
  projectRoot: string,
  draft: string,
): Promise<DraftView | null> {
  const root = path.resolve(projectRoot);
  const dir = path.join(root, ".contrejour", "drafts", draft);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(draft) || !fs.existsSync(dir)) return null;
  const base = await collectView(root);
  const draftRoles: RoleFile[] = markdownFiles(path.join(dir, "agents")).map((file) => ({
    name: file.slice(0, -3),
    source: "project",
    text: readText(path.join(dir, "agents", file)) ?? "",
  }));
  const draftLoops: LoopFile[] = markdownFiles(path.join(dir, "loops")).map((file) => ({
    name: file.slice(0, -3),
    source: "project",
    definition: readText(path.join(dir, "loops", file)) ?? "",
    script: readText(path.join(dir, "workflows", `${file.slice(0, -3)}.js`)),
  }));
  const roleNames = new Set([
    ...base.roles.map((role) => role.name),
    ...draftRoles.map((role) => role.name),
  ]);
  const loopNames = new Set([
    ...base.loops.map((loop) => loop.name),
    ...draftLoops.map((loop) => loop.name),
  ]);
  // The editor's own check ran on the draft; the page does not run it again.
  const context: LoopContext = {
    root,
    roleNames,
    loopNames,
    chosen: base.project.chosen,
    runs: new Map(),
    check: false,
  };
  const described: LoopView[] = [];
  for (const file of draftLoops) described.push(await describeLoop(file, context));
  const loops = [
    ...base.loops.filter(
      (loop) => !(loop.source === "project" && draftLoops.some((file) => file.name === loop.name)),
    ),
    ...described,
  ];
  const roles = [
    ...base.roles.filter((role) => !draftRoles.some((file) => file.name === role.name)),
    ...draftRoles.map((file) => describeRole(file, loops)),
  ];
  return {
    draft,
    view: { ...base, loops, roles },
    loops: draftLoops.map((file) => file.name),
    roles: draftRoles.map((file) => file.name),
  };
}

/** What a page may load: its own script and style, and in a served page its own data. */
const policy = (nonce: string, live: boolean): string =>
  [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    `connect-src ${live ? "'self'" : "'none'"}`,
    "img-src data:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");

/** The page: the served one fetches its data; a written one carries it. */
export function renderPage(data: ViewData | null, nonce: string): string {
  // Inside a script element, `<` must not start `</script>`; JSON keeps its meaning with it escaped.
  const json = data
    ? JSON.stringify(data)
        .replace(/</g, "\\u003c")
        .split(String.fromCharCode(0x2028))
        .join("\\u2028")
        .split(String.fromCharCode(0x2029))
        .join("\\u2029")
    : "null";
  const csp = data
    ? `<meta http-equiv="Content-Security-Policy" content="${policy(nonce, false)}">\n`
    : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${csp}<meta name="color-scheme" content="light dark">
<title>Contrejour loops</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<div id="app" class="app"><p class="loading">Loading…</p></div>
<script id="data" type="application/json">${json}</script>
<script nonce="${nonce}">(${client.toString()})();</script>
</body>
</html>
`;
}

export async function writeSnapshot(
  projectRoot: string,
  out: string,
): Promise<{ written: string }> {
  const data = await collectView(projectRoot, false);
  const file = path.resolve(out);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, renderPage(data, crypto.randomBytes(16).toString("base64")));
  return { written: file };
}

/** The files the page is made from, so a served page reloads only when one of them changed. */
export function fingerprint(root: string): string {
  let library: string | null = null;
  try {
    library = installedLibrary(root);
  } catch {
    // Not installed: only the project's files count.
  }
  const dirs = [".claude/loops", ".claude/workflows", ".claude/agents"].map((dir) =>
    path.join(root, dir),
  );
  if (library)
    for (const base of libraryRoots(root))
      for (const kind of ["loops", "roles"]) {
        const dir = path.join(base, "library", kind);
        for (const side of sideFolders(dir)) dirs.push(path.join(dir, side));
      }
  const files = [
    selectedLoopPath(root),
    path.join(root, ".contrejour", "trajectories", "index.jsonl"),
    path.join(root, ".contrejour", "install.json"),
    path.join(root, "task.md"),
    path.join(root, ".contrejour", "setup.json"),
  ];
  for (const dir of dirs)
    if (fs.existsSync(dir))
      for (const file of fs.readdirSync(dir).sort()) files.push(path.join(dir, file));
  const stamp = files
    .map((file) => {
      try {
        const stat = fs.statSync(file);
        return `${file}:${stat.size}:${stat.mtimeMs}`;
      } catch {
        return `${file}:-`;
      }
    })
    .join("\n");
  return crypto.createHash("sha256").update(stamp).digest("hex");
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Serve the page and its data, read-only, until closed. Only on this machine's
 * own address: a project's page may show what another machine must not see (on a
 * validator, how submissions are judged). From another machine, forward the port
 * (`ssh -L`).
 */
export async function serveLoops(
  projectRoot: string,
  options: { host?: string; port?: number } = {},
): Promise<{ url: string; close(): Promise<void> }> {
  const root = path.resolve(projectRoot);
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK.has(host))
    throw new Error(
      `the page is served only on this machine (127.0.0.1, localhost or ::1), not on ${host}; from another machine, forward the port with ssh -L`,
    );
  let cache: { key: string; data: Promise<ViewData> } | null = null;
  const view = () => {
    const key = fingerprint(root);
    if (!cache || cache.key !== key) cache = { key, data: collectView(root, true) };
    return cache.data;
  };
  let allowedHosts = new Set<string>();
  const server = http.createServer((request, response) => {
    void (async () => {
      const security = {
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "cache-control": "no-store",
      };
      // The page answers only to this machine's own address, never to another site's name.
      if (!allowedHosts.has(String(request.headers.host ?? ""))) {
        response.writeHead(421, { ...security, "content-type": "text/plain" }).end("wrong host");
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { ...security, allow: "GET, HEAD" }).end();
        return;
      }
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname === "/") {
        const nonce = crypto.randomBytes(16).toString("base64");
        response.writeHead(200, {
          ...security,
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": policy(nonce, true),
        });
        response.end(request.method === "HEAD" ? undefined : renderPage(null, nonce));
        return;
      }
      if (pathname === "/api/data") {
        try {
          const body = JSON.stringify(await view());
          response.writeHead(200, {
            ...security,
            "content-type": "application/json; charset=utf-8",
          });
          response.end(request.method === "HEAD" ? undefined : body);
        } catch (error) {
          cache = null;
          response
            .writeHead(500, { ...security, "content-type": "application/json; charset=utf-8" })
            .end(JSON.stringify({ error: (error as Error).message }));
        }
        return;
      }
      response.writeHead(404, { ...security, "content-type": "text/plain" }).end("not found");
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8780, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (options.port ?? 8780);
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const shown = host.includes(":") ? `[${host}]` : host;
  return {
    url: `http://${shown}:${port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const STYLE = `
:root{--bg:#f6f6f3;--surface:#fff;--sunken:#f0f0ec;--border:#e2e2dc;--text:#1d2125;--muted:#5f6670;--faint:#8b929b;--accent:#2457c5;--accent-soft:#e8eefb;--task:#0f766e;--task-soft:#e1f3f1;--loop:#6d3fc0;--loop-soft:#efe8fb;--request:#475569;--request-soft:#edf0f4;--ok:#1a7f37;--warn:#9a6700;--warn-soft:#fdf3d7;--bad:#c4271f;--bad-soft:#fde8e6;--shadow:0 1px 2px rgba(20,24,28,.06),0 1px 1px rgba(20,24,28,.04);--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;--sans:system-ui,-apple-system,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#0f1114;--surface:#171a1f;--sunken:#1d2127;--border:#2a2f37;--text:#e7e9ec;--muted:#a2a9b3;--faint:#7c838d;--accent:#6c9cff;--accent-soft:#1c2740;--task:#3cc1b3;--task-soft:#12302d;--loop:#b08bf5;--loop-soft:#2a2140;--request:#a3b1c4;--request-soft:#232a33;--ok:#4cc26b;--warn:#e0b341;--warn-soft:#3a3016;--bad:#ff7b72;--bad-soft:#3b1d1b;--shadow:none}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 var(--sans);-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
a:focus-visible,button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
code,pre{font-family:var(--mono);font-size:12.5px}
code{background:var(--sunken);border:1px solid var(--border);border-radius:4px;padding:0 4px}
.loading,.error,.empty{color:var(--muted);padding:24px}.error{color:var(--bad)}
.top{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:10px;padding:10px 20px;background:var(--surface);border-bottom:1px solid var(--border)}
.brand{font-weight:650;color:var(--text);letter-spacing:.01em}.sep{width:1px;height:18px;background:var(--border)}
.project{font-weight:600}.grow{flex:1}.stamp{color:var(--faint);font-size:12px}
.btn{font:inherit;font-size:12.5px;color:var(--text);background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:3px 10px;cursor:pointer}.btn:hover{background:var(--sunken)}
.layout{display:grid;grid-template-columns:300px minmax(0,1fr);min-height:calc(100vh - 49px)}
.side{border-right:1px solid var(--border);background:var(--surface);padding:12px 10px 32px;position:sticky;top:49px;height:calc(100vh - 49px);overflow:auto}
.search input{width:100%;font:inherit;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text)}
.group{display:flex;justify-content:space-between;align-items:center;margin:18px 8px 6px;font-size:11.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--faint)}
.count{font-weight:500;color:var(--faint)}
.loops{list-style:none;margin:0;padding:0}
.loop-item{display:grid;grid-template-columns:12px 1fr;gap:2px 8px;padding:7px 8px;border-radius:8px;color:var(--text)}
.loop-item:hover{background:var(--sunken);text-decoration:none}.loop-item.current{background:var(--accent-soft)}
.loop-item .name{font-weight:550;font-family:var(--mono);font-size:13px}.loop-item .desc{grid-column:2;color:var(--muted);font-size:12px;line-height:1.45}
.dot{width:8px;height:8px;border-radius:50%;margin-top:7px;background:var(--faint)}.dot.ok{background:var(--ok)}.dot.stale{background:var(--warn)}.dot.bad{background:var(--bad)}
.star{color:var(--warn);font-size:12px}
.main{padding:28px 36px 64px;max-width:1080px;min-width:0}
h1{font-size:22px;margin:0;font-family:var(--mono);font-weight:600}
.title-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px}
.lead{color:var(--muted);margin:8px 0 16px;max-width:80ch}
.badge{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;font-weight:550;padding:1px 8px;border-radius:999px;border:1px solid var(--border);color:var(--muted);background:var(--surface);white-space:nowrap}
.badge.kind-task{color:var(--task);background:var(--task-soft);border-color:transparent}.badge.kind-setup{color:var(--loop);background:var(--loop-soft);border-color:transparent}.badge.kind-on-request{color:var(--request);background:var(--request-soft);border-color:transparent}
.badge.ok{color:var(--ok)}.badge.stale{color:var(--warn);background:var(--warn-soft);border-color:transparent}.badge.bad{color:var(--bad);background:var(--bad-soft);border-color:transparent}
.badge.chosen{color:var(--warn);background:var(--warn-soft);border-color:transparent}.badge.wait{color:var(--warn);background:var(--warn-soft);border-color:transparent}
.pill{font-size:12.5px;padding:2px 10px;border-radius:999px;background:var(--task-soft);color:var(--task)}.pill.muted{background:var(--sunken);color:var(--muted)}
.tabs{display:flex;gap:2px;border-bottom:1px solid var(--border);margin:6px 0 20px;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin}
.tab{padding:8px 12px;color:var(--muted);border-bottom:2px solid transparent;margin-bottom:-1px;white-space:nowrap}.tab:hover{color:var(--text);text-decoration:none}.tab.active{color:var(--text);border-bottom-color:var(--accent);font-weight:550}
.tab .n{color:var(--faint);font-size:11.5px;margin-left:4px}
.panel h2{font-size:15px;margin:26px 0 8px}.panel h3,.panel h4,.panel h5,.panel h6{font-size:14px;margin:18px 0 6px}
.panel p{margin:6px 0;max-width:86ch}.panel ul,.panel ol{margin:6px 0;padding-left:22px}.panel :is(ul,ol):not(.flow){max-width:86ch}.panel li{margin:2px 0}
.purpose{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px 16px;box-shadow:var(--shadow);margin-bottom:22px}
.purpose .label{font-size:11.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--faint)}
.flow{list-style:none;margin:0;padding:0;position:relative}
.flow-step{display:grid;grid-template-columns:34px minmax(0,1fr);gap:12px;position:relative;padding-bottom:14px}
.flow-step:not(:last-child)::before{content:"";position:absolute;left:16px;top:30px;bottom:0;width:2px;background:var(--border)}
.num{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;font-weight:650;background:var(--surface);border:2px solid var(--border);color:var(--muted);font-size:13px;position:relative;z-index:1}
.flow-step.waits .num{border-color:var(--warn);color:var(--warn)}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px 14px 8px;box-shadow:var(--shadow)}
.flow-step.waits .card{border-color:color-mix(in srgb,var(--warn) 45%,var(--border))}
.card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.card-head h3{margin:0;font-size:14.5px}
.card .text{color:var(--text);font-size:13.5px}.card .text p{margin:4px 0}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 2px}
.chip{display:inline-block;font-family:var(--mono);font-size:12px;padding:0 8px;border-radius:6px;line-height:20px;white-space:nowrap}
.chip.role{background:var(--accent-soft);color:var(--accent)}.chip.loop{border:1px solid var(--loop);color:var(--loop)}.chip.missing{background:var(--sunken);color:var(--faint);text-decoration:line-through}.chip .times{font-family:var(--sans);opacity:.75}
.flow-group{margin:4px 0 10px 46px;font-family:var(--mono);font-size:12px;color:var(--faint)}.flow-group span{border:1px dashed var(--border);border-radius:6px;padding:1px 8px}
.flow-note{margin:0 0 12px 46px;color:var(--muted);font-size:13px}
.extra{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin-top:22px}
.box{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px 14px}.box h3{margin:0 0 4px;font-size:13px;color:var(--muted)}
.table{overflow-x:auto;border:1px solid var(--border);border-radius:10px;background:var(--surface)}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--border);vertical-align:top}th{font-size:11.5px;color:var(--faint);font-weight:600;letter-spacing:.04em;text-transform:uppercase;background:var(--sunken)}
tr:last-child td{border-bottom:0}th.nw,td.nw{white-space:nowrap}td.value{font-weight:650}td.value.changed{color:var(--warn)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.role-card,.loop-card{display:block;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px 14px;color:var(--text);box-shadow:var(--shadow)}
.role-card:hover,.loop-card:hover{border-color:var(--accent);text-decoration:none}
.role-card .name,.loop-card .name{font-family:var(--mono);font-weight:600}
.role-card .desc,.loop-card .desc{color:var(--muted);font-size:12.5px;margin-top:4px}
.meta{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
pre.code{background:var(--sunken);border:1px solid var(--border);border-radius:8px;padding:10px 12px;overflow:auto;line-height:1.5}
pre.code code{background:none;border:0;padding:0}
.script{counter-reset:line;background:var(--sunken);border:1px solid var(--border);border-radius:10px;overflow:auto;padding:10px 0}
.script span{display:block;padding:0 14px 0 0;white-space:pre}.script span::before{counter-increment:line;content:counter(line);display:inline-block;width:46px;padding-right:12px;text-align:right;color:var(--faint);user-select:none}
.toolbar{display:flex;justify-content:flex-end;margin-bottom:10px}
.home h1{font-family:var(--sans);font-size:20px}
.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:16px 0 26px}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px 14px}.stat .k{color:var(--faint);font-size:12px}.stat .v{font-size:15px;font-weight:600;margin-top:2px}
.ref{border-bottom:1px dotted var(--faint)}
.defects li{color:var(--bad)}
@media (max-width:860px){.layout{grid-template-columns:minmax(0,1fr)}.side{position:static;height:auto;max-height:45vh;border-right:0;border-bottom:1px solid var(--border)}.main{padding:20px 16px 48px}.top{flex-wrap:wrap}}
`;

function cli(): void {
  const program = createCli(
    "loop-view",
    "A read-only page of this project's loops: steps and the roles that do them, parameters, checks and recent runs",
  );
  program
    .requiredOption("--project <dir>", "project directory")
    .option(
      "--host <host>",
      "this machine's address to listen on: 127.0.0.1, localhost or ::1",
      "127.0.0.1",
    )
    .option("--port <port>", "port to listen on", "8780")
    .option("--out <file>", "write one self-contained HTML file instead of serving the page")
    .action(async (options: { project: string; host: string; port: string; out?: string }) => {
      if (options.out) {
        console.log(JSON.stringify(await writeSnapshot(options.project, options.out), null, 2));
        return;
      }
      const port = Number(options.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new Error("--port must be a port number");
      try {
        const served = await serveLoops(options.project, { host: options.host, port });
        console.log(
          `Contrejour loops of ${path.basename(path.resolve(options.project))}: ${served.url} (read-only; Ctrl+C stops it)`,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EADDRINUSE")
          throw new Error(`port ${port} is in use: pass another with --port`);
        throw error;
      }
    });
  runCli(program);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli();
