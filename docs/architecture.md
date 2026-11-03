# Architecture

## Three levels

- **Session** — a Claude Code session running as the project's entry role (`task-manager`, or a project's own). It starts loops and carries the owner's answers into them. It never calls a role and never decides for the owner.
- **Loop** — a natural-language definition (`.claude/loops/<loop>.md`, the authority) and the workflow script generated from it (`.claude/workflows/<loop>.js`, stamped with the definition's digest). A script only calls roles, orders and branches on their structured output, passes inputs between them, loops within a bound, runs another loop as one step (one level deep), and stops for the owner at an `owner-review` step. It never says in a prompt how a step is done and never does work in code.
- **Role** — `.claude/agents/<role>.md`: responsibility, inputs, steps, structured output, what it writes, and an Evaluation section with the signals `trajectory-optimizer` judges it by. How a step is done lives only there, so a fix to a role is never overridden.

A loop's `kind` is `task` (the project's work, chosen by the owner in the Studio and recorded with its parameter values in `.contrejour/loop.json`) or `on-request`.

## Waiting for the owner

Workflow agents cannot ask a person. A loop that needs the owner stops at `owner-review`, which writes a review note, and returns `{waiting: "owner", review_id, question, document}`. The session (or the Studio, through a background session) shows the note and passes the owner's next message, verbatim, as `answers.<review_id>` when it runs the loop again, resuming the run. The `guard-owner-answers` hook checks each answer is, whole and word for word, a message the owner typed in that session after the loop stopped at that review (Claude Code 2.1.316 records typed messages without an origin, 2.1.317 with `origin.kind: "human"`), and blocks the run otherwise; `owner-review` accepts only the answers the hook recorded.

## Project packages

The framework knows nothing about any one project. A package tells it what it needs in `project.json`:

```json
{
  "format": 1,
  "name": "my-package",
  "profiles": {
    "default": { "entry_role": "task-manager", "sides": [], "next": ["what to do after installing"] }
  },
  "extension": "my-extension.js",
  "hook_actions": { "my-action": ["PreToolUse"] }
}
```

- A **profile** is a kind of machine a project can be installed as. `sides` name the library folders (`library/loops/<side>`, `library/roles/<side>`) its loops and roles come from, besides `framework`. A side's loop or role of the same name as the framework's takes its place.
- The **extension** is a module installed with the helpers that exports `extension` (`ProjectExtension` in `src/tools/project-manifest.ts`): the project's hook actions, the task a session works on (recorded with each trajectory), what counts as a finished task (one is needed before contributing; by default a run of the task loop), secrets and hidden files that must never leave in a contribution, and whether a contribution needs a check of the project's own before it leaves (its role records the verdict with `library-cli.js record-check`, bound to the plan's digest).
- `skills/shared-references/project-rules.md` holds the project's rules the framework's roles read: how its task loops are run, how its runs are identified and where their outcomes are, whether its trajectories hold what no role may contain (then `trajectory-optimizer` only proposes, and the owner accepts in `proposal-review`).

Dependencies point one way: a project depends on a version of this framework and a version of the community library, as git submodules; neither depends on any project, and a community role never calls a project's helper.

## The Studio

`studio.js` serves the page (built by Vite from `studio/` into `dist/studio/`) and its data on this machine's own address only, to the one browser signed in with the link it prints; requests that act need the page's own header, so another site cannot act for the owner. It reads loops, roles and the trajectory index; it changes the project only through the owner's actions (choosing the task loop and its values, creating or copying a project) and through loops run in background sessions as the entry role, whose progress it follows in Claude Code's run journal.

## Libraries

A project's loops and roles come from libraries: the `library/` of the checkout it was installed from and, when that checkout is a project package's, of the framework's (`agent-loop-studio/`) and the community's (`agent-loop-community/`) it carries as submodules. The framework's `framework` folder holds its own base loops and roles; the community's holds those any project can use that projects contributed, and its other folders the loops and roles of kinds of projects; a package's folders hold its own sides'. A checkout of this framework may hold a clone of the community library at `agent-loop-community/` (git ignores it), so the projects installed from it find the community's loops and roles too. Using a loop in the Studio, the loop viewer and reference projects look in all of them.

## Contributions

`library-cli.js` keeps a baseline of every seeded file in `.contrejour/seeded/`, so a contribution holds only what the project changed, merged three ways with what its library changed meanwhile. Each loop or role goes back to the library it came from; a new one goes to the library of its side, and one any project can use to the community's. It blocks keys, tokens, machine paths and hidden files, checks the result with the libraries laid together as a project receives them, and the owner approves exactly what leaves, in one review, before one pull request per library is opened.
