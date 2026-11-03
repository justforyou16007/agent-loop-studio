---
name: iterate-and-check
description: Work on the project's task in rounds — plan from the task and the project's memory, build, check against the task's criteria, record what worked and what did not — and stop for the owner's review when the check passes or the rounds run out.
side: framework
kind: task
triggers: record-trajectory, guard-owner-answers
check-args: [{}]
---

# Iterate and check

## Purpose

A general way to work on the task the owner wrote in `task.md`: plan, build, check, learn, and try again with what was learned. Every round leaves what it learned in the project's memory, so the next round, and the next run, start from it. A starting point: change it in the Studio to fit the work.

## Inputs

- `params`: the parameter values the owner chose in the Studio.
- `answers`: the owner's replies so far, by review id; the session adds each one as it comes (see `running-loops.md`).

## Steps

1. **Plan** — `planner` reads `task.md` and the project's memory and plans this round (`{action: "plan", round, findings}`): what to build, and the criteria the check applies.
2. **Build** — `builder` carries out the plan (`{action: "build", plan}`) and reports what it made and where.
3. **Check** — `checker` checks what was built against the criteria (`{action: "check", plan, criteria, built, files}`): whether it passed, with its findings.
4. **Record** — `project-memory` records the round (`{action: "record", what, outcome, evidence}`): what worked, or what failed and why. When the check failed and rounds are left, the loop goes back to step 1 with the findings.
5. **Review** — `owner-review` shows the owner the result (`review_id` `result:<round>`). Approval ends the loop with the result; `revise` goes back to step 1 with the owner's words as findings; `cancel` ends the loop.

## Bounds

At most `max_rounds` rounds before each review, and at most 3 reviews.

## Parameters

```json
[
  {
    "name": "max_rounds",
    "type": "integer",
    "default": 3,
    "min": 1,
    "max": 10,
    "description": "How many rounds of plan, build, check and record before the owner sees the result."
  }
]
```

## Waiting

Step 5 waits for the owner: the loop returns `{waiting: "owner", review_id, question, document}`, and the session runs it again with the reply in `answers`.

## Triggers

- `record-trajectory`: every role that finishes leaves its trajectory.
- `guard-owner-answers`: every answer the session passes in is the owner's own message, typed after the loop stopped at that review; anything else is blocked before the loop runs.
