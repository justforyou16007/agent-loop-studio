---
name: library-contribution
description: Share the loops and roles this project made with other projects through the community library, when the owner decides to — a plan with a judgement of each file, the project's own check when it has one, the owner's review of exactly that plan, then the pull request.
side: framework
kind: on-request
triggers: record-trajectory, guard-owner-answers
check-args: [{}]
---

# Library contribution

## Purpose

Experience reaches other projects through the community library, agent-loop-community. When the owner decides to contribute, this loop sends the loops and roles this project made, the ones no library gave it, there, as one pull request that its maintainers review, with the owner's approval of exactly what leaves. Improvements to loops and roles a library gave the project are not contributions: `upstream-optimization` sends them back where they came from. The owner runs this loop when they want to, any time after one task has finished, and again whenever there is something new.

## Inputs

- `answers`: the owner's replies so far, by review id; the session adds each one as it comes (see `running-loops.md`).

## Steps

1. **Plan** — `library-contributor` plans what would be shared (`{action: "plan", purpose: "share", exclude, notes}`): a status, the units it would send with its judgement of each, what it would not send and why, the files that would leave, the defects the library check found in the result, whether the project's own check is required, and the plan's digest. `not-eligible`, `nothing` and `unavailable` end the loop with the reason; `no-library` goes to step 2.
2. **Checkout** — `owner-review` asks whether to fetch a checkout of the community library from the address the plan names (`review_id` `clone:<address>`). On approval `library-contributor` clones it (`{action: "clone", purpose: "share"}`) and the loop plans again; otherwise the loop ends.
3. **Own check** — when the plan says the project's own check is required, the child loop `contribution-check` checks exactly the files that would leave and records its verdict on the plan's digest (`{digest, files}`); its waiting result is returned as it is.
4. **Review** — `owner-review` puts the plan to the owner (`review_id` `contribution:<digest>`): every unit with its judgement and warnings, what was left out and why, the library check, and the own check's verdict with its findings. Approval is possible only when the library check found no defect and the own check, when required, passed. On `revise`, the owner's words go back to step 1 as `notes`; on `cancel` the loop ends.
5. **Contribute** — on approval, `library-contributor` sends exactly that plan (`{action: "contribute", purpose: "share", digest, exclude}`), and the loop ends with the pull request, or with what stood in its way.

## Bounds

At most 6 plans per run: the first, and one after each review or checkout.

## Waiting

Steps 2, 3 and 4 wait for the owner, step 3 in its child loop: the loop returns `{waiting: "owner", review_id, question, document}`, and the session runs it again with the reply in `answers`.

## Triggers

- `record-trajectory`: every role that finishes leaves its trajectory.
- `guard-owner-answers`: every answer the session passes in is the owner's own message, typed after the loop stopped at that review; anything else is blocked before the loop runs.
