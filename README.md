# agent-loop-studio

Agent loops on Claude Code. A **loop** schedules **roles**: which role does each step, in what order, on what condition, how many times, and where it stops for the owner. A **role** is a Claude Code agent file that does one step. A **session** only starts loops and carries the owner's answers into them. No flow lives outside a loop, no role runs another role, and every decision of the owner's is an `owner-review` step of a loop.

The Studio is where loops are made and run; the community library is where they are published:

- **Editing: the Studio.** An application you install once on a machine, the owner's console in a browser. It keeps a workspace of projects: start one empty, from one of the framework's examples or from a project published to the community, copy one, open one. Say what you want in its chat: it lists the close loops at once, each previewable as a flow, and draws the closest on a canvas, its parameters beside the steps they affect. Point at steps or arrows and say what to change; `loop-authoring` drafts it in a background Claude Code session and stops for your review. Set up the project's workflow (`setup`), try a loop for real on a small scale (Trial, `loop-trial`), run it and watch its steps, change roles in the chat. What the project improves, its roles fixed from what their trajectories show above all, stays in the project.
- **Publishing: the community library.** When you decide to, Publish puts the whole project in [agent-loop-community](https://github.com/justforyou16007/agent-loop-community) as an example any project can start from: what it is, the task loop it runs with which values, and every loop and role that is its own. You review exactly what leaves first; it is one pull request that the community's maintainers review. Another machine's Studio then starts a project from it.
- **Base roles and loops**: `setup` (with `project-setup`) sets up a project's workflow: the task loop that does what the owner wants and its parameter values, found among the loops that fit and changed or built when the owner asks, then a check and the hand-off. `loop-trial` (with `loop-tester`) checks a loop the way it will run: the static check, a real run on a small scale, the owner's judgement of whether it serves their goal, an improvement before the next trial. `publish` (with `project-publisher`, and `publish-check` when the project checks what leaves) publishes the project. `loop-authoring` and `role-authoring` (with `loop-query`, `loop-editor`, `role-creator`), `owner-review`, `trajectory-optimizer`, `project-memory`, which keeps what worked and what did not, and `task-manager`, the session's role.
- **Checks**: `loop-check` runs a loop's script against stub roles without calling a model, so every branch is reached; roles are checked for the sections the optimizer relies on.
- **Hooks** that only record or block: every finished role leaves its trajectory; an answer passed to a loop must be a message the owner typed after the loop asked.

## Install the Studio

Once per machine, from a local checkout (Node.js 22.12+, and Claude Code):

```bash
git clone https://github.com/justforyou16007/agent-loop-studio.git
cd agent-loop-studio
npm ci && npm run build
npm start
```

It prints a one-time sign-in link: open it in your browser. The Studio answers only on this machine's own address; from another machine, forward the port (`ssh -L 8790:127.0.0.1:8790 <machine>`). It keeps its projects in a workspace folder, `~/agent-loop-projects` at first: Switch workspace, on the Projects page, browses to another folder or takes its path, and the Studio opens the one you chose next time (`--workspace <dir>` or `AGENT_LOOP_WORKSPACE` overrides it).

On its Projects page, fetch the community library once (it is cloned beside the checkout, where git ignores it), and start a project: empty, from a framework example or from a community project; copy one, or delete one once you type its name (never while a loop still works in it). The Studio creates the project's folder with what Claude Code needs to run it; you install nothing into it yourself. Open `claude` in the new project's folder once and accept the folder trust prompt: background sessions start only in a trusted folder. A project that is not set up yet opens with its `setup` loop on the canvas: press Run, and answer in the chat whenever it asks. In the chat, type `@` (or click a box or an arrow on the canvas) to point at a step, an arrow or a parameter. Trial, beside Run, tries the loop on the canvas; Publish, at the top, publishes the project.

## A project package

Projects made in the Studio need nothing of their own. A package that builds on the framework for a particular kind of project (machines that work together, helpers of its own, a special check of what leaves) says what it is in `project.json`: its profiles (each with the role sessions enter as and the library sides its loops and roles come from), the hook actions it adds, and the module of its own helpers the framework calls where the project decides (what counts as a finished task, what must never leave when it is published, the check a publication must pass). Its own rules for the framework's roles go in `skills/shared-references/project-rules.md`. See [docs/architecture.md](docs/architecture.md).

## Develop

```bash
npm ci
npm run build          # helpers (tsc) and the Studio's page (Vite)
npm run typecheck && npm run lint && npm run format:check
node tools/library-check.mjs
npm run test -- tests/test_project.ts
```

MIT licensed. The Studio's look follows the same open-source building blocks as Dify's (React, React Flow, Tailwind, Radix, lucide); it uses no Dify code.
