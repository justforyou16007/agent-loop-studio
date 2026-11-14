#!/usr/bin/env node
/**
 * The watchdog's wait. It follows long work for up to an interval without the
 * model: the experiments of a queue, and any other task given by its process,
 * its progress file or a check command. It returns as soon as something changes
 * (one ends, one's progress file stops growing for too long, one runs past its
 * limit, nothing runs any more) or when the interval is over, with how each
 * stands; the check commands run once, then. The watchdog role judges what it
 * returns.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCli, runCli } from "../lib/cli.js";
import { experimentRows, type ExperimentRow } from "./experiments.js";
import { failA1, isRecord } from "./validate.js";

/** A task followed outside a queue: by its process, its progress file, or a command that says how it stands. */
export interface WatchedTask {
  id: string;
  pid?: number;
  log?: string;
  check?: string[];
}
export interface TaskRow {
  id: string;
  /** Whether its process lives; null when it has none to follow. */
  alive: boolean | null;
  log: { file: string; bytes: number; quiet_minutes: number } | null;
  check?: { exit_code: number | null; output: string };
}
export interface WatchResult {
  /** Why the wait ended. */
  why: string[];
  waited_seconds: number;
  experiments: ExperimentRow[];
  tasks: TaskRow[];
}
/** A role's command runs for at most 10 minutes: a longer wait is several calls. */
export const MAX_INTERVAL_SECONDS = 570;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
function taskRow(root: string, task: WatchedTask, check: boolean): TaskRow {
  let log: TaskRow["log"] = null;
  if (task.log) {
    const file = path.resolve(root, task.log);
    try {
      const stat = fs.statSync(file);
      log = {
        file: path.relative(path.resolve(root), file),
        bytes: stat.size,
        quiet_minutes: Math.round(((Date.now() - stat.mtimeMs) / 60_000) * 10) / 10,
      };
    } catch {
      log = { file: task.log, bytes: 0, quiet_minutes: 0 };
    }
  }
  const row: TaskRow = { id: task.id, alive: task.pid ? alive(task.pid) : null, log };
  if (check && task.check) {
    const ran = spawnSync(task.check[0]!, task.check.slice(1), {
      cwd: path.resolve(root),
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
    });
    row.check = {
      exit_code: ran.status,
      output: `${ran.stdout ?? ""}${ran.stderr ?? ""}`.trim().split("\n").slice(-20).join("\n"),
    };
  }
  return row;
}
export function checkedTask(value: unknown): WatchedTask {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id)
    failA1("INVALID_VALUE", "a task to watch is {id, pid?, log?, check?}");
  if (value.check !== undefined && (!Array.isArray(value.check) || !value.check.length))
    failA1("INVALID_VALUE", `${value.id}: check is a command as an argv array`);
  return {
    id: value.id,
    ...(typeof value.pid === "number" ? { pid: value.pid } : {}),
    ...(typeof value.log === "string" ? { log: value.log } : {}),
    ...(Array.isArray(value.check) ? { check: (value.check as unknown[]).map(String) } : {}),
  };
}

/** Wait until something about the work changes, or the interval is over. */
export async function watch(
  root: string,
  options: {
    queue?: string;
    tasks: WatchedTask[];
    interval: number;
    poll: number;
    stallMinutes: number;
    maxMinutes: number;
  },
): Promise<WatchResult> {
  if (!(options.interval > 0 && options.interval <= MAX_INTERVAL_SECONDS))
    failA1(
      "INVALID_VALUE",
      `a wait is at most ${MAX_INTERVAL_SECONDS} seconds, since a role's command runs at most 10 minutes: call it again to wait longer`,
    );
  if (!options.queue && !options.tasks.length)
    failA1("INVALID_VALUE", "give a queue or a task to watch");
  const started = Date.now();
  const first = options.queue ? experimentRows(root, options.queue) : [];
  const runningAtStart = new Set(
    first.filter((row) => row.state === "running").map((row) => row.id),
  );
  const aliveAtStart = new Set(
    options.tasks.filter((task) => task.pid && alive(task.pid)).map((task) => task.id),
  );
  for (;;) {
    const experiments = options.queue ? experimentRows(root, options.queue) : [];
    const tasks = options.tasks.map((task) => taskRow(root, task, false));
    const why: string[] = [];
    for (const row of experiments) {
      if (runningAtStart.has(row.id) && row.state !== "running") why.push(`${row.id} ${row.state}`);
      if (row.state !== "running") continue;
      if (row.log.quiet_minutes !== null && row.log.quiet_minutes >= options.stallMinutes)
        why.push(`${row.id}: no progress for ${row.log.quiet_minutes} minutes`);
      if (row.minutes >= options.maxMinutes)
        why.push(
          `${row.id}: running for ${row.minutes} minutes, past its limit of ${options.maxMinutes}`,
        );
    }
    for (const row of tasks) {
      if (aliveAtStart.has(row.id) && row.alive === false) why.push(`${row.id} ended`);
      if (row.log && row.alive !== false && row.log.quiet_minutes >= options.stallMinutes)
        why.push(`${row.id}: no progress for ${row.log.quiet_minutes} minutes`);
    }
    const running =
      experiments.some((row) => row.state === "running" || row.state === "pending") ||
      tasks.some((row) => row.alive === true || (row.alive === null && row.log !== null));
    if (!running && !why.length) why.push("nothing is running");
    const waited = (Date.now() - started) / 1000;
    if (!why.length && waited >= options.interval) why.push("the interval passed");
    if (why.length)
      return {
        why,
        waited_seconds: Math.round(waited),
        experiments: options.queue ? experimentRows(root, options.queue, true) : [],
        tasks: options.tasks.map((task) => taskRow(root, task, true)),
      };
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(options.poll, Math.max(1, options.interval - waited)) * 1000),
    );
  }
}

function cli(): void {
  const program = createCli("watch", "Wait on long work until it changes, without the model");
  program
    .requiredOption("--project <dir>")
    .option("--queue <name>", "the experiment queue to follow")
    .option(
      "--task <json>",
      "another task to follow: {id, pid?, log?, check?} (repeat for more)",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option(
      "--interval <seconds>",
      `how long to wait at most (at most ${MAX_INTERVAL_SECONDS})`,
      "300",
    )
    .option("--poll <seconds>", "how often to look", "15")
    .option("--stall-minutes <n>", "a progress file quiet this long is reported", "30")
    .option("--max-minutes <n>", "an experiment running this long is reported", "120")
    .action(
      async (options: {
        project: string;
        queue?: string;
        task?: string[];
        interval: string;
        poll: string;
        stallMinutes: string;
        maxMinutes: string;
      }) => {
        try {
          const tasks = (options.task ?? []).map((text) => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(text);
            } catch {
              failA1("INVALID_VALUE", `a task to watch is JSON: ${text}`);
            }
            return checkedTask(parsed);
          });
          const result = await watch(options.project, {
            ...(options.queue ? { queue: options.queue } : {}),
            tasks,
            interval: Number(options.interval),
            poll: Math.max(1, Number(options.poll) || 15),
            stallMinutes: Number(options.stallMinutes) || 30,
            maxMinutes: Number(options.maxMinutes) || 120,
          });
          console.log(JSON.stringify(result, null, 2));
        } catch (error) {
          console.error(
            JSON.stringify(
              {
                status: "failed",
                reason: (error as { code?: string }).code ?? "watch_failed",
                message: (error as Error).message,
              },
              null,
              2,
            ),
          );
          process.exitCode = 1;
        }
      },
    );
  runCli(program);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli();
