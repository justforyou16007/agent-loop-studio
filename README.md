# agent-loop-studio

Agent loops on Claude Code. A **loop** schedules **roles**: which role does each step, in what order, on what condition, how many times, and where it stops for the owner. A **role** is a Claude Code agent file that does one step. A **session** only starts loops and carries the owner's answers into them. No flow lives outside a loop, no role runs another role, and every decision of the owner's is an `owner-review` step of a loop.

The framework builds, reuses and improves loops and roles:

- **The Studio**, the owner's console in a browser on the same machine. Say what you want in its chat: it lists the close loops at once, each previewable as a flow, and draws the closest on a canvas, its parameters beside the steps they affect. Point at steps or arrows and say what to change; `loop-authoring` drafts it in a background Claude Code session and stops for your review, with the draft on the canvas. Choose the loop a project runs and its parameter values, run any loop and watch its steps, change roles in the chat, and keep a workspace of projects: start one from a reference project, copy one.
- **Base roles and loops**: `loop-authoring` and `role-authoring` (with `loop-query`, `loop-editor`, `role-creator`), `owner-review`, `trajectory-optimizer`, which fixes roles from what their trajectories show, `project-memory`, which keeps what worked and what did not, `task-manager`, the session's role, and `library-contribution` (with `library-contributor`), which sends what a project learned back where it came from once the owner has reviewed exactly what leaves: a changed base loop or role to this repository, a new one any project can use to the community library, one pull request per library.
- **Checks**: `loop-check` runs a loop's script against stub roles without calling a model, so every branch is reached; roles are checked for the sections the optimizer relies on.
- **Hooks** that only record or block: every finished role leaves its trajectory; an answer passed to a loop must be a message the owner typed after the loop asked.

The loops and roles that projects share live in [agent-loop-community](https://github.com/justforyou16007/agent-loop-community). A project package uses both as git submodules, at the versions it chooses; nothing points back from them to a project. [auto-dl-loop](https://github.com/justforyou16007/auto-dl-loop), a two-machine research task, is one.

## Install a project

From a local checkout (Node.js 22.12+):

```bash
git clone https://github.com/justforyou16007/agent-loop-studio.git
cd agent-loop-studio
npm ci && npm run build
bash distribution/install-contrejour.sh --role default --project /path/to/project
```

The installer writes only into the project (`.contrejour/`, `.claude/`), never global configuration, and downloads nothing. Then open the Studio:

```bash
node /path/to/project/.contrejour/dist/tools/studio.js --project /path/to/project
```

It prints a one-time sign-in link: open it in your browser. The Studio answers only on this machine's own address; from another machine, forward the port (`ssh -L 8790:127.0.0.1:8790 <machine>`). Open `claude` in the project once and accept the folder trust prompt: background sessions start only in a trusted folder.

To keep several projects, start the Studio on a folder of them, with this checkout as the library new projects come from:

```bash
node dist/tools/studio.js --workspace ~/projects --library "$PWD"
```

## A project package

A package that builds on the framework says what it is in `project.json`: its profiles (each with the role sessions enter as and the library sides its loops and roles come from), the hook actions it adds, and the module of its own helpers the framework calls where the project decides (what counts as a finished task, what must never leave in a contribution, the check a contribution must pass). Its own rules for the framework's roles go in `skills/shared-references/project-rules.md`. See [docs/architecture.md](docs/architecture.md).

## Develop

```bash
npm ci
npm run build          # helpers (tsc) and the Studio's page (Vite)
npm run typecheck && npm run lint && npm run format:check
node tools/library-check.mjs
npm run test -- tests/test_project.ts
```

MIT licensed. The Studio's look follows the same open-source building blocks as Dify's (React, React Flow, Tailwind, Radix, lucide); it uses no Dify code.
