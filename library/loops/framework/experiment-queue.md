---
name: experiment-queue
description: Run a stage's experiments as the owner's settings say — dispatch them, at most so many at once; have the watchdog follow them on an interval; stop the ones that stall, run past their limit or the settings stop; and report what came of each.
side: framework
kind: on-request
triggers: record-trajectory
component: experiments — a task loop's experiment stage (a step that runs experiments, trainings, benchmarks or other long jobs) runs them through this loop as a child loop: the step before it writes the experiments as commands ({id, run, cwd, check, stop, log}), this loop dispatches, follows and stops them as the owner's settings say (how many at once, how long each may run, when to stop the rest; the task loop declares them as its own parameters and passes them on), and the step after it reads the report; only a loop run directly can run it, since a loop runs another only one level deep
check-args: [{"queue": "probe", "experiments": [{"id": "one", "run": ["node", "-e", "console.log(1)"]}], "params": {"max_checks": 2}}, {"queue": "probe", "experiments": [{"id": "one", "run": ["node", "-e", "console.log(1)"]}], "params": {"max_checks": 2, "stop_rest_on": "first-success"}}, {"queue": "probe", "returned": {"by": "a step", "problems": ["probe"]}}]
trial-args: {"queue": "trial", "experiments": [{"id": "hello", "run": ["node", "-e", "console.log('hello')"]}], "params": {"max_parallel": 1, "max_checks": 3, "check_interval_seconds": 30}}
---

# Experiment queue

## Purpose

A stage of a task loop that runs experiments (trainings, benchmarks, long jobs) runs them here, as the owner set it up: at most so many at once, each for at most so long, the rest stopped once one succeeds or fails when the owner wants that. The experiments run detached from any role, under `experiments.js`; the watchdog follows them on an interval without spending the model on waiting, and says which stall, fail or run past their limit; those are stopped, the next ones dispatched, until none is left. The report says how each ended and where its output is, for the step after this loop to read.

## Inputs

- `queue`: the queue's name, unique to this run of the calling loop (such as `<loop>-<round>`).
- `experiments`: `[{id, run, cwd, check, stop, log}]`: `run` a command as an argv array; `cwd`, `check`, `stop` and `log` optional, `check` and `stop` the commands that follow and stop an experiment that runs elsewhere.
- `params`: the owner's settings (below), passed on by the calling loop.
- `returned`: when the calling step sent the report back: the queue's experiments are reported again with those problems, without running again.

## Steps

1. **Enqueue** — `experiment-runner` adds the experiments to the queue (`{action: "enqueue", queue, experiments}`).
2. **Dispatch** — `experiment-runner` starts waiting experiments until `max_parallel` run (`{action: "dispatch", queue, max_parallel}`).
3. **Watch** — `watchdog` waits up to `check_interval_seconds` for the queue to change, then judges each experiment and says which to stop (`{action: "watch", queue, interval_seconds, stall_minutes, max_minutes, round}`).
4. **Stop** — when the watchdog says to stop some, or `stop_rest_on` is not `never`, `experiment-runner` stops them and applies the setting (`{action: "stop", queue, stop, stop_rest_on, tasks}`). Unless the watchdog says all are done, the loop goes back to step 2.
5. **Report** — `experiment-runner` reports what came of each experiment (`{action: "report", queue}`), and the loop ends with it: `{queue, experiments, summary}`. With `returned`, the loop does only this step, with it.

## Bounds

At most `max_checks` watches; past them, the experiments still running or waiting are stopped and the loop reports. At most 2 send-backs in a row by any step.

## Send back

Every step checks what it receives against its role's Inputs. A step that cannot use an input sends it back (`send_back`) to the step that made it, which runs again with `returned` (that step and its problems); then the step runs again on what it makes. Dispatch may send the queue back to Enqueue; Watch may send the dispatch back to Dispatch; Stop and Report may send what the watchdog judged back to Watch. Enqueue may send the experiments back to the caller, whose step writes them again. Past 2 send-backs in a row, or when what a step cannot use is the loop's own input, the loop ends with `sent_back`: the step, where it sent the input, and the problems.

## Parameters

```json
[
  {
    "name": "max_parallel",
    "type": "integer",
    "default": 2,
    "min": 1,
    "max": 64,
    "description": "How many experiments run at once."
  },
  {
    "name": "max_minutes",
    "type": "integer",
    "default": 120,
    "min": 1,
    "description": "How long one experiment may run before the watchdog stops it."
  },
  {
    "name": "check_interval_seconds",
    "type": "integer",
    "default": 300,
    "min": 10,
    "max": 570,
    "description": "How long the watchdog waits between looks, at most; it looks sooner when an experiment ends."
  },
  {
    "name": "stall_minutes",
    "type": "integer",
    "default": 30,
    "min": 1,
    "description": "How long an experiment may go without progress (its output not growing) before it counts as stalled."
  },
  {
    "name": "stop_rest_on",
    "type": "enum",
    "choices": ["never", "first-success", "first-failure"],
    "default": "never",
    "description": "When to stop the experiments still running or waiting: never, once one succeeds, or once one fails."
  },
  {
    "name": "max_checks",
    "type": "integer",
    "default": 200,
    "min": 1,
    "max": 2000,
    "description": "How many times the watchdog looks before the rest are stopped and the queue reports."
  }
]
```

## Waiting

None: it runs unattended, as the settings say.

## Triggers

- `record-trajectory`: every role that finishes leaves its trajectory.
