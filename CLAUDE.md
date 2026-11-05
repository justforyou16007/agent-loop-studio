# agent-loop-studio

The framework: loops that schedule roles on Claude Code. The Studio, installed once per machine from this checkout, is where projects are edited and run; a project is published, whole, to [agent-loop-community](https://github.com/justforyou16007/agent-loop-community), where other machines' Studios start projects from it. Project packages (such as auto-dl-loop) use this repository as a git submodule. It runs on Claude Code only; do not add Codex or Paseo support, and do not add Claude Code's own source here.

Read [docs/architecture.md](docs/architecture.md) before non-trivial changes.

- Sessions run loops, loops schedule roles, roles do the steps: no flow lives outside a loop, a role never runs another role, and an owner decision is an `owner-review` step of a loop. How a step is done lives in its role file. Helpers are tools of roles; the Studio is the owner's tool.
- The framework names no project: nothing here may mention a project's profiles, files or rules. What a project decides comes through its `project.json` and extension, and its rules through `project-rules.md`. Dependencies point from projects to this repository, never back.
- Keep the owner-answer guard, the digest-bound reviews and publication checks, and the Studio's one-time sign-in and loopback-only serving.
- Keep project installation independent of global configuration. Keep helpers compatible with Node.js 22.12+ and Windows; launch configured commands as argv arrays.
- Run `npm run typecheck` and `npm run lint` after changes, and `npm run format` before committing. Run `npm run build && node tools/library-check.mjs` after changing the library (`--stamp` after regenerating a script). Run only the relevant test file with `npm run test -- tests/<file>.ts`.
- Never restart a running Claude Code background service without permission.
