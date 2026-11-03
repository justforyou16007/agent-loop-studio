---
name: project-setup
description: The steps of setup and of the framework's configure — what the project is for, task.md, proposing the task loop and its parameter values from the loops that fit, making it the task loop, checking the loops, and the hand-off that marks the project set up.
side: framework
effort: high
---

# Project setup

## Responsibility

Every project is set up by the framework's `setup` loop: what is particular to the project first (its `configure` loop), then the loop the project runs and its parameter values, a check of its loops, and a hand-off. You do setup's own steps, and the steps of the framework's `configure`, which a project built on the framework alone uses: what the project is for and its `task.md`. A package's side gives its projects a `configure` of its own, done by its own roles; then you do only setup's steps, and you take what that configuration settled as it is.

Every decision is the owner's, made at the loop's `owner-review` steps: you propose, the owner approves or says what to change, and you never ask the owner yourself, never call a role and never run a loop. You read this project's rules (`.claude/skills/shared-references/project-rules.md`) when the project has them: they may say how its task loops are run and what a hand-off must tell the owner.

## Inputs

JSON from the loop; `notes` carries the owner's words, verbatim:

- `{action: "requirement", requirement, notes}` and `{action: "task", requirement, notes}`, as steps of the framework's `configure`.
- `{action: "propose", candidates, notes}`, `{action: "use", loop, params}`, `{action: "check"}` and `{action: "handoff", configured, loop, params, check}`, as steps of `setup`. `candidates` are `loop-query`'s, best first, each `{loop, source, current, why}`; `configured` is the report the project's configuration returned.
- This project: `task.md`, `.claude/loops/` and the library's loops (`library/loops/<side>/` in the checkouts recorded in `.contrejour/install.json`), `.contrejour/loop.json` (the task loop chosen now, if any).

## Steps

### requirement

The requirement says what the project is for: what it should produce or achieve, what counts as done or good, and anything that limits how (data, tools, time, cost). When `requirement` and `notes` together say enough to write the task, restate the requirement in a few lines. Otherwise set `needs_owner` and write `request`: one open question for what is missing. A bare "start", or a request that names nothing, says nothing yet.

### task

`task.md` at the project root is the task the project works on; every task loop reads it. Describe what to achieve and how to tell it is achieved, not how to do it.

- When it is missing, or holds only the starter text a new project gets, write it from the requirement, as UTF-8 text; when `notes` ask for changes, make them. Then set `needs_owner`: the owner reviews what you wrote.
- When the owner wrote it and `notes` ask for nothing, leave it as it is and set `needs_owner` false.

Return `task_file`, `digest` (the sha256 of the file, `sha256sum task.md`) and a `summary` of what you wrote or changed.

### propose

1. Read `task.md` and each candidate's definition: its Purpose, Steps and Parameters with their defaults and what each changes.
2. When `notes` ask for a loop none of the candidates is, or for a change to one of them, set `build` and write `description`: what the loop must do, in the owner's words, with what the task needs from it and the candidate it should be built on, if any. Leave `loop` empty and `params` empty.
3. Otherwise pick the loop that fits the task best: the one `notes` name; else the current task loop while it still fits; else the best candidate. Propose its parameter values: the defaults, except where the task or `notes` call for another value, and only values its Parameters allow. `params` holds every parameter, by name.
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

1. What the project's configuration settled: `configured`, as it is.
2. The task loop and its parameter values, and what it does.
3. The checks: passed, or each defect left with what to do about it.
4. How to start the work, as this project's rules say; without rules: run the task loop from the Studio, or open a session in the project with `claude --permission-mode bypassPermissions "start"`, since the loop runs unattended and must not wait for approvals (`auto` instead has a classifier review each step, which may refuse some).
5. What the owner may do later, each when they decide to: change the project's loops and roles in the Studio; send the project's improvements to the loops and roles it was given back where they came from (`upstream-optimization`); share the loops and roles it made with other projects (`library-contribution`).

Then record that the project is set up, and return the report:

```bash
node .contrejour/dist/tools/project-cli.js finish-setup --project .
```

## Output

- `requirement`: `{needs_owner, requirement, request}`.
- `task`: `{needs_owner, task_file, digest, summary}`.
- `propose`: `{build, description, loop, params, summary}`.
- `use`: `{failed, reason, loop, params}`.
- `check`: `{stale, defects}`.
- `handoff`: `{report}`.

## Writes

`task.md`, in the framework's `configure`. Through the helpers only: `.contrejour/loop.json` (`project-cli.js use`) and `.contrejour/setup.json` (`project-cli.js finish-setup`).

## Evaluation

- **Task**: the task loop's roles found in `task.md` what they needed; the owner did not have to rewrite it after the first runs.
- **Proposal**: the owner approved the first proposal, or changed only what they knew better; the loop and values proposed were still in use after the first runs, and no value the loop's Parameters do not allow was proposed.
- **Building**: a new loop was described only when the owner asked for one none of the candidates was.
- **Hand-off**: the owner started the work from the report without asking how; every defect the checks found was named in it.
- **Ownership**: `.contrejour/loop.json` and `.contrejour/setup.json` written only through the helpers; helper failures returned with their cause, not worked around.
