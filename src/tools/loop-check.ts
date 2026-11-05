#!/usr/bin/env node
/**
 * The loop editor's compile check. `check` runs each loop's workflow script
 * against stub roles, without calling a model, several times with different stub
 * answers so other branches are reached, and reports call-flow defects: unknown
 * or unnamed roles, the clock or randomness, loops that never stop, undeclared
 * phases, roles no answer reaches, a meta that is not a pure literal, undeclared
 * triggers, child loops that do not exist, and a script generated from an older
 * definition. `stamp` records the definition a script was generated from;
 * `roles` checks role files for the sections every role must have.
 *
 * New and changed loops and roles are drafted in `.contrejour/drafts/<id>/`
 * (agents/, loops/, workflows/) and reach `.claude/` only through `install`,
 * with the digest of the version the owner approved; `--draft` checks a draft as
 * the project would have it.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { createCli, runCli } from "../lib/cli.js";
import { failA1 } from "./validate.js";
import {
  DIGEST_LINE,
  LOOP_KINDS,
  definitionDigest,
  frontmatter,
  listLoops,
  loopDefinitionPath,
  loopParameters,
  parameterDefaults,
  type LoopParameter,
  loopScriptPath,
  parseTriggers,
  recordedDigest,
  roleNames,
  rolesDir,
} from "./loops.js";
import { knownSides, triggersOf } from "./project-manifest.js";

/** Sections every role file has, so its work, its inputs and how it is judged are explicit. */
export const ROLE_SECTIONS = ["Responsibility", "Inputs", "Output", "Writes", "Evaluation"];
const MAX_ROLE_CALLS = 400;
/** The whole search for one argument sample; a script stuck in a loop without awaiting is stopped here. */
const RUN_TIMEOUT_MS = 20_000;
const MAX_RUNS = 3000;
const MAX_FLIPS = 4;

/** A JSON-like literal parser: anything that is not a literal is an error. */
function parseLiteral(text: string, start: number): { value: unknown; end: number } {
  let i = start;
  const fail = (what: string): never => {
    throw new Error(
      `meta: ${what} near "${text.slice(i, i + 30).replace(/\s+/g, " ")}" is not a literal`,
    );
  };
  const space = () => {
    for (;;) {
      if (/\s/.test(text[i] ?? "")) i += 1;
      else if (text.startsWith("//", i))
        i = text.indexOf("\n", i) < 0 ? text.length : text.indexOf("\n", i);
      else if (text.startsWith("/*", i))
        i = text.indexOf("*/", i) < 0 ? fail("comment") : text.indexOf("*/", i) + 2;
      else return;
    }
  };
  const string = (): string => {
    const quote = text[i]!;
    i += 1;
    let out = "";
    while (i < text.length && text[i] !== quote) {
      if (quote === "`" && text.startsWith("${", i)) fail("a template substitution");
      if (text[i] === "\\") {
        const next = text[i + 1]!;
        const escapes: Record<string, string> = {
          n: "\n",
          t: "\t",
          r: "\r",
          b: "\b",
          f: "\f",
          v: "\v",
          "0": "\0",
        };
        if (next === "u") {
          out += String.fromCharCode(Number.parseInt(text.slice(i + 2, i + 6), 16));
          i += 6;
          continue;
        }
        out += escapes[next] ?? next;
        i += 2;
        continue;
      }
      out += text[i];
      i += 1;
    }
    if (text[i] !== quote) fail("an unterminated string");
    i += 1;
    return out;
  };
  const value = (): unknown => {
    space();
    const c = text[i];
    if (c === "{") {
      i += 1;
      const out: Record<string, unknown> = {};
      for (space(); text[i] !== "}"; space()) {
        let key: string;
        if (text[i] === '"' || text[i] === "'") key = string();
        else {
          const name = /^[A-Za-z_$][\w$]*/.exec(text.slice(i))?.[0] ?? fail("a key");
          key = name;
          i += name.length;
        }
        space();
        if (text[i] !== ":") fail(`"${key}" without a value`);
        i += 1;
        out[key] = value();
        space();
        if (text[i] === ",") i += 1;
        else if (text[i] !== "}") fail("a separator");
      }
      i += 1;
      return out;
    }
    if (c === "[") {
      i += 1;
      const out: unknown[] = [];
      for (space(); text[i] !== "]"; space()) {
        out.push(value());
        space();
        if (text[i] === ",") i += 1;
        else if (text[i] !== "]") fail("a separator");
      }
      i += 1;
      return out;
    }
    if (c === '"' || c === "'" || c === "`") return string();
    const word = /^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)(?![\w$])/.exec(
      text.slice(i),
    )?.[0];
    if (!word) return fail("a value");
    i += word.length;
    return word === "true"
      ? true
      : word === "false"
        ? false
        : word === "null"
          ? null
          : Number(word);
  };
  const parsed = value();
  return { value: parsed, end: i };
}

