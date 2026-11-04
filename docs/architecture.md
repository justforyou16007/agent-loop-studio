# Architecture

## Three levels

- **Session** — a Claude Code session running as the project's entry role (`task-manager`, or a project's own). It starts loops and carries the owner's answers into them. It never calls a role and never decides for the owner.
- **Loop** — a natural-language definition (`.claude/loops/<loop>.md`, the authority) and the workflow script generated from it (`.claude/workflows/<loop>.js`, stamped with the definition's digest). A script only calls roles, orders and branches on their structured output, passes inputs between them, loops within a bound, runs another loop as one step (one level deep), and stops for the owner at an `owner-review` step. It never says in a prompt how a step is done and never does work in code.
- **Role** — `.claude/agents/<role>.md`: responsibility, inputs, steps, structured output, what it writes, and an Evaluation section with the signals `trajectory-optimizer` judges it by. How a step is done lives only there, so a fix to a role is never overridden.

A loop's `kind` is `task` (the project's work, chosen by the owner and recorded with its parameter values in `.contrejour/loop.json`), `setup` (the framework's, which sets up the project's workflow) or `on-request`.

## Setting a project up

Every project's workflow is set up by the framework's `setup` loop, the same for all of them: the owner says what the project's work should be; `loop-query` finds the task loops that fit, `project-setup` proposes one with its parameter values, and `loop-authoring` changes or builds one when the owner asks; the project's loops are checked, and the hand-off records that the project is set up (`.contrejour/setup.json`). Setup reads `task.md` when there is one and never writes it: what a project works on is the project's, and so is any configuration it needs, which a package gives its projects as loops of their own. The Studio opens a project that is not set up with this loop, and the entry role runs it when the owner starts such a project.

## Trying a loop

`loop-check` runs a script with stand-in roles: every step reachable, every role there. `loop-trial` checks a loop the way it will run: after the static check it runs the loop for real on a small scale, with the `trial-args` its definition declares (a loop whose real runs would act outside the project declares none, or declares arguments that stop it short of that), `loop-tester` reports what the run did against the owner's goal, and the owner judges it. When it does not serve the goal, `loop-authoring` changes the loop's steps and `trajectory-optimizer` fixes its roles from the trial's trajectories, and the loop is tried again. A loop that runs a loop it is given names the argument that gives it (`child-loop-arg`), so the check can follow it.

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
- The **extension** is a module installed with the helpers that exports `extension` (`ProjectExtension` in `src/tools/project-manifest.ts`): the project's hook actions, the task a session works on (recorded with each trajectory), what counts as a finished task (one is needed before anything leaves; by default a run of the task loop), secrets and hidden files that must never leave, and whether what leaves needs a check of the project's own first (the `publish-check` loop, which records its verdict with `publish-cli.js record-check`, bound to the plan's digest).
- A side's **loops of the framework's names** take the framework's place in its projects. One is made for that: `publish-check`, the project's own check of what leaves (the framework's puts the files to the owner).
- `skills/shared-references/project-rules.md` holds the project's rules the framework's roles read: how its task loops are run, how its runs are identified and where their outcomes are, whether its trajectories hold what no role may contain (then `trajectory-optimizer` only proposes, and the owner accepts in `proposal-review`).

Dependencies point one way: a project depends on a version of this framework and a version of the community library, as git submodules; neither depends on any project. The community library's `framework` loops and roles use only the framework's; a side's may use what that side's package provides, which only a project of that side can check.

## Editing and publishing

There are two states. **Editing** happens in the Studio: an application installed once per machine, from a checkout of this repository, which keeps a workspace of projects (`~/agent-loop-projects` unless told otherwise). It starts projects (empty, from one of the framework's examples in `references/`, or from a project published to the community), copies and opens them; it creates each project's folder with what Claude Code needs to run it (`.claude/`, the hooks, the runtime in `.contrejour/`) through the installer, which nobody runs by hand. Every machine that runs a project runs a Studio. **Publishing** puts a project in the community library, agent-loop-community, under `projects/<name>/`, as an example any project can start from (below).

`studio.js` serves the page (built by Vite from `studio/` into `dist/studio/`) and its data on this machine's own address only, to the one browser signed in with the link it prints; requests that act need the page's own header, so another site cannot act for the owner. It reads loops, roles and the trajectory index; it changes a project only through the owner's actions (creating, copying or opening a project, choosing the task loop and its values, fetching the community library beside its checkout) and through loops run in background sessions as the entry role (Run, Trial, Publish), whose progress it follows in Claude Code's run journal.

## Libraries

A project's loops and roles come from the `library/` of the checkout it was installed from, and, for a project package's checkout, of the framework's it carries as a submodule (`agent-loop-studio/`). The framework's `framework` folder holds its own base loops and roles; a package's folders hold its own sides'. Examples come from the framework's `references/` and from the community library's `projects/`, cloned beside the checkout as `agent-loop-community/` (git ignores it there). An example's loops and roles take the place of a framework one of the same name in a project started from it.

## Optimizing and publishing

What a project improves stays in the project: `trajectory-optimizer` fixes its roles from their trajectories, in the project (or proposes fixes, when the project's rules say so), and the owner changes its loops and roles in the Studio. Whether any of it leaves is the owner's decision, made by publishing: the `publish` loop puts the whole project under `projects/<name>/` in the community library, once one of its tasks has finished. It holds `reference.json` (a title and description in Chinese and English, which `project-publisher` writes, and the task loop with its values) and every loop and role that is the project's own: the ones it made, the ones it got from the example it started from (`.contrejour/reference.json` records them), and its versions of the framework's base ones. The framework's base loops and roles it left as installed stay out, and so do its data, keys, `task.md` and run records.

`publish-cli.js` keeps the record of what each publication sent, so a later one sends only what changed and removes what the project no longer has; a name another project publishes under is never overwritten. It blocks keys, tokens and hidden files, warns about paths of this machine, checks the publication over the framework's library as a project started from it gets it, runs the project's own check when it has one (`publish-check`), and the owner approves exactly what leaves before the one pull request is opened. `.contrejour/published.json` records the project's latest publication, which the Studio shows.
