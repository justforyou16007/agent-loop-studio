/**
 * The runs of a loop, newest first, for the Studio's creation area: every run
 * any session in the project's folder started (the Studio's and the owner's
 * own), how it stands, and each role it ran with its state and output. A run is
 * the Workflow call that started it, the journal Claude Code keeps beside the
 * session's transcript (one line when a role starts, one when it gives its
 * result), and the notification that ended it.
 */
import fs from "node:fs";
import path from "node:path";
import { loopCalls, ownerWait, transcriptsDir } from "./session-record.js";
import { transcriptEntries } from "./session-timeline.js";
import type { LoopRun, RunStep } from "./studio-types.js";
import { isRecord } from "./validate.js";

/** How many of the project's sessions are read, newest first. */
const SESSIONS_READ = 60;
/** A run nothing said ended, in a session the Studio does not run: still working if its journal moved this recently. */
const QUIET_MS = 3 * 60_000;

const jsonLines = (file: string): Record<string, unknown>[] => {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line) => {
        try {
          const parsed: unknown = JSON.parse(line);
          return isRecord(parsed) ? [parsed] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
};

/** Each role a run started, in order: its phase, its role, whether it finished, when, and what it gave. */
function stepsOf(dir: string): RunStep[] {
  const steps: RunStep[] = [];
  for (const entry of jsonLines(path.join(dir, "journal.jsonl"))) {
    const key = typeof entry.key === "string" ? entry.key : "";
    if (!key) continue;
    if (entry.type === "started") {
      const agent = String(entry.agentId ?? "");
      let role = "";
      try {
        const meta: unknown = JSON.parse(
          fs.readFileSync(path.join(dir, `agent-${agent}.meta.json`), "utf8"),
        );
        if (isRecord(meta) && typeof meta.agentType === "string") role = meta.agentType;
      } catch {
        // The role's record is written a moment after it starts.
      }
      // When it started and last moved: its own transcript, as it grows.
      const own = transcriptEntries(path.join(dir, `agent-${agent}.jsonl`));
      const stamp = (index: number) => {
        const at = own.at(index)?.timestamp;
        return typeof at === "string" ? at : "";
      };
      steps.push({
        key,
        agent,
        phase: typeof entry.phase === "string" ? entry.phase : "",
        label: typeof entry.label === "string" ? entry.label : "",
        role,
        state: "running",
        started_at: stamp(0),
        ended_at: null,
        output: null,
      });
      continue;
    }
    if (entry.type !== "result") continue;
    const step = steps.find((known) => known.key === key);
    if (!step) continue;
    step.state = "done";
    step.output = "result" in entry ? entry.result : null;
    const own = transcriptEntries(path.join(dir, `agent-${step.agent}.jsonl`));
    const last = own.at(-1)?.timestamp;
    step.ended_at = typeof last === "string" ? last : step.started_at;
  }
  return steps;
}

/** How a run ended, from its notification: waiting for the owner, stopped, failed, or done. */
function endState(status: string, result: unknown): LoopRun["state"] {
  if (ownerWait(result)) return "waiting";
  if (/kill|stop|cancel|abort/i.test(status)) return "stopped";
  if (/fail|error/i.test(status)) return "failed";
  return "done";
}

/**
 * The runs of a loop (every loop's when none is named), newest first. A
 * session the Studio runs says through `session` which conversation it is and
 * whether it works now; a run nothing said ended is running while its session
 * works (or, in a session the Studio does not run, while its journal moves),
 * and stopped otherwise.
 */
export function loopRuns(
  root: string,
  query: { loop?: string; limit?: number } = {},
  session: (id: string) => { conversation: string; working: boolean } | null = () => null,
): LoopRun[] {
  const folder = path.join(transcriptsDir(), path.resolve(root).replace(/[^A-Za-z0-9]/g, "-"));
  if (!fs.existsSync(folder)) return [];
  const transcripts = fs
    .readdirSync(folder)
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => ({ file: path.join(folder, file), id: file.slice(0, -6) }))
    .map((entry) => ({ ...entry, changed: fs.statSync(entry.file).mtimeMs }))
    .sort((a, b) => b.changed - a.changed)
    .slice(0, SESSIONS_READ);
  const runs: LoopRun[] = [];
  for (const { file, id } of transcripts) {
    const known = session(id);
    for (const call of loopCalls(transcriptEntries(file))) {
      if (!call.run || (query.loop && call.loop !== query.loop)) continue;
      const dir = path.join(file.replace(/\.jsonl$/, ""), "subagents", "workflows", call.run);
      const steps = stepsOf(dir);
      const journal = path.join(dir, "journal.jsonl");
      const moved = fs.existsSync(journal) ? fs.statSync(journal).mtimeMs : 0;
      const state: LoopRun["state"] = call.ended
        ? endState(call.ended.status, call.ended.result)
        : known
          ? known.working
            ? "running"
            : "stopped"
          : Date.now() - moved < QUIET_MS
            ? "running"
            : "stopped";
      // A role a run stopped before it finished did not finish.
      if (state !== "running")
        for (const step of steps) if (step.state === "running") step.state = "stopped";
      runs.push({
        id: call.run,
        loop: call.loop,
        session: id,
        conversation: known?.conversation ?? null,
        started_at: call.at,
        ended_at: call.ended?.at || null,
        state,
        result: call.ended?.result ?? null,
        steps,
      });
    }
  }
  return runs
    .sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0))
    .slice(0, query.limit ?? 30);
}
