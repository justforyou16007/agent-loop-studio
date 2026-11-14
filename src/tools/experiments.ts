#!/usr/bin/env node
/**
 * The experiments a loop dispatches, one queue per run of the `experiment-queue`
 * loop: `.contrejour/experiments/<queue>/queue.json` holds each experiment, the
 * command that runs it (an argv array, run without a shell) and how it stands.
 * Each runs under a supervisor of its own, detached from the role that started
 * it, which records when and how it ended (`<id>/status.json`) and keeps its
 * output (`<id>/stdout.log`, `<id>/stderr.log`). An experiment that runs
 * elsewhere, such as a cluster job, gives the commands that check it and stop
 * it. Roles decide what to dispatch, judge how the experiments go and which to
 * stop; this helper only does it.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCli, runCli } from "../lib/cli.js";
import { withStateFileLock, writeStateJsonAtomic } from "./state-file.js";
import { failA1, isRecord } from "./validate.js";

export interface ExperimentSpec {
  id: string;
  /** The command, as an argv array: the program, then its arguments. */
  run: string[];
  /** Where it runs, from the project's folder; the project's folder when left out. */
  cwd?: string;
  /** For work that runs elsewhere: a command whose output says how it stands. */
  check?: string[];
  /** For work that runs elsewhere: the command that stops it. */
  stop?: string[];
  /** The file that shows its progress, when not its standard output. */
  log?: string;
}
export type ExperimentState = "pending" | "running" | "finished" | "failed" | "stopped";
export interface Experiment extends ExperimentSpec {
  state: ExperimentState;
  started_at: string | null;
  ended_at: string | null;
  exit_code: number | null;
  /** Why it failed or was stopped. */
  reason: string | null;
  supervisor: number | null;
}
interface Queue {
  schema_version: 1;
  queue: string;
  experiments: Experiment[];
}
/** What the supervisor records. */
interface Supervised {
  supervisor: number;
  pid: number | null;
  started_at: string;
  ended_at?: string;
  exit_code?: number | null;
  signal?: string | null;
  error?: string;
}
/** How an experiment stands, as a role reads it. */
export interface ExperimentRow {
  id: string;
  state: ExperimentState;
  started_at: string | null;
  ended_at: string | null;
  exit_code: number | null;
  reason: string | null;
  /** Minutes it has run, or ran. */
  minutes: number;
  /** Its progress file: its size, and minutes since it last grew. */
  log: { file: string; bytes: number; quiet_minutes: number | null };
  /** The check command's exit code and the end of its output, when it has one and was asked. */
  check?: { exit_code: number | null; output: string };
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export function queueDir(root: string, queue: string): string {
  if (!NAME.test(queue))
    failA1(
      "INVALID_VALUE",
      `a queue's name is lowercase letters, digits, dots, dashes, not "${queue}"`,
    );
  return path.join(path.resolve(root), ".contrejour", "experiments", queue);
}
const queueFile = (dir: string) => path.join(dir, "queue.json");
const statusFile = (dir: string, id: string) => path.join(dir, id, "status.json");
const minutesBetween = (from: string | null, to: string | null): number =>
  from ? Math.max(0, ((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 60_000) : 0;

function readQueue(dir: string, queue: string): Queue {
  const file = queueFile(dir);
  if (!fs.existsSync(file)) return { schema_version: 1, queue, experiments: [] };
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!isRecord(parsed) || !Array.isArray(parsed.experiments))
    failA1("INVALID_VALUE", "the queue's record is not one the helper wrote", file);
  return parsed as unknown as Queue;
}
function readSupervised(dir: string, id: string): Supervised | null {
  try {
    return JSON.parse(fs.readFileSync(statusFile(dir, id), "utf8")) as Supervised;
  } catch {
    return null;
  }
}
/** Whether a process lives: one this user may not signal lives too. */
function alive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
const argv = (value: unknown, what: string): string[] => {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some((item) => typeof item !== "string" || !item)
  )
    failA1(
      "INVALID_VALUE",
      `${what} is a command as an argv array: the program, then its arguments`,
    );
  return value as string[];
};
function checkedSpec(value: unknown): ExperimentSpec {
  if (!isRecord(value)) failA1("INVALID_VALUE", "an experiment is an object");
  const id = String(value.id ?? "");
  if (!NAME.test(id))
    failA1(
      "INVALID_VALUE",
      `an experiment's id is lowercase letters, digits, dots, dashes, not "${id}"`,
    );
  return {
    id,
    run: argv(value.run, `${id}: run`),
    ...(value.cwd !== undefined ? { cwd: String(value.cwd) } : {}),
    ...(value.check !== undefined ? { check: argv(value.check, `${id}: check`) } : {}),
    ...(value.stop !== undefined ? { stop: argv(value.stop, `${id}: stop`) } : {}),
    ...(value.log !== undefined ? { log: String(value.log) } : {}),
  };
}

/** Bring the running experiments up to what their supervisors recorded. */
function refresh(dir: string, queue: Queue): void {
  for (const experiment of queue.experiments) {
    if (experiment.state !== "running") continue;
    const supervised = readSupervised(dir, experiment.id);
    if (supervised?.ended_at) {
      experiment.ended_at = supervised.ended_at;
      experiment.exit_code = supervised.exit_code ?? null;
      experiment.state = supervised.exit_code === 0 ? "finished" : "failed";
      experiment.reason =
        supervised.error ??
        (supervised.signal ? `ended by ${supervised.signal}` : null) ??
        (supervised.exit_code === 0 ? null : `exit code ${String(supervised.exit_code)}`);
    } else if (!alive(supervised?.pid ?? experiment.supervisor)) {
      experiment.state = "failed";
      experiment.ended_at = new Date().toISOString();
      experiment.reason = "it ended without its supervisor recording how";
    }
  }
}
function changed<T>(root: string, name: string, action: (dir: string, queue: Queue) => T): T {
  const dir = queueDir(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return withStateFileLock(queueFile(dir), () => {
    const queue = readQueue(dir, name);
    const result = action(dir, queue);
    writeStateJsonAtomic(queueFile(dir), queue);
    return result;
  });
}

/** Add experiments to a queue, waiting to be dispatched. */
export function addExperiments(root: string, name: string, specs: unknown): Experiment[] {
  if (!Array.isArray(specs) || !specs.length)
    failA1("INVALID_VALUE", "give the experiments as a JSON list");
  const checked = specs.map(checkedSpec);
  return changed(root, name, (_dir, queue) => {
    for (const spec of checked) {
      if (queue.experiments.some((known) => known.id === spec.id))
        failA1("ALREADY_EXISTS", `the queue ${name} already has ${spec.id}`);
      queue.experiments.push({
        ...spec,
        state: "pending",
        started_at: null,
        ended_at: null,
        exit_code: null,
        reason: null,
        supervisor: null,
      });
    }
    return queue.experiments;
  });
}

/** Start waiting experiments, in order, until `maxParallel` run at once. */
export function startExperiments(root: string, name: string, maxParallel: number): string[] {
  if (!Number.isInteger(maxParallel) || maxParallel < 1)
    failA1("INVALID_VALUE", "how many run at once is a whole number, 1 or more");
  return changed(root, name, (dir, queue) => {
    refresh(dir, queue);
    let running = queue.experiments.filter((known) => known.state === "running").length;
    const started: string[] = [];
    for (const experiment of queue.experiments) {
      if (running >= maxParallel) break;
      if (experiment.state !== "pending") continue;
      fs.mkdirSync(path.join(dir, experiment.id), { recursive: true });
      const supervisor = spawn(
        process.execPath,
        [
          fileURLToPath(import.meta.url),
          "supervise",
          "--project",
          path.resolve(root),
          "--queue",
          name,
          "--id",
          experiment.id,
        ],
        { detached: true, stdio: "ignore", windowsHide: true },
      );
      supervisor.unref();
      experiment.state = "running";
      experiment.started_at = new Date().toISOString();
      experiment.supervisor = supervisor.pid ?? null;
      started.push(experiment.id);
      running += 1;
    }
    return started;
  });
}

/** Run one experiment and record how it ends: the supervisor, started by `start`. */
function supervise(root: string, name: string, id: string): void {
  const dir = queueDir(root, name);
  const experiment = readQueue(dir, name).experiments.find((known) => known.id === id);
  if (!experiment) failA1("NOT_FOUND", `the queue ${name} has no ${id}`);
  const out = fs.openSync(path.join(dir, id, "stdout.log"), "a");
  const err = fs.openSync(path.join(dir, id, "stderr.log"), "a");
  const record = (fields: Partial<Supervised>) =>
    writeStateJsonAtomic(statusFile(dir, id), { ...readSupervised(dir, id), ...fields });
  const started = new Date().toISOString();
  record({ supervisor: process.pid, pid: null, started_at: started });
  const child = spawn(experiment.run[0]!, experiment.run.slice(1), {
    cwd: experiment.cwd ? path.resolve(root, experiment.cwd) : path.resolve(root),
    stdio: ["ignore", out, err],
    windowsHide: true,
    // Its own process group, so stopping it stops what it started too.
    detached: process.platform !== "win32",
  });
  record({ pid: child.pid ?? null });
  child.on("error", (error) => {
    record({ ended_at: new Date().toISOString(), exit_code: null, error: error.message });
    process.exit(0);
  });
  child.on("exit", (code, signal) => {
    record({ ended_at: new Date().toISOString(), exit_code: code, signal });
    process.exit(0);
  });
}

function tail(file: string, lines: number): string {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .slice(-lines - 1)
      .join("\n")
      .trim();
  } catch {
    return "";
  }
}
/** How each experiment stands; with `check`, the check commands of the running ones run too. */
export function experimentRows(root: string, name: string, check = false): ExperimentRow[] {
  const queue = changed(root, name, (dir, known) => {
    refresh(dir, known);
    return known;
  });
  const dir = queueDir(root, name);
  return queue.experiments.map((experiment) => {
    const file = experiment.log
      ? path.resolve(root, experiment.log)
      : path.join(dir, experiment.id, "stdout.log");
    let bytes = 0;
    let quiet: number | null = null;
    try {
      const stat = fs.statSync(file);
      bytes = stat.size;
      quiet = (Date.now() - stat.mtimeMs) / 60_000;
    } catch {
      quiet = experiment.started_at ? minutesBetween(experiment.started_at, null) : null;
    }
    const row: ExperimentRow = {
      id: experiment.id,
      state: experiment.state,
      started_at: experiment.started_at,
      ended_at: experiment.ended_at,
      exit_code: experiment.exit_code,
      reason: experiment.reason,
      minutes: Math.round(minutesBetween(experiment.started_at, experiment.ended_at) * 10) / 10,
      log: {
        file: path.relative(path.resolve(root), file),
        bytes,
        quiet_minutes: quiet === null ? null : Math.round(quiet * 10) / 10,
      },
    };
    if (check && experiment.check && experiment.state === "running") {
      const ran = spawnSync(experiment.check[0]!, experiment.check.slice(1), {
        cwd: experiment.cwd ? path.resolve(root, experiment.cwd) : path.resolve(root),
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
  });
}

/** Stop an experiment: its own stop command first, when it has one, then its process and what it started. */
export function stopExperiment(root: string, name: string, id: string, reason: string): Experiment {
  return changed(root, name, (dir, queue) => {
    refresh(dir, queue);
    const experiment = queue.experiments.find((known) => known.id === id);
    if (!experiment) failA1("NOT_FOUND", `the queue ${name} has no ${id}`);
    if (experiment.state === "running") {
      if (experiment.stop)
        spawnSync(experiment.stop[0]!, experiment.stop.slice(1), {
          cwd: experiment.cwd ? path.resolve(root, experiment.cwd) : path.resolve(root),
          timeout: 60_000,
          windowsHide: true,
        });
      const pid = readSupervised(dir, id)?.pid ?? null;
      if (pid && alive(pid)) {
        if (process.platform === "win32")
          spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
        else
          try {
            process.kill(-pid, "SIGTERM");
          } catch {
            try {
              process.kill(pid, "SIGTERM");
            } catch {
              // It ended on its own meanwhile.
            }
          }
      }
    }
    if (experiment.state === "running" || experiment.state === "pending") {
      experiment.state = "stopped";
      experiment.ended_at = new Date().toISOString();
      experiment.reason = reason || "stopped";
    }
    return experiment;
  });
}

/** What came of each experiment: how it ended, and the end of its output. */
export function experimentReport(root: string, name: string) {
  const rows = experimentRows(root, name);
  const dir = queueDir(root, name);
  return {
    queue: name,
    counts: Object.fromEntries(
      (["pending", "running", "finished", "failed", "stopped"] as const).map((state) => [
        state,
        rows.filter((row) => row.state === state).length,
      ]),
    ),
    experiments: rows.map((row) => ({
      ...row,
      stdout: tail(path.join(dir, row.id, "stdout.log"), 20),
      stderr: tail(path.join(dir, row.id, "stderr.log"), 20),
    })),
  };
}

function cli(): void {
  const program = createCli("experiments", "Dispatch, follow and stop a loop's experiments");
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  const failed = (error: unknown) => {
    console.error(
      JSON.stringify(
        {
          status: "failed",
          reason: (error as { code?: string }).code ?? "experiments_failed",
          message: (error as Error).message,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  };
  const run = (work: () => unknown) => {
    try {
      print(work());
    } catch (error) {
      failed(error);
    }
  };
  program
    .command("add")
    .description("Add experiments to a queue: a JSON list of {id, run, cwd?, check?, stop?, log?}")
    .requiredOption("--project <dir>")
    .requiredOption("--queue <name>")
    .requiredOption("--spec <json>", "the experiments, or @<file> to read them from a file")
    .action((options: { project: string; queue: string; spec: string }) =>
      run(() => {
        const text = options.spec.startsWith("@")
          ? fs.readFileSync(path.resolve(options.project, options.spec.slice(1)), "utf8")
          : options.spec;
        let specs: unknown;
        try {
          specs = JSON.parse(text);
        } catch {
          failA1("INVALID_VALUE", "the experiments are not JSON");
        }
        return addExperiments(options.project, options.queue, specs);
      }),
    );
  program
    .command("start")
    .description("Start waiting experiments until so many run at once")
    .requiredOption("--project <dir>")
    .requiredOption("--queue <name>")
    .requiredOption("--max-parallel <n>")
    .action((options: { project: string; queue: string; maxParallel: string }) =>
      run(() => ({
        started: startExperiments(options.project, options.queue, Number(options.maxParallel)),
      })),
    );
  program
    .command("status")
    .description("How each experiment stands; the running ones' check commands run too")
    .requiredOption("--project <dir>")
    .requiredOption("--queue <name>")
    .action((options: { project: string; queue: string }) =>
      run(() => experimentRows(options.project, options.queue, true)),
    );
  program
    .command("stop")
    .description("Stop an experiment, and say why")
    .requiredOption("--project <dir>")
    .requiredOption("--queue <name>")
    .requiredOption("--id <id>")
    .option("--reason <text>", "why it is stopped", "")
    .action((options: { project: string; queue: string; id: string; reason: string }) =>
      run(() => stopExperiment(options.project, options.queue, options.id, options.reason)),
    );
  program
    .command("report")
    .description("What came of each experiment: how it ended, and the end of its output")
    .requiredOption("--project <dir>")
    .requiredOption("--queue <name>")
    .action((options: { project: string; queue: string }) =>
      run(() => experimentReport(options.project, options.queue)),
    );
  program
    .command("supervise", { hidden: true })
    .requiredOption("--project <dir>")
    .requiredOption("--queue <name>")
    .requiredOption("--id <id>")
    .action((options: { project: string; queue: string; id: string }) =>
      supervise(options.project, options.queue, options.id),
    );
  runCli(program);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli();