/** The script's meta, which must open it and be a pure literal, and the body that runs. */
export function splitScript(text: string): { meta: Record<string, unknown>; body: string } {
  const opening = /^(\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*export\s+const\s+meta\s*=/.exec(text);
  if (!opening) throw new Error("meta: the script must begin with `export const meta = {...}`");
  const { value } = parseLiteral(text, opening[0].length);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("meta: must be an object");
  const exportAt = opening[0].lastIndexOf("export");
  // Dropping the keyword leaves `const meta = {...}` in the body, as the runtime sees it.
  const body = `${text.slice(0, exportAt)}${text.slice(exportAt + "export".length)}`;
  return { meta: value as Record<string, unknown>, body };
}

interface RunInput {
  body: string;
  roles: string[];
  args: unknown;
  /** The bodies of the project's loops, which a script may run as child loops with workflow(). */
  loops: Record<string, string>;
}
interface RunOutput {
  defects: string[];
  reached: string[];
  phases: string[];
  runs: number;
}
/** Picks one of `options` alternatives at the next choice point of a run. */
type Chooser = (options: number) => number;

/** The answer a role gives when nothing is chosen: false, the first enum value, empty lists. */
function plain(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return "stub";
  const s = schema as Record<string, unknown>;
  if (Array.isArray(s.enum)) return s.enum[0];
  switch (s.type) {
    case "object":
      return Object.fromEntries(
        Object.entries((s.properties ?? {}) as Record<string, unknown>).map(([key, value]) => [
          key,
          plain(value),
        ]),
      );
    case "array":
      return [];
    case "boolean":
      return false;
    case "number":
    case "integer":
      return 1;
    default:
      return "stub";
  }
}
/**
 * A stub answer that satisfies a role's output schema. Every boolean, enum and
 * list of it is a choice point: the chooser decides its value, so a search over
 * the choices reaches the script's branches.
 */
function stub(schema: unknown, choose: Chooser, depth = 0): unknown {
  if (!schema || typeof schema !== "object" || depth > 5) return plain(schema);
  const s = schema as Record<string, unknown>;
  if (Array.isArray(s.enum)) return s.enum[choose(s.enum.length)];
  switch (s.type) {
    case "object":
      return Object.fromEntries(
        Object.entries((s.properties ?? {}) as Record<string, unknown>).map(([key, value]) => [
          key,
          stub(value, choose, depth + 1),
        ]),
      );
    case "array":
      return choose(2) === 1 ? [plain(s.items), plain(s.items)] : [];
    case "boolean":
      return choose(2) === 1;
    default:
      return plain(schema);
  }
}

/**
 * Runs of a script body against stub roles, inside one worker thread. The first
 * run takes the plain answer at every choice point; later runs change one more
 * choice at a time (breadth first, up to MAX_FLIPS changes), so branches that
 * need several answers at once are reached without trying every combination.
 */
async function explore(input: RunInput): Promise<RunOutput> {
  const defects: string[] = [];
  const reached = new Set<string>();
  const phases = new Set<string>();
  const forbidden = (what: string) => () => {
    defects.push(`${what} is not allowed: it breaks resuming a run`);
    return 0;
  };
  const DateStub = new Proxy(Date, {
    apply: forbidden("Date()"),
    construct: (target, args) =>
      (args.length
        ? new target(...(args as [number]))
        : (forbidden("new Date()")(), new target(0))) as object,
    get: (target, key) => (key === "now" ? forbidden("Date.now()") : Reflect.get(target, key)),
  });
  const MathStub = new Proxy(Math, {
    get: (target, key) =>
      key === "random" ? forbidden("Math.random()") : Reflect.get(target, key),
  });
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...params: string[]
  ) => (...args: unknown[]) => Promise<unknown>;
  const compile = (body: string) =>
    new AsyncFunction(
      "agent",
      "parallel",
      "pipeline",
      "phase",
      "log",
      "args",
      "budget",
      "workflow",
      "Date",
      "Math",
      body,
    );
  let script: (...args: unknown[]) => Promise<unknown>;
  // A child loop runs with the same stub roles; it is checked on its own as well.
  const children = new Map<string, ((...args: unknown[]) => Promise<unknown>) | string>();
  const child = (name: string) => {
    if (!children.has(name)) {
      const body = input.loops[name];
      if (body === undefined) children.set(name, `unknown loop "${name}"`);
      else
        try {
          children.set(name, compile(body));
        } catch {
          children.set(name, `child loop "${name}" does not parse`);
        }
    }
    return children.get(name)!;
  };
  try {
    script = compile(input.body);
  } catch (error) {
    return {
      defects: [`the script does not parse: ${(error as Error).message}`],
      reached: [],
      phases: [],
      runs: 0,
    };
  }
  const queue: Map<number, number>[] = [new Map()];
  let runs = 0;
  while (queue.length && runs < MAX_RUNS) {
    const flips = queue.shift()!;
    const trace: number[] = [];
    const choose: Chooser = (options) => {
      const index = trace.length;
      trace.push(options);
      return Math.min(flips.get(index) ?? 0, options - 1);
    };
    let calls = 0;
    // A child loop's phases are its own: only the top loop's are checked against its meta.
    const roleStub =
      (top: boolean) =>
      async (prompt: unknown, options: Record<string, unknown> = {}) => {
        calls += 1;
        if (calls > MAX_ROLE_CALLS)
          throw new Error(`more than ${MAX_ROLE_CALLS} role calls: a loop has no working bound`);
        if (typeof options.agentType !== "string" || !options.agentType)
          defects.push(
            `a step names no role: agent(${JSON.stringify(String(prompt).slice(0, 40))})`,
          );
        else {
          reached.add(options.agentType);
          if (!input.roles.includes(options.agentType))
            defects.push(`unknown role "${options.agentType}"`);
        }
        if (top && typeof options.phase === "string") phases.add(options.phase);
        return options.schema ? stub(options.schema, choose) : "stub";
      };
    const agent = roleStub(true);
    const parallel = (thunks: (() => Promise<unknown>)[]) =>
      Promise.all(thunks.map((thunk) => thunk().catch(() => null)));
    const pipeline = (
      items: unknown[],
      ...stages: ((r: unknown, item: unknown, i: number) => unknown)[]
    ) =>
      Promise.all(
        items.map(async (item, index) => {
          let result: unknown = item;
          for (const stage of stages) result = await stage(result, item, index);
          return result;
        }),
      );
    const budget = { total: null, spent: () => 0, remaining: () => Infinity };
    const nested = async () => {
      throw new Error("workflow() inside a child loop: nesting is one level only");
    };
    const workflow = async (name: unknown, childArgs: unknown) => {
      if (typeof name !== "string") {
        defects.push("a child loop must be named by a string");
        return null;
      }
      const run = child(name);
      if (typeof run === "string") {
        defects.push(run);
        return null;
      }
      return run(
        roleStub(false),
        parallel,
        pipeline,
        () => {},
        () => {},
        childArgs,
        budget,
        nested,
        DateStub,
        MathStub,
      );
    };
    try {
      await script(
        agent,
        parallel,
        pipeline,
        (title: unknown) => phases.add(String(title)),
        () => {},
        input.args,
        budget,
        workflow,
        DateStub,
        MathStub,
      );
    } catch (error) {
      defects.push(`run failed: ${(error as Error).message}`);
    }
    runs += 1;
    // Each further run changes one more choice, after the last one this run changed.
    if (flips.size < MAX_FLIPS) {
      const after = flips.size ? Math.max(...flips.keys()) + 1 : 0;
      for (let index = after; index < trace.length; index += 1)
        for (let option = 1; option < trace[index]!; option += 1)
          queue.push(new Map([...flips, [index, option]]));
    }
  }
  return { defects: [...new Set(defects)], reached: [...reached], phases: [...phases], runs };
}

