/**
 * Choosing the loop a project runs, as the owner does in the Studio: the loop
 * and its parameter values go to `.contrejour/loop.json`, and the project's
 * sessions enter as the role that runs it. A library loop the project does not
 * have comes into the project first, with the roles it needs that the project
 * lacks, the way the installer seeds them: a copy is kept in
 * `.contrejour/seeded/` as the baseline that later tells what the project
 * changed, and from then on the files are the project's own.
 */
import fs from "node:fs";
import path from "node:path";
import { entryRoleOf, libraryRoots, sidesOf } from "./installation.js";
import {
  frontmatter,
  loopDefinitionPath,
  loopParameters,
  loopScriptPath,
  parameterProblem,
  rolesDir,
  selectedLoopPath,
} from "./loops.js";
import { writeEntryRole } from "./project-settings.js";
import { writeStateJsonAtomic } from "./state-file.js";
import { failA1 } from "./validate.js";

const LOOP_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Where the library keeps a loop or role of a side this project may use: the project's side first. */
function libraryFile(
  root: string,
  kind: "loops" | "roles",
  name: string,
  extension: string,
): string | null {
  const sides = sidesOf(root);
  for (const dir of [...sides.slice(1), sides[0]!])
    for (const library of libraryRoots(root)) {
      const file = path.join(library, "library", kind, dir, `${name}${extension}`);
      if (fs.existsSync(file)) return file;
    }
  return null;
}

function seed(root: string, target: string, contents: Buffer): void {
  const relative = path.relative(path.join(root, ".claude"), target);
  for (const file of [target, path.join(root, ".contrejour", "seeded", relative)]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
}

export interface UsedLoop {
  loop: string;
  params: Record<string, unknown>;
  /** Files brought into the project from the library, relative to it. */
  added: string[];
  entry_role: string;
}

export function useLoop(
  projectRoot: string,
  request: { name: string; params: Record<string, unknown> },
): UsedLoop {
  const root = path.resolve(projectRoot);
  const { name } = request;
  if (!LOOP_NAME.test(name))
    failA1("INVALID_VALUE", "a loop name is lowercase words joined by hyphens");
  const added: string[] = [];
  if (!fs.existsSync(loopDefinitionPath(root, name))) {
    const definition = libraryFile(root, "loops", name, ".md");
    const script = libraryFile(root, "loops", name, ".js");
    if (!definition || !script)
      failA1("NOT_FOUND", `neither this project nor its library has the loop ${name}`);
    seed(root, loopDefinitionPath(root, name), fs.readFileSync(definition));
    seed(root, loopScriptPath(root, name), fs.readFileSync(script));
    added.push(
      path.relative(root, loopDefinitionPath(root, name)),
      path.relative(root, loopScriptPath(root, name)),
    );
    // The roles its steps name that the project lacks come along, as the library has them.
    const text = fs.readFileSync(definition, "utf8");
    for (const role of new Set(
      [...text.matchAll(/`([a-z0-9][a-z0-9-]*)`/g)].map((match) => match[1]!),
    )) {
      const target = path.join(rolesDir(root), `${role}.md`);
      const found = fs.existsSync(target) ? null : libraryFile(root, "roles", role, ".md");
      if (!found) continue;
      seed(root, target, fs.readFileSync(found));
      added.push(path.relative(root, target));
    }
  }
  const definition = fs.readFileSync(loopDefinitionPath(root, name), "utf8");
  const kind = frontmatter(definition).kind ?? "task";
  if (kind !== "task")
    failA1(
      "INVALID_VALUE",
      `${name} is a ${kind} loop: a project runs a task loop, and runs the others when asked`,
    );

  const declared = loopParameters(definition);
  const params: Record<string, unknown> = {};
  for (const key of Object.keys(request.params))
    if (!declared.some((parameter) => parameter.name === key))
      failA1("INVALID_VALUE", `${name} has no parameter ${key}`);
  for (const parameter of declared) {
    const value =
      parameter.name in request.params ? request.params[parameter.name] : parameter.default;
    const problem = parameterProblem(parameter, value);
    if (problem) failA1("INVALID_VALUE", `${parameter.name} ${problem}`);
    params[parameter.name] = value;
  }
  writeStateJsonAtomic(selectedLoopPath(root), { schema_version: 1, loop: name, params });
  const role = entryRoleOf(root);
  writeEntryRole(root, role);
  return { loop: name, params, added, entry_role: role };
}
