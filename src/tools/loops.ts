/**
 * Loops on disk: a definition in `.claude/loops/<name>.md`, the only authority,
 * and the workflow script generated from it in `.claude/workflows/<name>.js`.
 * The script ends with the digest of the definition it was generated from, so a
 * changed definition shows the script is stale. A definition declares the
 * loop's parameters, its hyperparameters; the owner chooses the loop a project
 * runs and their values in the Studio, recorded in `.contrejour/loop.json`, and
 * the script reads them from `args.params`.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LOOPS_DIR, ROLES_DIR, WORKFLOWS_DIR } from "./installation.js";
import { failA1, isRecord } from "./validate.js";

export const DIGEST_LINE = /^\/\/ contrejour-loop-definition-sha256: ([0-9a-f]{64})[ \t]*$/m;

const dir = (root: string, relative: string): string =>
  path.join(path.resolve(root), ...relative.split("/"));
export const loopDefinitionPath = (root: string, name: string): string =>
  path.join(dir(root, LOOPS_DIR), `${name}.md`);
export const loopScriptPath = (root: string, name: string): string =>
  path.join(dir(root, WORKFLOWS_DIR), `${name}.js`);
export const rolesDir = (root: string): string => dir(root, ROLES_DIR);

/** Names of the loops defined in this project. */
export function listLoops(root: string): string[] {
  const loops = dir(root, LOOPS_DIR);
  if (!fs.existsSync(loops)) return [];
  return fs
    .readdirSync(loops)
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.slice(0, -3))
    .sort();
}

/** The `key: value` lines of a leading `---` block. */
export function frontmatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (field) fields[field[1]!] = field[2]!.trim();
  }
  return fields;
}

