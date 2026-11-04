---
name: publish
description: Publish this whole project to the community library, as an example any project can start from — what it is, its task loop and values, every loop and role that is its own — once the owner has reviewed exactly what leaves; one pull request.
side: framework
kind: on-request
triggers: record-trajectory, guard-owner-answers
check-args: [{}]
---

# Publish

## Purpose

A project is edited and run in the Studio; it is published to the community library, agent-loop-community, where any project can start from it. Publishing puts the whole project there, under `projects/<name>/`: what it is and which task loop it runs with which values (`reference.json`), and every loop and role that is its own, the ones it made, the ones it got from the example it started from, and its versions of the framework's base ones. The framework's base loops and roles it left as they were are not copied: every project gets them. Its data, keys, task and run records stay here. The owner publishes when they decide to, once one of the project's tasks has finished, and again whenever the project has moved on; each publication is one pull request that the community's maintainers review, opened only once the owner approved exactly what leaves.

## Inputs

- `answers`: the owner's replies so far, by review id; the session adds each one as it comes (see `running-loops.md`).

## Steps

1. **Plan** — `project-publisher` writes what the project is, for `reference.json` (a title and a description, in Chinese and English, from the project and the owner's words), and plans the publication (`{action: "plan", name, exclude, notes}`): a status, the name it is published under, every loop and role that would leave with its judgement of each, what stays out and why, what the community's copy has that the project no longer does, the defects the check found, whether the project's own check is required, and the plan's digest. `not-eligible`, `nothing` and `unavailable` end the loop with the reason; `no-library` goes to step 2.
2. **Checkout** — `owner-review` asks whether to fetch a checkout of the community library from the address the plan names (`review_id` `clone:<address>`). On approval `project-publisher` clones it (`{action: "clone"}`) and the loop plans again; otherwise the loop ends.
3. **Own check** — when the plan says the project's own check is required, the child loop `publish-check` checks exactly the files that would leave and records its verdict on the plan's digest (`{digest, files}`); its waiting result is returned as it is.
4. **Review** — `owner-review` puts the publication to the owner (`review_id` `publish:<digest>`): what the project is, every loop and role with its judgement and warnings, what stays out and why, what would be removed, the check, and the own check's verdict with its findings. Approval publishes exactly this, and is possible only when the check found no defect and the own check, when required, passed. On `revise`, the owner's words (what to leave out or put back, a better title or description, another name) go back to step 1 as `notes`; on `cancel` the loop ends.
5. **Publish** — on approval, `project-publisher` publishes exactly that plan (`{action: "publish", name, digest, exclude}`), and the loop ends with the pull request, or with what stood in its way.

## Bounds

At most 6 plans per run: the first, and one after each review or checkout.

## Waiting

Steps 2, 3 and 4 wait for the owner, step 3 in its child loop: the loop returns `{waiting: "owner", review_id, question, document}`, and the session runs it again with the reply in `answers`.

## Triggers

- `record-trajectory`: every role that finishes leaves its trajectory.
- `guard-owner-answers`: every answer the session passes in is the owner's own message, typed after the loop stopped at that review; anything else is blocked before the loop runs.
