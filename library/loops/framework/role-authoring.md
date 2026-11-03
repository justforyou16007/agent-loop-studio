---
name: role-authoring
description: Create or change a role from the owner's description — find the roles that already do the work, draft the role on the closest (from scratch only when the owner asks), check it and install it once the owner approves.
side: framework
kind: on-request
triggers: record-trajectory, guard-owner-answers
check-args: [{"description": "A role that checks each claim in a draft report against the sources the wiki holds."}]
---

# Role authoring

## Purpose

How a project gets a new role, or a changed one at the owner's request: when work needs a step no role does, a role is added, never code that belongs to no role. The loop first finds the roles that already do the work, in this project and the library; the role is built on the closest one rather than written over, and installed only when the owner has approved that exact version. A role is written from scratch only when the owner asks for that. Fixes that trajectories show are `trajectory-optimizer`'s, not this loop's.

## Inputs

- `description`: what the owner wants, verbatim.
- `answers`: the owner's replies so far, by review id.

## Steps

1. **Find** — `role-creator` finds the roles of this project and the library that do this work or come close (`{action: "find", description}`): ranked candidates, whether a role of this project already does exactly this (`reuse`), and whether the owner asked for a role from scratch.
2. **Reuse** — when a role already does exactly this, `owner-review` asks whether to use it as it is (`review_id` `reuse-role:<role>`). Approval ends the loop with that role; `revise` goes on to step 3 with the owner's words; `cancel` ends the loop.
3. **Draft** — `role-creator` drafts the role in `.contrejour/drafts/` on the closest candidate, or from scratch when the owner asked, checks it and returns what it is built on, what differs, the check and the draft's digest (`{action: "draft", description, candidates, from_scratch, draft, notes}`).
4. **Review** — `owner-review` puts the draft to the owner (`review_id` `role:<role>:<digest>`): the role, what it is built on and what differs, and the check. Approval is possible only when the check passes. `revise` goes back to step 3 with the owner's words; `cancel` goes to step 6.
5. **Install** — on approval, `role-creator` installs exactly that version (`{action: "install", draft, digest}`), and the loop ends with the role's name.
6. **Discard** — when the owner cancels, or no version was approved within the bound, `role-creator` removes the draft (`{action: "discard", draft}`).

## Bounds

At most 4 drafts per run.

## Waiting

Steps 2 and 4 wait for the owner: the loop returns `{waiting: "owner", review_id, question, document}`, and the session runs it again with the reply in `answers`.

## Triggers

- `record-trajectory`: every role that finishes leaves its trajectory.
- `guard-owner-answers`: every answer the session passes in is the owner's own message, typed after the loop stopped at that review; anything else is blocked before the loop runs.
