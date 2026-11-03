#!/usr/bin/env node
/**
 * The project's settings from a terminal, for what the Studio otherwise does:
 * register the hooks (the installer runs it), make a loop the project's task
 * loop with its parameter values, and show what the project runs.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCli, runCli } from "../lib/cli.js";
import { entryRoleOf, installedRole } from "./installation.js";
import { readSelectedLoop } from "./loops.js";
import { useLoop } from "./project-loop.js";
import { readManifest } from "./project-manifest.js";
import { entryRole, writeEntryRole } from "./project-settings.js";

/** `name=value`: the value read as JSON when it is JSON (a number, true), else as text. */
function parameter(text: string): [string, unknown] {
  const index = text.indexOf("=");
  if (index <= 0) throw new Error(`a parameter is name=value, not ${text}`);
  const raw = text.slice(index + 1);
  let value: unknown = raw;
  try {
    value = JSON.parse(raw);
  } catch {
    // Text stays text.
  }
  return [text.slice(0, index), value];
}

function cli(): void {
  const program = createCli(
    "project",
    "This project's settings: hooks, its task loop and parameters",
  );
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  program
    .command("hooks")
    .description(
      "Write what every session of this project starts with in .claude/settings.json: the hooks and the entry role, keeping every other setting",
    )
    .requiredOption("--project <dir>")
    .action((options: { project: string }) =>
      print({ settings: writeEntryRole(options.project, entryRoleOf(options.project)) }),
    );
  program
    .command("use")
    .description(
      "Make a loop this project's task loop, with these parameter values (the rest keep their defaults)",
    )
    .requiredOption("--project <dir>")
    .requiredOption("--loop <name>")
    .option("--param <name=value...>", "a parameter value, such as informed_ideators=2")
    .action((options: { project: string; loop: string; param?: string[] }) =>
      print(
        useLoop(options.project, {
          name: options.loop,
          params: Object.fromEntries((options.param ?? []).map(parameter)),
        }),
      ),
    );
  program
    .command("show")
    .description("What this project is installed as and the loop it runs")
    .requiredOption("--project <dir>")
    .action((options: { project: string }) => {
      const root = path.resolve(options.project);
      let chosen = null;
      try {
        chosen = readSelectedLoop(root);
      } catch {
        chosen = null;
      }
      print({
        package: readManifest(root).name,
        profile: installedRole(root),
        entry_role: entryRoleOf(root),
        session_role: entryRole(root),
        loop: chosen,
      });
    });
  runCli(program);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli();
