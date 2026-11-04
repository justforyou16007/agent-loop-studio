---
name: project-setup
description: The steps of setup, which sets up a project's workflow — the owner's goal for it, proposing the task loop and its parameter values from the loops that fit, making it the task loop, checking the loops, and the hand-off that marks the project set up.
side: framework
effort: high
---

# Project setup

## Responsibility

Every project's workflow is set up by the framework's `setup` loop: the owner's goal for the project's work, the loop the project runs to do it and its parameter values, a check of its loops, and a hand-off. You do those steps. What the project works on, and whatever else is particular to it, is the project's: you read `task.md` when the project has one, and never write it.

Every decision is the owner's, made at the loop's `owner-review` steps: you propose, the owner approves or says what to change, and you never ask the owner yourself, never call a role and never run a loop. You read this project's rules (`.claude/skills/shared-references/project-rules.md`) when the project has them: they may say how its task loops are run and what a hand-off must tell the owner.

## Inputs

JSON from the loop; `notes` carries the owner's words, verbatim:

- `{action: "goal", goal, notes}`, `{action: "propose", goal, candidates, notes}`, `{action: "use", loop, params}`, `{action: "check"}` and `{action: "handoff", goal, loop, params, check}`. `candidates` are `loop-query`'s, best first, each `{loop, source, current, why}`.
- This project: `task.md` when it has one, `.claude/loops/` and the library's loops (`library/loops/<side>/` in the checkouts recorded in `.contrejour/install.json`), `.contrejour/loop.json` (the task loop chosen now, if any).

## Steps

### goal

The goal says what the project's work should be, as a workflow does it: what it produces round after round, what counts as done or good, how often it should stop for the owner, and anything that limits how. Read the owner's words with what the project already says about its work: `task.md` when it has one, and its current task loop. When they say enough to choose a workflow, restate the goal in a few lines. Otherwise set `needs_owner` and write `request`: one open question for what is missing. A bare "start", in a project that says nothing about its work yet, says nothing yet.

### propose

1. Read the goal, `task.md` when the project has one, and each candidate's definition: its Purpose, Steps and Parameters with their defaults and what each changes.
2. When `notes` ask for a loop none of the candidates is, or for a change to one of them, set `build` and write `description`: what the loop must do, in the owner's words, with what the task needs from it and the candidate it should be built on, if any. Leave `loop` empty and `params` empty.
3. Otherwise pick the loop that fits the goal best: the one `notes` name; else the current task loop while it still fits; else the best candidate. Propose its parameter values: the defaults, except where the goal or `notes` call for another value, and only values its Parameters allow. `params` holds every parameter, by name.
4. `summary`, for the owner: the loop and why it fits, what it does in a few lines, and each parameter with its value, saying for a changed one why.

### use

```bash
node .contrejour/dist/tools/project-cli.js use --project . --loop <loop> --param <name>=<value> ...
```

One `--param` for each parameter, its value as JSON (`--param rounds=3`, `--param mode='"fast"'`). It copies a library loop the project does not have yet, with the roles it lacks, and records the loop and its values in `.contrejour/loop.json`; never write that file yourself. Return `failed` false with the loop and its values as the helper reports them, or `failed` with the helper's error as `reason`.

### check

```bash
node .contrejour/dist/tools/loop-check.js check --project .
node .contrejour/dist/tools/loop-check.js roles --project .
```

Return in `stale` every loop that is stale or has defects, for the loop to regenerate, and in `defects` whatever else the checks report.

### handoff

Write the report for the owner, in the language they write in:

1. The goal, as the owner approved it.
2. The task loop and its parameter values, and what it does.
3. The checks: passed, or each defect left with what to do about it.
4. How to try the workflow before the real work: the `loop-trial` loop runs the task loop for real on a small scale and asks the owner whether what it did serves the goal, improving it between trials (`Run the loop-trial loop with args {"loop": "<loop>", "goal": "<the goal>"}`, or Trial in the Studio).
5. How to start the work, as this project's rules say; without rules: run the task loop from the Studio, or open a session in the project with `claude --permission-mode bypassPermissions "start"`, since the loop runs unattended and must not wait for approvals (`auto` instead has a classifier review each step, which may refuse some).
6. What the owner may do later, each when they decide to: change the project's loops and roles in the Studio, or run `setup` again; share the project's loops and roles with other projects through the community library (`library-contribution`).

Then record that the project is set up, and return the report:

```bash
node .contrejour/dist/tools/project-cli.js finish-setup --project .
```

## Output

- `goal`: `{needs_owner, goal, request}`.
- `propose`: `{build, description, loop, params, summary}`.
- `use`: `{failed, reason, loop, params}`.
- `check`: `{stale, defects}`.
- `handoff`: `{report}`.

## Writes

Through the helpers only: `.contrejour/loop.json` (`project-cli.js use`) and `.contrejour/setup.json` (`project-cli.js finish-setup`). Never `task.md`.

## Evaluation

- **Goal**: the owner accepted the restated goal in few rounds, and the workflow chosen for it was still the project's after its first runs.
- **Proposal**: the owner approved the first proposal, or changed only what they knew better; the loop and values proposed were still in use after the first runs, and no value the loop's Parameters do not allow was proposed.
- **Building**: a new loop was described only when the owner asked for one none of the candidates was.
- **Hand-off**: the owner started the work from the report without asking how; every defect the checks found was named in it.
- **Ownership**: `.contrejour/loop.json` and `.contrejour/setup.json` written only through the helpers; helper failures returned with their cause, not worked around.
