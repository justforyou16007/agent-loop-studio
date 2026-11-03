---
name: contribution-check
description: The project's own check of exactly what would leave, when its rules ask for one — a step of library-contribution and upstream-optimization. The framework's puts the files to the owner; a package's side gives its projects a check of its own instead.
side: framework
kind: on-request
triggers: record-trajectory, guard-owner-answers
check-args: [{"digest": "0000000000000000000000000000000000000000000000000000000000000000", "files": [".contrejour/contributions/preview/after/agent-loop-community/library/roles/framework/example.md"]}]
---

# Contribution check

## Purpose

Some projects hold what must never leave them, and say so through their extension: then nothing they share or send upstream leaves before a check of their own has passed exactly those files, recorded on the plan's digest. A package whose projects need a particular check (a leak review against hidden tests, say) gives its side a `contribution-check` of its own, which takes this one's place. This one, for a project that asks for a check and has none of its own, makes the owner the check.

## Inputs

- `digest`: the digest of the plan whose files are checked.
- `files`: the paths of exactly the files that would leave.
- `answers`: the owner's replies so far, by review id; the session adds each one as it comes (see `running-loops.md`).

## Steps

1. **Check** — `owner-review` asks the owner to read exactly these files for anything this project's rules say must stay here (`review_id` `check:<digest>`). Approval passes them; `revise` fails them with the owner's words as the finding; `cancel` fails them.
2. **Record** — `library-contributor` records the verdict on the digest (`{action: "record-check", digest, verdict, findings}`), and the loop ends with it: `{verdict, findings}`.

## Bounds

One check per plan.

## Waiting

Step 1 waits for the owner: the loop returns `{waiting: "owner", review_id, question, document}`, and the session runs it again with the reply in `answers`.

## Triggers

- `record-trajectory`: every role that finishes leaves its trajectory.
- `guard-owner-answers`: every answer the session passes in is the owner's own message, typed after the loop stopped at that review; anything else is blocked before the loop runs.
