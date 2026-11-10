---
name: loop-authoring
description: Create or change a loop from the owner's description — find the loops it can be built on, draft it on the closest (from scratch only when the owner asks), offer a new task loop the base components it lacks, add the roles it needs, check it and install it once the owner approves; or regenerate a stale script from its unchanged definition.
side: framework
kind: on-request
triggers: record-trajectory, guard-owner-answers
check-args: [{"description": "A loop where one implementer fixes the problems the latest feedback names."}, {"regenerate": "iterate-and-check"}]
---

# Loop authoring

## Purpose

How a project gets a new or changed loop. The owner describes what the loop should do, in their own words. The loop first finds what already exists and builds the new loop on the closest existing one rather than starting over; it adds the roles the loop needs, built on the closest existing roles too; it checks the whole; and it installs it only when the owner has approved that exact version, so the project's loops and roles stay untouched until then. A loop is written from scratch only when the owner asks for that.

A new task loop is also offered the base components it lacks: the roles and loops that give a task loop a capability, such as memory (`project-memory`) and optimization (`trajectory-optimizer`), each saying in its frontmatter what it adds and where its step goes. The components the project has are found first; which of the new loop's loops (the task loop and the loops it runs as steps) should add which is then put to the owner; and the ones the owner confirms are added to the draft before its roles are drafted. The owner approves the whole draft afterwards, as for any loop.

It also regenerates the script of an installed loop whose definition is unchanged but whose script is stale or defective, without asking the owner: the owner already approved the definition, and the script is generated from it.

## Inputs

- `description`: what the owner wants, verbatim.
- `side`, `kind`: the side and kind the loop must have, when the caller knows them (a loop that asks for a task loop of its side passes both); otherwise the editor takes them from the description.
- `regenerate`: instead of the above, the name of an installed loop whose script is stale or defective.
- `answers`: the owner's replies so far, by review id.

## Steps

1. **Regenerate** — only with `regenerate`: `loop-editor` regenerates that loop's script from its definition and checks it (`{action: "regenerate", loop}`), and the loop ends with the result.
2. **Find** — `loop-query` finds the loops the requested one can be built on, in this project and the library (`{action: "find-base", description, side, kind}`): ranked candidates, whether a loop of this project already does exactly this (`reuse`), and whether the owner asked for a loop from scratch.
3. **Reuse** — when a loop already does exactly this, `owner-review` asks whether to use it as it is (`review_id` `reuse-loop:<loop>`). Approval ends the loop with that loop; `revise` goes on to step 4 with the owner's words; `cancel` ends the loop.
4. **Draft** — `loop-editor` drafts the loop in `.contrejour/drafts/` on the closest candidate, or from scratch when the owner asked (`{action: "draft", description, side, kind, candidates, from_scratch, draft, notes, components}`). It returns what the draft is built on and what differs, whether it changes an existing loop, the loop's kind, and the roles its steps need that do not exist. A later draft keeps the base components the owner accepted (`components`).
5. **Components** — only for a new task loop (the draft changes no existing loop, and its kind is `task`), once per run: `loop-query` finds the base components the project has and recommends which of the draft's loops (the task loop and the loops it runs as steps) add which, where and why, with the draft's digest (`{action: "find-components", draft, loop}`). When it recommends any, `owner-review` puts them to the owner (`review_id` `components:<loop>:<digest>`). Approval, of all of them or of the ones the owner names, or `revise` with the owner's words, has `loop-editor` add them to the draft (`{action: "add-components", draft, loop, recommendations, accepted, notes, missing_roles}`), which returns what it added and the roles the draft now needs; `cancel` goes on without them.
6. **Roles** — for each missing role, as the components left them, at most 4: `role-creator` drafts it into the same draft, on the closest existing role (`{action: "draft", draft, name, description, base, notes}`).
7. **Finish** — `loop-editor` checks the draft with its roles as the project would have them, fixes what the check reports, and returns whether it passes and the draft's digest (`{action: "finish", draft, loop}`).
8. **Review** — `owner-review` puts the draft to the owner (`review_id` `loop:<loop>:<digest>`): the definition, the script, the new roles, the components added, what it is built on and what differs, and the check. Approval is possible only when the check passes. `revise` goes back to step 4 with the owner's words; `cancel` goes to step 10.
9. **Install** — on approval, `loop-editor` installs exactly that version (`{action: "install", draft, digest}`), and the loop ends with the loop's name.
10. **Discard** — when the owner cancels, or no version was approved within the bound, `loop-editor` removes the draft (`{action: "discard", draft}`).

## Bounds

At most 4 drafts per run, and 4 new roles per draft; the base components are offered once per run.

## Waiting

Steps 3, 5 and 8 wait for the owner: the loop returns `{waiting: "owner", review_id, question, document}`, and the session runs it again with the reply in `answers`.

## Triggers

- `record-trajectory`: every role that finishes leaves its trajectory.
- `guard-owner-answers`: every answer the session passes in is the owner's own message, typed after the loop stopped at that review; anything else is blocked before the loop runs.
