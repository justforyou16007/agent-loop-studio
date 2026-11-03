---
name: library-contribution
description: Send what this project added or changed to the shared library as a pull request, once a task has finished — a plan with a judgement of each file, the owner's review of exactly that plan, then the pull request.
side: framework
kind: on-request
triggers: record-trajectory, guard-owner-answers
check-args: [{}]
---

# Library contribution

## Purpose

Experience reaches other projects through the shared library, the `library/` directory of the repository this project's loops and roles came from. This loop sends the loops and roles this project added or changed since it was installed, as one pull request that maintainers review, with the owner's approval of exactly what leaves. The owner runs it when they want to, any time after one submission has finished (its review ended and its result was published), and again whenever there is something new.

## Inputs

- `answers`: the owner's replies so far, by review id; the session adds each one as it comes (see `running-loops.md`).

## Steps

1. **Plan** — `library-contributor` plans what would leave (`{action: "plan", exclude, notes}`): a status, the units it would send with its judgement of each, what it would not send and why, the files that would leave, the defects the library check found in the result, and the plan's digest. `not-eligible`, `nothing` and `unavailable` end the loop with the reason; `no-library` goes to step 2.
2. **Checkout** — `owner-review` asks whether to fetch a checkout of that repository from the address the plan names (`review_id` `clone:<address>`). On approval `library-contributor` clones it (`{action: "clone"}`) and the loop plans again; otherwise the loop ends.
3. **Review** — `owner-review` puts the plan to the owner (`review_id` `contribution:<digest>`): every unit with its judgement and warnings, what was left out and why, and the library check. Approval is possible only when the library check found no defect. On `revise`, the owner's words go back to step 1 as `notes`; on `cancel` the loop ends.
4. **Contribute** — on approval, `library-contributor` sends exactly that plan (`{action: "contribute", digest, exclude}`), and the loop ends with the pull request, or with what stood in its way.

## Bounds

At most 6 plans per run: the first, and one after each review or checkout.

## Waiting

Steps 2 and 3 wait for the owner: the loop returns `{waiting: "owner", review_id, question, document}`, and the session runs it again with the reply in `answers`.

## Triggers

- `record-trajectory`: every role that finishes leaves its trajectory.
- `guard-owner-answers`: every answer the session passes in is the owner's own message, typed after the loop stopped at that review; anything else is blocked before the loop runs.
