---
name: library-contribution
description: Contribute the loops and roles the owner chooses — ones this project made, and its own versions of ones it was given — to the community library, when the owner decides to; a plan with a judgement of each file, the project's own check when it has one, the owner's review of exactly that plan, then the pull request.
side: framework
kind: on-request
triggers: record-trajectory, guard-owner-answers
check-args: [{}]
---

# Library contribution

## Purpose

Experience reaches other projects through the community library, agent-loop-community. What a project improves, its roles fixed from their trajectories above all, stays in the project; whether any of it leaves is the owner's decision, and this loop is how it leaves. It lists the project's loops and roles that are new or changed since it was installed, the owner chooses which go, and exactly those go to the community library as one pull request that its maintainers review. The owner runs this loop when they want to, any time after one task has finished, and again whenever there is something new.

## Inputs

- `answers`: the owner's replies so far, by review id; the session adds each one as it comes (see `running-loops.md`).

## Steps

1. **Plan** — `library-contributor` plans what would be contributed (`{action: "plan", exclude, notes}`): a status, the units it would send with its judgement of each, what it would not send and why, the files that would leave, the defects the library check found in the result, whether the project's own check is required, and the plan's digest. `not-eligible`, `nothing` and `unavailable` end the loop with the reason; `no-library` goes to step 2.
2. **Checkout** — `owner-review` asks whether to fetch a checkout of the community library from the address the plan names (`review_id` `clone:<address>`). On approval `library-contributor` clones it (`{action: "clone"}`) and the loop plans again; otherwise the loop ends.
3. **Own check** — when the plan says the project's own check is required, the child loop `contribution-check` checks exactly the files that would leave and records its verdict on the plan's digest (`{digest, files}`); its waiting result is returned as it is.
4. **Review** — `owner-review` puts the plan to the owner (`review_id` `contribution:<digest>`): every unit with its judgement and warnings, what was left out and why, the library check, and the own check's verdict with its findings. The owner chooses what goes: approval sends exactly this plan, and is possible only when the library check found no defect and the own check, when required, passed. On `revise`, the owner's words (what to leave out or put back) go back to step 1 as `notes`; on `cancel` the loop ends.
5. **Contribute** — on approval, `library-contributor` sends exactly that plan (`{action: "contribute", digest, exclude}`), and the loop ends with the pull request, or with what stood in its way.

## Bounds

At most 6 plans per run: the first, and one after each review or checkout.

## Waiting

Steps 2, 3 and 4 wait for the owner, step 3 in its child loop: the loop returns `{waiting: "owner", review_id, question, document}`, and the session runs it again with the reply in `answers`.

## Triggers

- `record-trajectory`: every role that finishes leaves its trajectory.
- `guard-owner-answers`: every answer the session passes in is the owner's own message, typed after the loop stopped at that review; anything else is blocked before the loop runs.