/** `triggers: a, b` or `triggers: [a, b]`, as a list of action names. */
export function parseTriggers(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/** Every action the project's loop definitions declare. */
export function declaredTriggers(root: string): Set<string> {
  const actions = new Set<string>();
  for (const name of listLoops(root))
    for (const action of parseTriggers(
      frontmatter(fs.readFileSync(loopDefinitionPath(root, name), "utf8")).triggers,
    ))
      actions.add(action);
  return actions;
}

export const definitionDigest = (bytes: Buffer | string): string =>
  crypto.createHash("sha256").update(bytes).digest("hex");

/** The definition digest a script records, or null when it records none. */
export function recordedDigest(script: string): string | null {
  return DIGEST_LINE.exec(script)?.[1] ?? null;
}

/** The names roles declare in `.claude/agents/*.md`, by file. */
export function roleNames(root: string): Map<string, string> {
  const roles = rolesDir(root);
  const names = new Map<string, string>();
  if (!fs.existsSync(roles)) return names;
  for (const file of fs.readdirSync(roles).filter((entry) => entry.endsWith(".md"))) {
    const name = frontmatter(fs.readFileSync(path.join(roles, file), "utf8")).name;
    if (name) names.set(file, name);
  }
  return names;
}

export const PARAMETER_TYPES = ["integer", "number", "boolean", "string", "enum"] as const;
/** One hyperparameter of a loop, as its definition declares it. */
export interface LoopParameter {
  name: string;
  type: (typeof PARAMETER_TYPES)[number];
  default: unknown;
  description: string;
  min?: number;
  max?: number;
  choices?: string[];
}

/** Why a value does not fit a parameter, or null when it does. */
export function parameterProblem(parameter: LoopParameter, value: unknown): string | null {
  if (parameter.type === "integer" && !Number.isInteger(value)) return "must be an integer";
  if (parameter.type === "number" && (typeof value !== "number" || !Number.isFinite(value)))
    return "must be a number";
  if (parameter.type === "boolean" && typeof value !== "boolean") return "must be true or false";
  if (parameter.type === "string" && typeof value !== "string") return "must be text";
  if (parameter.type === "enum" && !parameter.choices!.includes(String(value)))
    return `must be one of ${JSON.stringify(parameter.choices)}`;
  if (typeof value === "number" && parameter.min !== undefined && value < parameter.min)
    return `must be at least ${parameter.min}`;
  if (typeof value === "number" && parameter.max !== undefined && value > parameter.max)
    return `must be at most ${parameter.max}`;
  return null;
}

/**
 * The parameters a definition declares: the JSON list in the ```json block of
 * its `## Parameters` section. A definition without that section has none.
 * Every parameter has a default, so a reused loop runs with sound values.
 */
export function loopParameters(definition: string): LoopParameter[] {
  const lines = definition.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+Parameters\b/.test(line));
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  const section = lines.slice(start + 1, end < 0 ? lines.length : end).join("\n");
  const block = /```json[ \t]*\n([\s\S]*?)\n```/.exec(section);
  if (!block) throw new Error("the Parameters section has no ```json block");
  let parsed: unknown;
  try {
    parsed = JSON.parse(block[1]!);
  } catch (error) {
    throw new Error(`the Parameters block is not JSON: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error("the Parameters block must be a JSON list");
  const names = new Set<string>();
  return parsed.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`parameter ${index + 1} must be an object`);
    const name = entry.name;
    if (typeof name !== "string" || !/^[a-z][a-z0-9_]*$/.test(name))
      throw new Error(`parameter ${index + 1}: its name must be snake_case`);
    if (names.has(name)) throw new Error(`parameter "${name}" is declared twice`);
    names.add(name);
    if (!PARAMETER_TYPES.includes(entry.type as LoopParameter["type"]))
      throw new Error(`parameter "${name}": type must be one of ${PARAMETER_TYPES.join(", ")}`);
    if (typeof entry.description !== "string" || !entry.description.trim())
      throw new Error(`parameter "${name}": a description is required`);
    const choices = entry.choices;
    if (
      entry.type === "enum" &&
      (!Array.isArray(choices) ||
        !choices.length ||
        choices.some((choice) => typeof choice !== "string"))
    )
      throw new Error(`parameter "${name}": an enum needs a list of text choices`);
    for (const bound of ["min", "max"] as const)
      if (entry[bound] !== undefined && typeof entry[bound] !== "number")
        throw new Error(`parameter "${name}": ${bound} must be a number`);
    if (!("default" in entry)) throw new Error(`parameter "${name}": a default is required`);
    const parameter: LoopParameter = {
      name,
      type: entry.type as LoopParameter["type"],
      default: entry.default,
      description: entry.description.trim(),
      ...(typeof entry.min === "number" ? { min: entry.min } : {}),
      ...(typeof entry.max === "number" ? { max: entry.max } : {}),
      ...(entry.type === "enum" ? { choices: choices as string[] } : {}),
    };
    const problem = parameterProblem(parameter, parameter.default);
    if (problem) throw new Error(`parameter "${name}": its default ${problem}`);
    return parameter;
  });
}

export const parameterDefaults = (parameters: LoopParameter[]): Record<string, unknown> =>
  Object.fromEntries(parameters.map((parameter) => [parameter.name, parameter.default]));

/**
 * What a loop is for: `task`, the work a project runs again and again (the owner
 * chooses one, the project's entry role runs it); `on-request`, work the owner
 * asks for. A definition without `kind` is a task loop.
 */
export const LOOP_KINDS = ["task", "on-request"] as const;
export function loopKind(root: string, name: string): string {
  const file = loopDefinitionPath(root, name);
  return fs.existsSync(file) ? (frontmatter(fs.readFileSync(file, "utf8")).kind ?? "task") : "task";
}

/** The side a loop serves, from its definition's frontmatter. */
export function loopSide(root: string, name: string): string | null {
  const file = loopDefinitionPath(root, name);
  return fs.existsSync(file) ? (frontmatter(fs.readFileSync(file, "utf8")).side ?? null) : null;
}

/** The loop a project runs and the parameter values the owner chose for it. */
export interface SelectedLoop {
  loop: string;
  params: Record<string, unknown>;
}
export const selectedLoopPath = (root: string): string =>
  path.join(path.resolve(root), ".contrejour", "loop.json");
export function readSelectedLoop(root: string): SelectedLoop {
  const file = selectedLoopPath(root);
  if (!fs.existsSync(file))
    failA1(
      "LOOP_NOT_SELECTED",
      "choose the loop this project runs and its parameters in the Studio (studio.js), or with project-cli.js use",
    );
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!isRecord(value) || typeof value.loop !== "string" || !isRecord(value.params))
    failA1("INVALID_VALUE", `${file} must name a loop and its params`);
  return { loop: value.loop, params: value.params };
}
