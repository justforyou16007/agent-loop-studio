---
name: upstream-optimization
description: Send this project's improvements to loops and roles a library gave it — its fixed roles above all — back to that library, the framework's, the community's or its package's — a plan with a judgement of each file, the project's own check when it has one, the owner's review of exactly that plan, then one pull request per library.
side: framework
kind: on-request
triggers: record-trajectory, guard-owner-answers
check-args: [{}]
---

# Upstream optimization

## Purpose

A project improves the loops and roles it was given: `trajectory-optimizer` fixes roles from what their trajectories show, and the owner changes loops and roles in the Studio. Those improvements belong where each loop or role came from, so that every project that gets it gets them too: the framework's base loops and roles go back to agent-loop-studio, the community's to agent-loop-community, a package's own to that package. This loop sends them back, each to its library, once the owner has approved exactly what leaves; each library gets its own pull request, which its maintainers review. What the project made itself is not an improvement: `library-contribution` shares it. The owner runs this loop when they want to, any time after one task has finished.

## Inputs

- `answers`: the owner's replies so far, by review id; the session adds each one as it comes (see `running-loops.md`).

## Steps

1. **Plan** — `library-contributor` plans what would go back (`{action: "plan", purpose: "upstream", exclude, notes}`): a status, the units it would send with the library each goes to and its judgement of each, what it would not send and why, the files that would leave, the defects the library check found in the result, whether the project's own check is required, and the plan's digest. `not-eligible`, `nothing` and `unavailable` end the loop with the reason; `no-library` goes to step 2.
2. **Checkout** — `owner-review` asks whether to fetch a checkout of the repository this project was installed from, at the address the plan names (`review_id` `clone:<address>`). On approval `library-contributor` clones it (`{action: "clone", purpose: "upstream"}`) and the loop plans again; otherwise the loop ends.
3. **Own check** — when the plan says the project's own check is required, the child loop `contribution-check` checks exactly the files that would leave and records its verdict on the plan's digest (`{digest, files}`); its waiting result is returned as it is.
4. **Review** — `owner-review` puts the plan to the owner (`review_id` `upstream:<digest>`): every unit with the library it goes back to, its judgement and warnings, what was left out and why, the library check, and the own check's verdict with its findings. Approval is possible only when the library check found no defect and the own check, when required, passed. On `revise`, the owner's words go back to step 1 as `notes`; on `cancel` the loop ends.
5. **Send** — on approval, `library-contributor` sends exactly that plan (`{action: "contribute", purpose: "upstream", digest, exclude}`), and the loop ends with the pull requests, one per library, or with what stood in their way.

## Bounds

At most 6 plans per run: the first, and one after each review or checkout.

## Waiting

Steps 2, 3 and 4 wait for the owner, step 3 in its child loop: the loop returns `{waiting: "owner", review_id, question, document}`, and the session runs it again with the reply in `answers`.

## Triggers

- `record-trajectory`: every role that finishes leaves its trajectory.
- `guard-owner-answers`: every answer the session passes in is the owner's own message, typed after the loop stopped at that review; anything else is blocked before the loop runs.
