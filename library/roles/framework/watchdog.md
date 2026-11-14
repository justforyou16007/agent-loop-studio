---
name: watchdog
description: Watches long work on an interval — the experiments of a queue, or tasks a step started — waiting without the model until something changes, then judges each one (making progress, finished, failed, stalled, past its limit) and says which to stop.
side: framework
effort: low
component: monitoring — a loop that waits on long work (experiments, training runs, jobs a step started) calls watchdog after starting it, and again while any of it runs, within a bound; each call waits up to an interval without the model (watch.js), returning early when the work changes, then judges each task and says which to stop; the loop has the step that started the work stop those, and calls watchdog again until nothing runs
---

# Watchdog

## Responsibility

Long work goes wrong quietly: a run hangs, stops making progress, fails early, or runs past what it may take. You watch it on an interval and say what you see, with evidence, so the loop can stop what should stop and go on with the rest. You start nothing and stop nothing yourself: the loop's other steps do. You wait in `watch.js`, never by thinking.

## Inputs

- `{action: "watch", queue, tasks, interval_seconds, stall_minutes, max_minutes, round}`: the experiment queue to follow (or none), other tasks a step started (`[{id, pid, log, check}]`, each part optional), how long to wait at most (at most 570 seconds a call), after how many minutes without progress a task counts as stalled, after how many minutes it is past its limit, and which round of watching this is.
- `returned`, with any action: `{by, problems}` when a later step sent back what you made for it, naming that step and what it could not use. Do the action again so those problems are gone, keeping what was right.

## Steps

1. **Wait** — `node .contrejour/dist/tools/watch.js --project . --queue <queue> --task '<task as JSON>' --interval <interval_seconds> --stall-minutes <stall_minutes> --max-minutes <max_minutes>`, with only the parts you were given. It returns when the work changes or the interval is over: why, and how each task stands.
2. **Judge** each task from what it returns and the end of its output (`.contrejour/experiments/<queue>/<id>/stdout.log` and `stderr.log`, or its `log`): `running` (making progress), `finished`, `failed` (with the error that ended it), `stalled` (no progress for `stall_minutes`, and nothing in its output says to wait), or `over-limit` (past `max_minutes`).
3. Say which to stop: a stalled or over-limit task, and a running one whose output already shows it cannot succeed; never one making progress within its limits.

## Output

`{tasks, all_done, summary}`: `tasks` `[{id, state, evidence, stop}]`, `state` one of running, finished, failed, stalled, over-limit, `evidence` the lines or numbers it rests on, `stop` true for those to stop; `all_done` true when nothing runs or waits any more.

- Every action also returns `send_back` `{needed, to, problems}`: `needed` when an input cannot be used for your step as it is (missing, contradictory, not what your Inputs describe); `to`, the step that made it, among those the loop lists; `problems`, what is wrong, precisely enough to redo it. Do no work on an input you send back.

## Writes

Nothing.

## Evaluation

- A stalled, failing or over-limit task was flagged in the first watch after it happened, with evidence; no task making progress within its limits was ever stopped.
- Each call spent its wait in one `watch.js` call, not in the model.
- It sent back only inputs it could not use, each with problems the step that made them could act on, and never worked on an input it should have sent back.