function exploreInWorker(input: RunInput): Promise<RunOutput> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: input });
    const timer = setTimeout(() => {
      void worker.terminate();
      resolve({
        defects: [`did not finish within ${RUN_TIMEOUT_MS / 1000}s under stub roles`],
        reached: [],
        phases: [],
        runs: 0,
      });
    }, RUN_TIMEOUT_MS);
    worker.once("message", (output: RunOutput) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(output);
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      resolve({ defects: [`run failed: ${error.message}`], reached: [], phases: [], runs: 0 });
    });
  });
}

export interface LoopReport {
  loop: string;
  ok: boolean;
  stale: boolean;
  roles_called: string[];
  defects: string[];
}

export async function checkLoop(root: string, name: string): Promise<LoopReport> {
  const defects: string[] = [];
  const report = (stale: boolean, called: string[] = []): LoopReport => {
    const unique = [...new Set(defects)];
    return {
      loop: name,
      ok: !unique.length && !stale,
      stale,
      roles_called: called,
      defects: unique,
    };
  };
  const definitionFile = loopDefinitionPath(root, name);
  const scriptFile = loopScriptPath(root, name);
  if (!fs.existsSync(definitionFile)) defects.push(`no definition ${definitionFile}`);
  if (!fs.existsSync(scriptFile)) defects.push(`no script ${scriptFile}`);
  if (defects.length) return report(true);
  const definition = fs.readFileSync(definitionFile);
  const fields = frontmatter(definition.toString("utf8"));
  if (fields.kind !== undefined && !(LOOP_KINDS as readonly string[]).includes(fields.kind))
    defects.push(`kind must be one of ${LOOP_KINDS.join(", ")}`);
  const triggers = triggersOf(root);
  for (const action of parseTriggers(fields.triggers))
    if (!triggers[action])
      defects.push(`unknown trigger "${action}"; known: ${Object.keys(triggers).join(", ")}`);
  let samples: unknown[] = [{}];
  if (fields["check-args"]) {
    try {
      const parsed: unknown = JSON.parse(fields["check-args"]);
      samples = Array.isArray(parsed) && parsed.length ? parsed : [parsed];
    } catch {
      defects.push("check-args must be one line of JSON: a list of argument objects");
    }
  }
  // What a trial run of the loop passes it (loop-trial): one argument object whose run stays in the project.
  if (fields["trial-args"]) {
    try {
      const parsed: unknown = JSON.parse(fields["trial-args"]);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    } catch {
      defects.push("trial-args must be one line of JSON: one argument object");
    }
  }
  // A loop that runs a loop it is given names the argument that gives it.
  const childLoopArg = fields["child-loop-arg"];
  if (childLoopArg !== undefined && !/^[A-Za-z_]\w*$/.test(childLoopArg))
    defects.push("child-loop-arg must name one argument, such as loop");
  // A run gets the parameters' defaults as args.params, as a project records the values chosen.
  let parameters: LoopParameter[] = [];
  try {
    parameters = loopParameters(definition.toString("utf8"));
  } catch (error) {
    defects.push(`parameters: ${(error as Error).message}`);
  }
  if (parameters.length)
    samples = samples.map((sample) =>
      sample && typeof sample === "object" && !Array.isArray(sample)
        ? {
            ...sample,
            params: {
              ...parameterDefaults(parameters),
              ...((sample as Record<string, unknown>).params as Record<string, unknown>),
            },
          }
        : sample,
    );
  const text = fs.readFileSync(scriptFile, "utf8");
  const stale = recordedDigest(text) !== definitionDigest(definition);
  let split: { meta: Record<string, unknown>; body: string };
  try {
    split = splitScript(text);
  } catch (error) {
    defects.push((error as Error).message);
    return report(stale);
  }
  const { meta, body } = split;
  if (meta.name !== name) defects.push(`meta.name must be "${name}", the loop's name`);
  if (typeof meta.description !== "string" || !meta.description)
    defects.push("meta.description is required");
  if (/\bDate\s*\.\s*now\b|\bnew\s+Date\s*\(\s*\)|\bMath\s*\.\s*random\b/.test(body))
    defects.push("the script uses the clock or randomness, which break resuming a run");
  const roles = [...roleNames(root).values()];
  const named = new Set(
    [...body.matchAll(/agentType\s*:\s*(['"`])([^'"`]+)\1/g)].map((match) => match[2]!),
  );
  for (const role of named) if (!roles.includes(role)) defects.push(`unknown role "${role}"`);
  // A child loop is named, so the check and a reader can tell which loops a loop runs; a loop that runs
  // the loop it is given says which argument gives it (`child-loop-arg`), and the check runs the one
  // its check-args name.
  const loopNames = listLoops(root);
  if (/\bworkflow\s*\(\s*(?!['"`])/.test(body) && !childLoopArg)
    defects.push("a child loop must be named by a string");
  for (const match of body.matchAll(/\bworkflow\s*\(\s*(['"`])([^'"`]+)\1/g))
    if (!loopNames.includes(match[2]!)) defects.push(`unknown loop "${match[2]}"`);
  const loops: Record<string, string> = {};
  for (const other of loopNames)
    try {
      loops[other] = splitScript(fs.readFileSync(loopScriptPath(root, other), "utf8")).body;
    } catch {
      // A missing or broken child is reported when the run reaches it, and by its own check.
    }
  // The script and its definition must agree on the parameters.
  const used = new Set(
    [
      ...body.matchAll(/\bparams\s*\.\s*([A-Za-z_$][\w$]*)/g),
      ...body.matchAll(/\bparams\s*\[\s*(['"`])([^'"`]+)\1\s*\]/g),
    ].map((match) => match[2] ?? match[1]!),
  );
  const declaredParameters = new Set(parameters.map((parameter) => parameter.name));
  for (const name of used)
    if (!declaredParameters.has(name))
      defects.push(`the script uses parameter "${name}", which the definition does not declare`);
  for (const name of declaredParameters)
    if (!used.has(name))
      defects.push(`the definition declares parameter "${name}", which the script never uses`);
  const reached = new Set<string>();
  const phases = new Set<string>();
  for (const args of samples) {
    const output = await exploreInWorker({ body, roles, args, loops });
    defects.push(...output.defects);
    output.reached.forEach((role) => reached.add(role));
    output.phases.forEach((title) => phases.add(title));
  }
  for (const role of named)
    if (roles.includes(role) && !reached.has(role))
      defects.push(`role "${role}" is never reached under any stub answer`);
  const declared = new Set(
    (Array.isArray(meta.phases) ? meta.phases : []).map((entry) =>
      entry && typeof entry === "object" ? String((entry as Record<string, unknown>).title) : "",
    ),
  );
  for (const title of phases)
    if (!declared.has(title)) defects.push(`phase "${title}" is not declared in meta.phases`);
  return report(stale, [...reached].sort());
}

/** Record the definition a script was generated from, as its last line. */
export function stampLoop(root: string, name: string): { loop: string; definition_sha256: string } {
  return stampFiles(name, loopDefinitionPath(root, name), loopScriptPath(root, name));
}
function stampFiles(
  name: string,
  definition: string,
  file: string,
): { loop: string; definition_sha256: string } {
  for (const needed of [definition, file])
    if (!fs.existsSync(needed)) failA1("INVALID_VALUE", `no such file: ${needed}`);
  const digest = definitionDigest(fs.readFileSync(definition));
  const text = fs
    .readFileSync(file, "utf8")
    .replace(new RegExp(DIGEST_LINE.source, "gm"), "")
    .trimEnd();
  fs.writeFileSync(file, `${text}\n\n// contrejour-loop-definition-sha256: ${digest}\n`);
  return { loop: name, definition_sha256: digest };
}

export interface RoleReport {
  role: string;
  ok: boolean;
  defects: string[];
}
/** Who receives a role or loop from the library: every project (`framework`), or the projects of one side. */
export const sidesKnown = (root: string): string[] => knownSides(root);
/** Every role file names itself after its file, describes itself, says who it serves and has the required sections. */
/** The reasoning efforts a role may ask for that every model provider Claude Code reaches accepts. */
const ROLE_EFFORTS = ["low", "high", "xhigh", "max"];
export function checkRoles(root: string, only?: string[]): RoleReport[] {
  const dir = rolesDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".md") && (!only?.length || only.includes(file.slice(0, -3))))
    .sort()
    .map((file) => {
      const text = fs.readFileSync(path.join(dir, file), "utf8");
      const fields = frontmatter(text);
      const defects: string[] = [];
      if (fields.name !== file.slice(0, -3))
        defects.push(`frontmatter name must be "${file.slice(0, -3)}"`);
      if (!fields.description) defects.push("frontmatter description is required");
      const sides = knownSides(root);
      if (!sides.includes(fields.side ?? ""))
        defects.push(`frontmatter side must be one of ${sides.join(", ")}`);
      // Claude Code sends a role's effort to the model's provider as it is, and some providers refuse medium.
      if (fields.effort !== undefined && !ROLE_EFFORTS.includes(fields.effort))
        defects.push(
          `frontmatter effort must be one of ${ROLE_EFFORTS.join(", ")}, or left out to use the session's own: some model providers (DeepSeek among them) refuse ${fields.effort || "an empty one"}`,
        );
      for (const section of ROLE_SECTIONS)
        if (!new RegExp(`^##\\s+${section}\\b`, "mi").test(text))
          defects.push(`missing section "## ${section}"`);
      return { role: file.slice(0, -3), ok: !defects.length, defects };
    });
}

const DRAFT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Where a draft keeps its files, as .claude/ would hold them. */
const DRAFT_LAYOUT: Record<string, string> = { agents: ".md", loops: ".md", workflows: ".js" };
export const draftsDir = (root: string): string =>
  path.join(path.resolve(root), ".contrejour", "drafts");
export function draftDir(root: string, id: string): string {
  if (!DRAFT_ID.test(id))
    failA1("INVALID_VALUE", "a draft id is lowercase letters, digits and hyphens");
  return path.join(draftsDir(root), id);
}
function draftFiles(dir: string): string[] {
  const files: string[] = [];
  for (const [sub, extension] of Object.entries(DRAFT_LAYOUT)) {
    const folder = path.join(dir, sub);
    if (!fs.existsSync(folder)) continue;
    for (const file of fs.readdirSync(folder))
      if (file.endsWith(extension) && fs.statSync(path.join(folder, file)).isFile())
        files.push(`${sub}/${file}`);
  }
  return files.sort();
}
function draftNames(root: string, id: string, sub: "agents" | "loops"): string[] {
  return draftFiles(draftDir(root, id))
    .filter((file) => file.startsWith(`${sub}/`))
    .map((file) => file.slice(sub.length + 1, -3));
}
/** Line endings say nothing about what a loop or role does. */
const normalText = (file: string) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
/** The digest of everything a draft holds: what the owner approves and install requires. */
export function draftDigest(root: string, id: string): string {
  const dir = draftDir(root, id);
  const entries = draftFiles(dir).map((file) => [
    file,
    crypto
      .createHash("sha256")
      .update(normalText(path.join(dir, file)))
      .digest("hex"),
  ]);
  return crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}
/** Run `action` on a copy of the project's loops and roles with the draft laid over them. */
async function withDraft<T>(
  root: string,
  id: string,
  action: (merged: string) => T | Promise<T>,
): Promise<T> {
  const dir = draftDir(root, id);
  if (!fs.existsSync(dir)) failA1("NO_DRAFT", `there is no draft ${id}`);
  const merged = fs.mkdtempSync(path.join(os.tmpdir(), "contrejour-draft-"));
  try {
    for (const sub of Object.keys(DRAFT_LAYOUT)) {
      const target = path.join(merged, ".claude", sub);
      fs.mkdirSync(target, { recursive: true });
      for (const from of [path.join(path.resolve(root), ".claude", sub), path.join(dir, sub)])
        if (fs.existsSync(from))
          for (const file of fs.readdirSync(from))
            if (fs.statSync(path.join(from, file)).isFile())
              fs.copyFileSync(path.join(from, file), path.join(target, file));
    }
    // The project's manifest too: it names the sides and hook actions the draft may use.
    const manifest = path.join(path.resolve(root), ".contrejour", "project.json");
    if (fs.existsSync(manifest)) {
      fs.mkdirSync(path.join(merged, ".contrejour"), { recursive: true });
      fs.copyFileSync(manifest, path.join(merged, ".contrejour", "project.json"));
    }
    return await action(merged);
  } finally {
    fs.rmSync(merged, { recursive: true, force: true });
  }
}
export interface DraftReport {
  draft: string;
  files: string[];
  digest: string;
  ok: boolean;
  loops: LoopReport[];
  roles: RoleReport[];
}
/** A draft's files, its digest, and its loops and roles checked as the project would have them. */
export async function checkDraft(root: string, id: string): Promise<DraftReport> {
  const files = draftFiles(draftDir(root, id));
  return withDraft(root, id, async (merged) => {
    const loops: LoopReport[] = [];
    for (const name of draftNames(root, id, "loops")) loops.push(await checkLoop(merged, name));
    const names = draftNames(root, id, "agents");
    const roles = names.length ? checkRoles(merged, names) : [];
    // A script without its definition, here or in the project, is reported by the loop's check.
    const scripts = files.filter((file) => file.startsWith("workflows/"));
    for (const script of scripts) {
      const name = script.slice("workflows/".length, -3);
      if (!loops.some((report) => report.loop === name)) loops.push(await checkLoop(merged, name));
    }
    return {
      draft: id,
      files,
      digest: draftDigest(root, id),
      ok: files.length > 0 && loops.every((entry) => entry.ok) && roles.every((entry) => entry.ok),
      loops,
      roles,
    };
  });
}
/** Copy exactly the approved version of a draft into .claude/, then remove the draft. */
export async function installDraft(
  root: string,
  id: string,
  digest: string,
): Promise<{ draft: string; installed: string[] }> {
  const report = await checkDraft(root, id);
  if (report.digest !== digest)
    failA1(
      "DRAFT_CHANGED",
      `the draft is not the version the owner approved: its digest is now ${report.digest}`,
    );
  if (!report.ok)
    failA1(
      "DRAFT_CHECK_FAILED",
      [...report.loops, ...report.roles]
        .flatMap((entry) =>
          entry.defects.map((defect) => `${"loop" in entry ? entry.loop : entry.role}: ${defect}`),
        )
        .join("; ") || "the draft is empty",
    );
  const dir = draftDir(root, id);
  for (const file of report.files) {
    const target = path.join(path.resolve(root), ".claude", ...file.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(dir, file), target);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { draft: id, installed: report.files.map((file) => `.claude/${file}`) };
}
export function discardDraft(root: string, id: string): { draft: string; discarded: boolean } {
  const dir = draftDir(root, id);
  const existed = fs.existsSync(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return { draft: id, discarded: existed };
}

function cli(): void {
  const program = createCli("loop-check", "Check Contrejour loops and roles");
  const print = (value: unknown, ok: boolean) => {
    console.log(JSON.stringify(value, null, 2));
    if (!ok) process.exitCode = 1;
  };
  const failed = (error: unknown) => {
    console.error(
      JSON.stringify(
        {
          status: "failed",
          reason: (error as { code?: string }).code ?? "loop_check_failed",
          message: (error as Error).message,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  };
  program
    .command("check")
    .description("Run each loop's script against stub roles and report call-flow defects")
    .requiredOption("--project <dir>")
    .option("--draft <id>", "check as the project would be with this draft installed")
    .argument(
      "[loops...]",
      "loop names; every loop in .claude/loops (or in the draft) when omitted",
    )
    .action(async (loops: string[], options: { project: string; draft?: string }) => {
      try {
        const run = async (root: string) => {
          const names = loops.length
            ? loops
            : options.draft
              ? draftNames(options.project, options.draft, "loops")
              : listLoops(root);
          const reports: LoopReport[] = [];
          for (const name of names) reports.push(await checkLoop(root, name));
          return reports;
        };
        const reports = options.draft
          ? await withDraft(options.project, options.draft, run)
          : await run(options.project);
        print(
          reports,
          reports.every((entry) => entry.ok),
        );
      } catch (error) {
        failed(error);
      }
    });
  program
    .command("stamp")
    .description("Record in the script which version of the definition it was generated from")
    .requiredOption("--project <dir>")
    .option("--draft <id>", "stamp the draft's script")
    .argument("<loop>")
    .action((loop: string, options: { project: string; draft?: string }) => {
      try {
        if (!options.draft) return print(stampLoop(options.project, loop), true);
        const dir = draftDir(options.project, options.draft);
        print(
          stampFiles(
            loop,
            path.join(dir, "loops", `${loop}.md`),
            path.join(dir, "workflows", `${loop}.js`),
          ),
          true,
        );
      } catch (error) {
        failed(error);
      }
    });
  program
    .command("roles")
    .description("Check role files for their name, description, side and required sections")
    .requiredOption("--project <dir>")
    .option("--draft <id>", "check the draft's roles as the project would have them")
    .argument("[roles...]")
    .action(async (roles: string[], options: { project: string; draft?: string }) => {
      try {
        const reports = options.draft
          ? await withDraft(options.project, options.draft, (root) =>
              checkRoles(
                root,
                roles.length ? roles : draftNames(options.project, options.draft!, "agents"),
              ),
            )
          : checkRoles(options.project, roles);
        print(
          reports,
          reports.every((entry) => entry.ok),
        );
      } catch (error) {
        failed(error);
      }
    });
  program
    .command("draft")
    .description("A draft's files, its digest and the check of its loops and roles")
    .requiredOption("--project <dir>")
    .requiredOption("--draft <id>")
    .action(async (options: { project: string; draft: string }) => {
      try {
        const report = await checkDraft(options.project, options.draft);
        print(report, report.ok);
      } catch (error) {
        failed(error);
      }
    });
  program
    .command("install")
    .description(
      "Install a draft into .claude/: only the version with the approved digest, and only when it checks",
    )
    .requiredOption("--project <dir>")
    .requiredOption("--draft <id>")
    .requiredOption("--digest <sha256>", "the digest of the version the owner approved")
    .action(async (options: { project: string; draft: string; digest: string }) => {
      try {
        print(await installDraft(options.project, options.draft, options.digest), true);
      } catch (error) {
        failed(error);
      }
    });
  program
    .command("discard")
    .description("Remove a draft the owner did not approve")
    .requiredOption("--project <dir>")
    .requiredOption("--draft <id>")
    .action((options: { project: string; draft: string }) => {
      try {
        print(discardDraft(options.project, options.draft), true);
      } catch (error) {
        failed(error);
      }
    });
  runCli(program);
}

if (!isMainThread) {
  void explore(workerData as RunInput).then((output) => parentPort!.postMessage(output));
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli();
}
