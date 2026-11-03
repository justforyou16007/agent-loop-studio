---
name: configure
description: Setup's first step — what is particular to this project. The framework's asks what the project is for and writes task.md; a package's side gives its projects a configure of its own instead.
side: framework
kind: on-request
triggers: record-trajectory, guard-owner-answers
check-args: [{"requirement": "start"}, {"requirement": "Summarize each week's new papers on retrieval."}]
---

# Configure

## Purpose

Settling what is particular to this project, as the first step of `setup`. For a project built on the framework alone that is what the project is for and the task it works on, `task.md`. A package whose projects need more — a machine's connection, a benchmark, a service, the machine's environment — gives its side a `configure` of its own, which takes this one's place; `setup` runs whichever the project has, so setting a project up is the same for every project and only this step differs. The owner also runs it alone when that part of the project changes.

## Inputs

- `requirement`: the owner's words about what the project is for, verbatim; it may be empty or just "start".
- `answers`: the owner's replies so far, by review id; the session adds each one as it comes (see `running-loops.md`).

## Steps

1. **Requirement** — `project-setup` reads the requirement and the owner's later words (`{action: "requirement", requirement, notes}`): when they say what the project is for, it restates them in a few lines; otherwise it says what it needs to know, `owner-review` asks the owner (`review_id` `requirement:<round>`), and their words come back as `notes`.
2. **Task** — `project-setup` writes `task.md` from the requirement when it is missing, or revises it as the owner's words ask (`{action: "task", requirement, notes}`). When it wrote or changed it, `owner-review` shows it (`review_id` `task:<digest>`). Approval goes on; `revise` sends the owner's words back to this step; `cancel` ends the loop. A `task.md` the owner wrote and this loop did not change needs no review.

The loop ends with `{done: true, requirement, report}`: the requirement as restated, and what was settled, for setup's hand-off.

## Bounds

3 requirement rounds, 6 task rounds.

## Waiting

Steps 1 and 2 wait for the owner: the loop returns `{waiting: "owner", review_id, question, document}`, and the session runs it again with the reply in `answers`.

## Triggers

- `record-trajectory`: every role that finishes leaves its trajectory.
- `guard-owner-answers`: every answer the session passes in is the owner's own message, typed after the loop stopped at that review; anything else is blocked before the loop runs.
