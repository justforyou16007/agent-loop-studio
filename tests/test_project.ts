/**
 * A project built with the framework alone, as the owner meets it: installed
 * from the framework's own package, started in the Studio from a reference
 * project, copied and deleted, its workspace switched, its loops checked, its
 * hooks recording trajectories and guarding the owner's answers, published to
 * the community once a task has finished and started from there.
 * No project package is involved. Run `npm run build` first.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openingOf } from "../studio/src/opening.js";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
assert.ok(fs.existsSync(path.join(source, "dist", "studio", "index.html")), "run npm run build first");
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-project-")));
const workspace = path.join(sandbox, "workspace");
fs.mkdirSync(workspace);
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
// Claude Code's own folder, stood in for: the Studio looks for transcripts there, and this machine's is never touched.
const claudeConfig = path.join(sandbox, "claude-config");
fs.mkdirSync(claudeConfig);
process.env.CLAUDE_CONFIG_DIR = claudeConfig;
// Something a test waits for: what the Studio does with a session's messages, it does a moment after they come.
async function until(what: string, happened: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await happened()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`never happened: ${what}`);
}

function request(url: string, options: { method?: string; cookie?: string; body?: unknown } = {}) {
  const target = new URL(url);
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const outgoing = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: options.method ?? "GET",
        headers: {
          host: target.host,
          ...(options.cookie ? { cookie: options.cookie } : {}),
          ...(payload ? { "content-type": "application/json", "x-contrejour-studio": "1" } : {}),
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body, headers: response.headers }));
      },
    );
    outgoing.on("error", reject);
    outgoing.end(payload);
  });
}

try {
  // --- the framework's own package installs a project of its one profile ---
  execFileSync(process.execPath, [path.join(source, "tools/pack-contrejour.mjs"), "--directory", path.join(sandbox, "package")], { stdio: "ignore" });
  const installer = path.join(sandbox, "package/contrejour/install.mjs");
  const plain = path.join(workspace, "plain");
  const printed = execFileSync(process.execPath, [installer, "--role", "default", "--project", plain, "--library", source], { encoding: "utf8" });
  assert.match(printed, /npm start -- --project/);
  assert.equal(read(path.join(plain, ".contrejour/project.json")).name, "agent-loop-studio");
  for (const role of ["task-manager", "project-memory", "owner-review", "loop-editor", "trajectory-optimizer"])
    assert.ok(fs.existsSync(path.join(plain, ".claude/agents", `${role}.md`)), role);
  for (const loop of ["setup", "loop-trial", "loop-authoring", "role-authoring", "publish", "publish-check"])
    assert.ok(fs.existsSync(path.join(plain, ".claude/loops", `${loop}.md`)), loop);
  for (const role of ["project-setup", "loop-tester", "project-publisher"]) assert.ok(fs.existsSync(path.join(plain, ".claude/agents", `${role}.md`)), role);
  assert.ok(read(path.join(plain, ".claude/settings.json")).hooks.PreToolUse, "the hooks guard every loop from the start");
  assert.equal(read(path.join(plain, ".claude/settings.json")).agent, "task-manager", "every session runs as the entry role from the start");
  const projectCli = (root: string, ...args: string[]) =>
    spawnSync(process.execPath, [path.join(root, ".contrejour/dist/tools/project-cli.js"), ...args, "--project", root], { encoding: "utf8" });
  const shown = JSON.parse(projectCli(plain, "show").stdout);
  assert.deepEqual([shown.profile, shown.entry_role, shown.loop, shown.setup_finished], ["default", "task-manager", null, null]);
  // A project is set up once its setup hands off, which needs a task loop.
  assert.match(projectCli(plain, "finish-setup").stderr, /LOOP_NOT_SELECTED/);
  // A role's effort goes to the model's provider as it is: medium, which some refuse, is a defect.
  const effortRole = path.join(plain, ".claude/agents/effort-probe.md");
  fs.writeFileSync(effortRole, fs.readFileSync(path.join(plain, ".claude/agents/task-manager.md"), "utf8").replace(/^name: .*$/m, "name: effort-probe").replace(/^---\n/, "---\neffort: medium\n"));
  const checkedRoles = spawnSync(process.execPath, [path.join(plain, ".contrejour/dist/tools/loop-check.js"), "roles", "--project", plain], { encoding: "utf8" });
  assert.notEqual(checkedRoles.status, 0);
  assert.match(checkedRoles.stdout, /effort-probe[\s\S]*effort must be one of low, high, xhigh, max/);
  fs.rmSync(effortRole);
  // The base components a new task loop is offered: the roles and loops that say what they add to one.
  const components = (...extra: string[]) =>
    (JSON.parse(execFileSync(process.execPath, [path.join(plain, ".contrejour/dist/tools/loop-check.js"), "components", "--project", plain, ...extra], { encoding: "utf8" })) as { name: string; type: string; adds: string }[]).map((entry) => `${entry.type}:${entry.name}:${entry.adds.split(" — ")[0]}`);
  assert.deepEqual(components(), ["role:project-memory:memory", "role:trajectory-optimizer:optimization"]);
  // A draft's are found as the project would have them once it is installed.
  const probe = path.join(plain, ".contrejour/drafts/component-probe");
  fs.mkdirSync(path.join(probe, "loops"), { recursive: true });
  fs.writeFileSync(path.join(probe, "loops/component-probe.md"), "---\nname: component-probe\ncomponent: probing — a step that probes\n---\n");
  assert.deepEqual(components("--draft", "component-probe"), [...components(), "loop:component-probe:probing"]);
  fs.rmSync(path.join(plain, ".contrejour/drafts"), { recursive: true });
  // An update brings the framework's loops and roles the project still has as installed to their new version,
  // and leaves alone what the project changed, and a loop half of which it changed.
  const asInstalled = (relative: string, text: string) => {
    for (const file of [path.join(plain, ".claude", relative), path.join(plain, ".contrejour/seeded", relative)]) fs.writeFileSync(file, text);
  };
  asInstalled("agents/task-manager.md", "an older framework's task manager\n");
  asInstalled("agents/loop-query.md", "an older framework's loop query\n");
  fs.writeFileSync(path.join(plain, ".claude/agents/loop-query.md"), "the project's own loop query\n");
  asInstalled("loops/setup.md", "an older framework's setup\n");
  fs.appendFileSync(path.join(plain, ".claude/workflows/setup.js"), "\n// the project's own change\n");
  const reinstalled = JSON.parse(execFileSync(process.execPath, [installer, "--role", "default", "--project", plain, "--library", source], { encoding: "utf8" }).split(/^Next:/m)[0]!);
  assert.deepEqual(reinstalled.updated, [".claude/agents/task-manager.md"]);
  const libraryRole = fs.readFileSync(path.join(source, "library/roles/framework/task-manager.md"), "utf8");
  assert.equal(fs.readFileSync(path.join(plain, ".claude/agents/task-manager.md"), "utf8"), libraryRole);
  assert.equal(fs.readFileSync(path.join(plain, ".contrejour/seeded/agents/task-manager.md"), "utf8"), libraryRole, "its baseline moves with it");
  assert.equal(fs.readFileSync(path.join(plain, ".claude/agents/loop-query.md"), "utf8"), "the project's own loop query\n");
  assert.equal(fs.readFileSync(path.join(plain, ".claude/loops/setup.md"), "utf8"), "an older framework's setup\n", "half the loop is the project's: neither half moves");
  for (const relative of ["agents/loop-query.md", "loops/setup.md", "workflows/setup.js"])
    for (const file of [path.join(plain, ".claude", relative), path.join(plain, ".contrejour/seeded", relative)])
      fs.writeFileSync(file, fs.readFileSync(path.join(source, "library", relative.startsWith("agents/") ? "roles" : "loops", "framework", path.basename(relative))));
  const refused = spawnSync(process.execPath, [installer, "--role", "worker", "--project", path.join(sandbox, "nope")], { encoding: "utf8" });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /--role default/);

  // --- the Studio starts, opens, copies and deletes projects in a workspace, and switches workspaces ---
  const { serveStudio } = (await import(pathToFileURL(path.join(source, "dist/tools/studio.js")).href)) as {
    serveStudio(
      root: string,
      options?: { port?: number; workspace?: string; library?: string; settings?: string; session?: { query?: unknown } },
    ): Promise<{ url: string; loginUrl: string; close(): Promise<void> }>;
  };
  // Claude Code, stood in for through the SDK's query: each session it starts is kept here, says what the test makes
  // it say, and records what the Studio sends it. It starts as Claude Code does, naming itself once it has a message.
  interface FakeSession {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options: Record<string, any>;
    sent: { message: { content: string }; origin?: { kind: string } }[];
    interrupted: number;
    closed: boolean;
    say(...messages: Record<string, unknown>[]): void;
    die(error: Error): void;
  }
  const fakeSessions: FakeSession[] = [];
  let startFailure: Error | null = null;
  const fakeQuery = ({ prompt, options }: { prompt: AsyncIterable<FakeSession["sent"][number]>; options: FakeSession["options"] }) => {
    const said: Record<string, unknown>[] = [];
    let death: Error | null = null;
    let ended = false;
    let wake = () => {};
    const session: FakeSession = {
      options,
      sent: [],
      interrupted: 0,
      closed: false,
      say(...messages) {
        said.push(...messages);
        wake();
      },
      die(error) {
        death = error;
        wake();
      },
    };
    fakeSessions.push(session);
    const failure = startFailure;
    const name = options.resume ?? `fake-session-${fakeSessions.length}`;
    void (async () => {
      for await (const message of prompt) {
        if (failure) session.die(failure);
        else if (!session.sent.length)
          session.say({ type: "system", subtype: "session_state_changed", state: "running" }, { type: "system", subtype: "init", session_id: name });
        session.sent.push(message);
      }
    })();
    const messages = (async function* () {
      for (;;) {
        while (said.length) yield said.shift();
        if (death) throw death;
        if (ended) return;
        await new Promise<void>((resolve) => (wake = resolve));
      }
    })();
    return Object.assign(messages, {
      interrupt: async () => {
        session.interrupted += 1;
        session.say({ type: "system", subtype: "session_state_changed", state: "idle" });
      },
      close: () => {
        session.closed = true;
        ended = true;
        wake();
      },
    });
  };
  const settingsFile = path.join(sandbox, "studio-settings.json");
  const studio = await serveStudio("", { port: 0, workspace, library: source, settings: settingsFile, session: { query: fakeQuery } });
  try {
    const at = (relative: string) => new URL(relative, studio.url).href;
    const cookie = String((await request(studio.loginUrl)).headers["set-cookie"]).split(";")[0]!;
    assert.equal((await request(at("api/overview"), { cookie })).status, 409, "no project is open yet");
    let projects = JSON.parse((await request(at("api/projects"), { cookie })).body);
    assert.equal(projects.current, null);
    assert.deepEqual(projects.projects.map((entry: { name: string }) => entry.name), ["plain"]);
    assert.deepEqual(projects.recent_workspaces, []);
    assert.ok(projects.can_create);
    assert.equal(projects.references[0].name, "iterate-and-check");
    assert.ok(projects.references[0].title.zh && projects.references[0].description.en);

    // A new project from the reference: installed, its loop and roles in place, its task loop chosen.
    assert.equal((await request(at("api/projects/new"), { cookie, method: "POST", body: { name: "Bad Name", reference: null } })).status, 400);
    const created = await request(at("api/projects/new"), { cookie, method: "POST", body: { name: "first", reference: "iterate-and-check" } });
    assert.equal(created.status, 200, created.body);
    const first = path.join(workspace, "first");
    for (const role of ["planner", "builder", "checker"]) {
      assert.ok(fs.existsSync(path.join(first, ".claude/agents", `${role}.md`)));
      assert.ok(fs.existsSync(path.join(first, ".contrejour/seeded/agents", `${role}.md`)), "kept as the baseline for contributions");
    }
    assert.deepEqual(read(path.join(first, ".contrejour/loop.json")), { schema_version: 1, loop: "iterate-and-check", params: { max_rounds: 3 } });
    assert.equal(read(path.join(first, ".claude/settings.json")).agent, "task-manager");
    assert.ok(fs.existsSync(path.join(first, "task.md")) && fs.existsSync(path.join(first, ".git")));
    // The project gets the helpers its roles and hooks run, never the Studio: that runs only from the checkout.
    assert.ok(fs.existsSync(path.join(first, ".contrejour/dist/tools/hook.js")));
    for (const part of [".contrejour/dist/tools/studio.js", ".contrejour/dist/tools/agent-sessions.js", ".contrejour/dist/studio"])
      assert.equal(fs.existsSync(path.join(first, part)), false, part);
    for (const command of ["check", "roles"]) {
      const checked = spawnSync(process.execPath, [path.join(first, ".contrejour/dist/tools/loop-check.js"), command, "--project", first], { encoding: "utf8" });
      assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    }
    const overview = JSON.parse((await request(at("api/overview"), { cookie })).body);
    assert.equal(overview.project.name, "first");
    // Not set up, but its example chose its task loop: the page opens it on that loop, not on the framework's setup.
    assert.equal(overview.project.setup_finished, null);
    assert.deepEqual(openingOf(overview), { key: "welcome_chosen", loop: "iterate-and-check" });
    // Without a task loop, it would open with its setup loop.
    assert.deepEqual(openingOf({ ...overview, project: { ...overview.project, chosen: null } }), { key: "welcome_setup", loop: "setup" });
    assert.equal(overview.loops.find((loop: { name: string }) => loop.name === "setup").kind, "setup");
    // The framework's loops and roles as installed are shown apart from the project's own; what an example gave is the project's.
    const named = (list: { name: string; framework: boolean }[], name: string) => list.find((entry) => entry.name === name)!;
    assert.equal(overview.project.example, "iterate-and-check");
    assert.deepEqual([named(overview.loops, "setup").framework, named(overview.loops, "iterate-and-check").framework], [true, false]);
    assert.deepEqual([named(overview.roles, "owner-review").framework, named(overview.roles, "planner").framework], [true, false]);
    // A project started empty has none of its own, and opens blank; a framework role it changes becomes its own.
    assert.equal((await request(at("api/projects/open"), { cookie, method: "POST", body: { name: "plain" } })).status, 200);
    const empty = JSON.parse((await request(at("api/overview"), { cookie })).body);
    assert.equal(empty.project.example, null);
    assert.deepEqual(openingOf(empty), { key: "welcome_empty", loop: null });
    assert.ok(empty.loops.filter((loop: { source: string }) => loop.source === "project").every((loop: { framework: boolean }) => loop.framework));
    const baseRole = path.join(plain, ".claude/agents/owner-review.md");
    const asInstalled = fs.readFileSync(baseRole, "utf8");
    fs.writeFileSync(baseRole, `${asInstalled}\nThis project's own way.\n`);
    const changedRole = JSON.parse((await request(at("api/overview"), { cookie })).body);
    assert.equal(named(changedRole.roles, "owner-review").framework, false);
    fs.writeFileSync(baseRole, asInstalled);
    assert.equal((await request(at("api/projects/open"), { cookie, method: "POST", body: { name: "first" } })).status, 200);
    // A loop is tried with loop-trial; only a loop the project has can be.
    assert.equal((await request(at("api/trial"), { cookie, method: "POST", body: { name: "no-such-loop", goal: "" } })).status, 404);
    const flow = JSON.parse((await request(at("api/flow?name=iterate-and-check&source=project"), { cookie })).body);
    assert.deepEqual(
      flow.nodes.filter((node: { kind: string }) => node.kind === "step").map((node: { title: string }) => node.title),
      ["Plan", "Build", "Check", "Record", "Review"],
    );
    assert.deepEqual(flow.params.map((param: { name: string; links: string[] }) => [param.name, param.value]), [["max_rounds", 3]]);
    assert.ok(flow.nodes.find((node: { title: string }) => node.title === "Review").waits);

    // A copy carries the work, never the keys or what runs left behind; its hooks are its own.
    fs.mkdirSync(path.join(first, "memory"), { recursive: true });
    fs.writeFileSync(path.join(first, "memory/lessons.md"), "- A lesson.\n");
    fs.writeFileSync(path.join(first, ".mcp.json"), JSON.stringify({ mcpServers: { x: { headers: { Authorization: "Bearer secret" } } } }));
    fs.writeFileSync(path.join(first, ".contrejour/environment.json"), JSON.stringify({ API_KEY: "secret" }));
    fs.mkdirSync(path.join(first, ".contrejour/trajectories"), { recursive: true });
    fs.writeFileSync(path.join(first, ".contrejour/trajectories/index.jsonl"), "{}\n");
    const copied = await request(at("api/projects/copy"), { cookie, method: "POST", body: { from: "first", name: "second" } });
    assert.equal(copied.status, 200, copied.body);
    const second = path.join(workspace, "second");
    assert.equal(fs.readFileSync(path.join(second, "memory/lessons.md"), "utf8"), "- A lesson.\n");
    assert.deepEqual(read(path.join(second, ".contrejour/loop.json")), read(path.join(first, ".contrejour/loop.json")));
    assert.ok(fs.existsSync(path.join(second, ".claude/agents/planner.md")));
    for (const left of [".mcp.json", ".contrejour/environment.json", ".contrejour/trajectories"])
      assert.equal(fs.existsSync(path.join(second, left)), false, left);
    const hooks = read(path.join(second, ".claude/settings.json")).hooks;
    assert.ok(hooks.Stop[0].hooks[0].args[0].startsWith(second), "the copy's hooks run the copy's helper");
    projects = JSON.parse((await request(at("api/projects"), { cookie })).body);
    assert.equal(projects.current, "second");
    assert.equal((await request(at("api/projects/open"), { cookie, method: "POST", body: { name: "first" } })).status, 200);
    assert.equal(JSON.parse((await request(at("api/overview"), { cookie })).body).project.name, "first");
    assert.equal((await request(at("api/projects/open"), { cookie, method: "POST", body: { name: "nope" } })).status, 404);
    // A project opened is brought up to the Studio's framework when that has moved on; a current one is not touched.
    for (const file of [path.join(first, ".claude/agents/task-manager.md"), path.join(first, ".contrejour/seeded/agents/task-manager.md")])
      fs.writeFileSync(file, "an older framework's task manager\n");
    const behind = JSON.parse((await request(at("api/projects/open"), { cookie, method: "POST", body: { name: "first" } })).body);
    assert.deepEqual(behind.update, { written: [".claude/agents/task-manager.md"], problem: null });
    assert.equal(fs.readFileSync(path.join(first, ".claude/agents/task-manager.md"), "utf8"), fs.readFileSync(path.join(source, "library/roles/framework/task-manager.md"), "utf8"));
    const settingsBefore = fs.statSync(path.join(first, ".claude/settings.json")).mtimeMs;
    const current = JSON.parse((await request(at("api/projects/open"), { cookie, method: "POST", body: { name: "first" } })).body);
    assert.deepEqual(current.update, { written: [], problem: null });
    assert.equal(fs.statSync(path.join(first, ".claude/settings.json")).mtimeMs, settingsBefore, "a current project is not reinstalled");

    // The folders to choose a workspace from: full paths only.
    const listing = JSON.parse((await request(at(`api/projects/folders?path=${encodeURIComponent(workspace)}`), { cookie })).body);
    assert.deepEqual([listing.path, listing.exists, listing.projects], [workspace, true, 3]);
    assert.ok(listing.folders.some((folder: { name: string; path: string }) => folder.name === "first" && folder.path === first));
    assert.equal((await request(at("api/projects/folders?path=relative%2Fdir"), { cookie })).status, 400);
    const nowhere = JSON.parse((await request(at(`api/projects/folders?path=${encodeURIComponent(path.join(sandbox, "nowhere"))}`), { cookie })).body);
    assert.deepEqual([nowhere.exists, nowhere.folders], [false, []]);

    // A project deleted: never while a loop the Studio started works in it; then the sessions only waiting in it end and its folder goes.
    assert.equal((await request(at("api/projects/delete"), { cookie, method: "POST", body: { name: "nope" } })).status, 404);
    assert.equal((await request(at("api/projects/open"), { cookie, method: "POST", body: { name: "second" } })).status, 200);
    const inSecond = await request(at("api/run"), { cookie, method: "POST", body: { name: "setup" } });
    assert.equal(inSecond.status, 200, inSecond.body);
    const secondSession = fakeSessions.at(-1)!;
    assert.equal((await request(at("api/projects/open"), { cookie, method: "POST", body: { name: "first" } })).status, 200);
    const working = await request(at("api/projects/delete"), { cookie, method: "POST", body: { name: "second" } });
    assert.equal(working.status, 409, working.body);
    assert.ok(JSON.parse(working.body).error.includes(JSON.parse(inSecond.body).id));
    assert.ok(fs.existsSync(second));
    secondSession.say({ type: "system", subtype: "session_state_changed", state: "idle" });
    const deleted = await (async () => {
      for (;;) {
        const reply = await request(at("api/projects/delete"), { cookie, method: "POST", body: { name: "second" } });
        if (reply.status !== 409) return reply;
      }
    })();
    assert.equal(deleted.status, 200, deleted.body);
    assert.equal(fs.existsSync(second), false);
    assert.equal(secondSession.closed, true, "the session waiting in it ended first");
    assert.equal(JSON.parse(deleted.body).current, "first", "the project open stays open");
    // The project open now, deleted: none is open after it.
    assert.equal((await request(at("api/projects/new"), { cookie, method: "POST", body: { name: "doomed", reference: null } })).status, 200);
    assert.equal(JSON.parse((await request(at("api/projects/delete"), { cookie, method: "POST", body: { name: "doomed" } })).body).current, null);
    assert.equal((await request(at("api/overview"), { cookie })).status, 409);
    assert.equal(fs.existsSync(path.join(workspace, "doomed")), false);

    // Another workspace: a full path, created only when asked, remembered for the next start.
    const other = path.join(sandbox, "other-workspace");
    assert.equal((await request(at("api/projects/workspace"), { cookie, method: "POST", body: { path: "relative" } })).status, 400);
    assert.equal((await request(at("api/projects/workspace"), { cookie, method: "POST", body: { path: other } })).status, 404);
    assert.equal(fs.existsSync(other), false);
    assert.equal((await request(at("api/projects/open"), { cookie, method: "POST", body: { name: "first" } })).status, 200);
    const moved = await request(at("api/projects/workspace"), { cookie, method: "POST", body: { path: other, create: true } });
    assert.equal(moved.status, 200, moved.body);
    assert.deepEqual(JSON.parse(moved.body), { workspace: other, current: null }, "the project open was in the workspace left");
    projects = JSON.parse((await request(at("api/projects"), { cookie })).body);
    assert.deepEqual([projects.workspace, projects.projects, projects.recent_workspaces], [other, [], [workspace]]);
    assert.deepEqual(read(settingsFile), { workspace: other, recent: [workspace] });
    assert.equal(JSON.parse((await request(at("api/projects/workspace"), { cookie, method: "POST", body: { path: workspace } })).body).workspace, workspace);
    assert.deepEqual(JSON.parse((await request(at("api/projects"), { cookie })).body).recent_workspaces, [other]);

    // A project whose installation record went away outside the Studio is no longer open: nothing runs as a role it no longer has.
    assert.equal((await request(at("api/projects/open"), { cookie, method: "POST", body: { name: "first" } })).status, 200);
    const record = path.join(first, ".contrejour/install.json");
    fs.renameSync(record, `${record}.away`);
    assert.equal((await request(at("api/run"), { cookie, method: "POST", body: { name: "setup" } })).status, 409);
    assert.equal(JSON.parse((await request(at("api/projects"), { cookie })).body).current, null);
    fs.renameSync(`${record}.away`, record);

    // --- a session, started through the SDK and followed as it goes ---
    assert.equal((await request(at("api/projects/open"), { cookie, method: "POST", body: { name: "first" } })).status, 200);
    const statusOf = async (id: string) => JSON.parse((await request(at("api/authoring"), { cookie })).body).conversations.find((entry: { id: string }) => entry.id === id);
    const answer = (id: string, text: string, references: unknown[] = []) => request(at("api/authoring/answer"), { cookie, method: "POST", body: { id, text, references } });
    const transcriptFolder = path.join(claudeConfig, "projects", first.replace(/[^A-Za-z0-9]/g, "-"));
    fs.mkdirSync(transcriptFolder, { recursive: true });
    // Claude Code could not start: it says why, and no conversation is recorded.
    startFailure = new Error("Claude Code is not logged in");
    const refused = await request(at("api/run"), { cookie, method: "POST", body: { name: "setup" } });
    assert.equal(refused.status, 500, refused.body);
    assert.match(JSON.parse(refused.body).error, /not logged in/);
    startFailure = null;
    assert.deepEqual(JSON.parse((await request(at("api/authoring"), { cookie })).body).conversations, []);
    // The session runs as the entry role, on the role's own instructions, with nobody to approve anything, standing alone.
    process.env.CLAUDECODE = "1";
    process.env.PASEO_AGENT_ID = "someone";
    const ran = await request(at("api/run"), { cookie, method: "POST", body: { name: "setup" } });
    assert.equal(ran.status, 200, ran.body);
    delete process.env.CLAUDECODE;
    delete process.env.PASEO_AGENT_ID;
    const { id } = JSON.parse(ran.body);
    const session = fakeSessions.at(-1)!;
    const { options: started } = session;
    assert.deepEqual(
      [started.cwd, started.agent, started.permissionMode, started.allowDangerouslySkipPermissions, started.permissionPrompts, started.systemPrompt],
      [first, "task-manager", "bypassPermissions", true, "none", { type: "preset", preset: "claude_code" }],
    );
    assert.deepEqual([started.env.CLAUDECODE, started.env.PASEO_AGENT_ID, started.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS], [undefined, undefined, "1"]);
    await until("the Studio's message reaches the session", () => session.sent.length === 1);
    assert.deepEqual([session.sent[0]!.message.content, session.sent[0]!.origin], ["Run the setup loop.", undefined], "the Studio's own words are never an answer to a review");
    assert.equal(read(path.join(first, ".contrejour/studio/conversations.json")).conversations[0].session.session_id, "fake-session-" + fakeSessions.length);
    assert.equal((await statusOf(id)).state, "running");
    // The page follows it: the words as they are written, the session's own and not a role's, and each change of state.
    const liveEvents: { id: string; state: string; steps: number; streaming: string }[] = [];
    const eventStream = http.request({ hostname: "127.0.0.1", port: new URL(studio.url).port, path: "/api/events", headers: { host: new URL(studio.url).host, cookie } }, (response) => {
      let buffered = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        buffered += chunk;
        for (let end = buffered.indexOf("\n\n"); end >= 0; end = buffered.indexOf("\n\n")) {
          const block = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);
          if (block.startsWith("data: ")) liveEvents.push(JSON.parse(block.slice(6)));
        }
      });
    });
    eventStream.on("error", () => undefined);
    eventStream.end();
    await until("the page is told of the session as it connects", () => liveEvents.some((event) => event.id === id && event.state === "running"));
    const words = (text: string, role: string | null = null) => ({ type: "stream_event", parent_tool_use_id: role, event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
    session.say({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start" } }, words("Hel"), words("a role's words", "a-role"), words("lo"));
    await until("the words reach the page", () => liveEvents.at(-1)?.streaming === "Hello");
    assert.equal(JSON.parse((await request(at(`api/authoring/timeline?id=${id}`), { cookie })).body).streaming, "Hello");
    // A loop in the background keeps it working past its turn's result: it is idle only when Claude Code says nothing is left.
    session.say({ type: "result", subtype: "success", is_error: false, result: "started" });
    await until("the result is read", () => liveEvents.at(-1)?.steps !== liveEvents.at(-2)?.steps);
    assert.equal((await statusOf(id)).state, "running");
    session.say({ type: "system", subtype: "session_state_changed", state: "idle" });
    await until("the page hears it is idle", () => liveEvents.at(-1)?.state === "idle");
    assert.deepEqual([(await statusOf(id)).state, (await statusOf(id)).failure], ["idle", null]);
    // Why a turn failed, in Claude Code's words: an API error, or what stopped it short.
    session.say({ type: "result", subtype: "success", is_error: true, result: "API Error: 400 reasoning effort must be low, high, xhigh, max or an integer" });
    await until("the failure is read", async () => (await statusOf(id)).failure !== null);
    assert.match((await statusOf(id)).failure, /^API Error: 400 reasoning effort/);
    session.say({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["the tool broke", "and again"] });
    await until("the failure is read", async () => (await statusOf(id)).failure === "the tool broke\nand again");
    // The owner's message goes in marked as a person's, with what they pointed at; the session works again.
    assert.equal((await answer("nope", "hello")).status, 404);
    assert.equal((await answer(id, "  ")).status, 400);
    const reply = await answer(id, "Make it shorter", [{ kind: "node", id: "n1", label: "Step 2" }]);
    assert.equal(reply.status, 200, reply.body);
    await until("the reply reaches the session", () => session.sent.length === 2);
    assert.deepEqual([session.sent[1]!.message.content, session.sent[1]!.origin], ["Make it shorter\n\n[On the canvas: Step 2]", { kind: "human" }]);
    assert.deepEqual([(await statusOf(id)).state, (await statusOf(id)).failure], ["running", null]);
    // Stopping it: what it is doing stops, and it waits for a message.
    assert.equal((await request(at("api/authoring/stop"), { cookie, method: "POST", body: { id } })).status, 200);
    assert.equal(session.interrupted, 1);
    await until("it stops", async () => (await statusOf(id)).state === "idle");
    // A loop's result, from the transcript as it grows: it waits for the owner, with the note; a message it never passed on leaves it waiting.
    const transcriptFile = path.join(transcriptFolder, `fake-session-${fakeSessions.length}.jsonl`);
    const notification = (at: string, result: unknown) => JSON.stringify({ type: "user", timestamp: at, promptSource: "system", origin: { kind: "task-notification" }, message: { role: "user", content: `<task-notification>\n<result>${JSON.stringify(result)}</result>\n</task-notification>` } }) + "\n";
    const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
    fs.writeFileSync(transcriptFile, notification(later(1), { waiting: "owner", review_id: "r1", question: "Is this right?", document: "The note." }));
    let waiting = await statusOf(id);
    assert.deepEqual([waiting.state, waiting.review.review_id, waiting.review.question, waiting.note, waiting.reply_failed], ["waiting", "r1", "Is this right?", "The note.", false]);
    fs.appendFileSync(transcriptFile, notification(later(-1), { waiting: "owner", review_id: "r1", question: "Is this right?", document: "The note." }));
    fs.appendFileSync(transcriptFile, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "It did not reach the loop." }] } }) + "\n");
    waiting = await statusOf(id);
    assert.deepEqual([waiting.state, waiting.reply_failed, waiting.last_words], ["waiting", true, "It did not reach the loop."]);
    // And the loop's end, once it has answered.
    fs.appendFileSync(transcriptFile, notification(later(1), { result: "finished" }));
    const done = await statusOf(id);
    assert.deepEqual([done.state, done.result], ["done", { result: "finished" }]);
    // Its process dies: why comes along with the last it printed, and no session runs it any more.
    fs.writeFileSync(transcriptFile, "");
    session.options.stderr("the last line it printed\n");
    session.die(new Error("Claude Code process exited with code 1"));
    await until("the page hears it ended", () => liveEvents.at(-1)?.state === "closed");
    const stopped = await statusOf(id);
    assert.deepEqual([stopped.state, stopped.failure], ["stopped", "Claude Code process exited with code 1\nthe last line it printed"]);
    // A message continues it from its transcript, as itself, under the same id.
    const before = fakeSessions.length;
    const continued = await answer(id, "Carry on");
    assert.equal(continued.status, 200, continued.body);
    assert.equal(fakeSessions.length, before + 1);
    const resumed = fakeSessions.at(-1)!;
    assert.deepEqual([resumed.options.resume, resumed.options.agent], [`fake-session-${before}`, "task-manager"]);
    await until("the message reaches the session", () => resumed.sent.length === 1);
    assert.deepEqual([resumed.sent[0]!.message.content, resumed.sent[0]!.origin], ["Carry on", { kind: "human" }]);
    assert.deepEqual([(await statusOf(id)).state, (await statusOf(id)).failure], ["running", null]);
    eventStream.destroy();
    fs.rmSync(path.join(first, ".contrejour/studio/conversations.json"));

    // A conversation from before this Studio started, as an earlier version recorded it: no session runs it, and the
    // chat reads it from its transcript. Without one nothing can continue it, and the chat says where it looked.
    const minuteAgo = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(
      path.join(first, ".contrejour/studio/conversations.json"),
      JSON.stringify({
        schema_version: 1,
        conversations: ["c8", "c9"].map((name) => ({ id: name, loop: "setup", base: null, session: { id: "idle01", session_id: name === "c9" ? "sess-idle" : "sess-plain", name: "run" }, started_at: minuteAgo, sent: [{ text: "Run the setup loop.", at: minuteAgo }] })),
      }),
    );
    assert.equal((await statusOf("c9")).state, "gone");
    assert.equal(JSON.parse((await request(at("api/authoring/timeline?id=c9"), { cookie })).body).record_missing, path.join(claudeConfig, "projects"), "where Claude Code keeps transcripts: its own folder, CLAUDE_CONFIG_DIR");
    fs.writeFileSync(path.join(transcriptFolder, "sess-plain.jsonl"), `${JSON.stringify({ type: "user", message: { role: "user", content: "Run the setup loop." } })}\n`);
    assert.equal((await statusOf("c8")).state, "stopped");

    // The chat shows the session's conversation row by row, from its transcript: what the Studio asked, what the
    // owner said, what the session said and did, the loop it ran with each role, errors, and each turn's end.
    const runDir = path.join(transcriptFolder, "sess-idle", "subagents", "workflows", "wf_run1");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "journal.jsonl"),
      [{ type: "launched" }, { type: "started", key: "k1", agentId: "a1", label: "goal", phase: "Goal" }, { type: "result", key: "k1", agentId: "a1" }, { type: "started", key: "k2", agentId: "a2", label: "task loop", phase: "Task loop" }]
        .map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );
    fs.writeFileSync(path.join(runDir, "agent-a1.meta.json"), JSON.stringify({ agentType: "project-setup" }));
    fs.writeFileSync(path.join(runDir, "agent-a2.meta.json"), JSON.stringify({ agentType: "loop-query" }));
    fs.writeFileSync(
      path.join(runDir, "agent-a1.jsonl"),
      [
        { type: "user", uuid: "r1", message: { role: "user", content: "{\"action\":\"goal\"}" } },
        { type: "assistant", uuid: "r2", message: { id: "rm1", role: "assistant", content: [{ type: "text", text: "The goal is clear." }] } },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );
    const minuteAt = (minute: number) => new Date(Date.UTC(2026, 10, 5, 8, minute)).toISOString();
    fs.writeFileSync(
      path.join(transcriptFolder, "sess-idle.jsonl"),
      [
        { type: "mode", mode: "normal" },
        { type: "user", uuid: "u1", timestamp: minuteAt(0), message: { role: "user", content: 'Run the setup loop with args {"answers":{}}.' } },
        { type: "attachment", attachment: {} },
        { type: "assistant", uuid: "a1", timestamp: minuteAt(1), message: { id: "m1", role: "assistant", content: [{ type: "thinking", thinking: "", signature: "x" }] } },
        { type: "assistant", uuid: "a2", timestamp: minuteAt(1), message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "t-bash", name: "Bash", input: { command: "ls .claude/loops\nwc -l" } }] } },
        { type: "user", uuid: "u2", timestamp: minuteAt(2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t-bash", content: "setup.md" }] }, toolUseResult: { stdout: "setup.md", stderr: "" } },
        { type: "assistant", uuid: "a3", timestamp: minuteAt(2), message: { id: "m2", role: "assistant", content: [{ type: "tool_use", id: "t-edit", name: "Edit", input: { file_path: path.join(first, "task.md"), old_string: "old", new_string: "new" } }] } },
        { type: "user", uuid: "u3", timestamp: minuteAt(2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t-edit", content: "edited" }] }, toolUseResult: { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] }] } },
        { type: "assistant", uuid: "a4", timestamp: minuteAt(3), message: { id: "m3", role: "assistant", content: [{ type: "tool_use", id: "t-loop", name: "Workflow", input: { name: "setup", args: {} } }] } },
        { type: "user", uuid: "u4", timestamp: minuteAt(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t-loop", content: "Started in the background as wf_run1." }] } },
        { type: "system", uuid: "s1", timestamp: minuteAt(4), subtype: "api_error", error: { formatted: "Request timed out." }, retryAttempt: 1, maxRetries: 10 },
        { type: "system", uuid: "s2", timestamp: minuteAt(4), subtype: "api_error", error: { formatted: "Request timed out." }, retryAttempt: 2, maxRetries: 10 },
        { type: "user", uuid: "u5", timestamp: minuteAt(5), origin: { kind: "task-notification" }, message: { role: "user", content: '<task-notification>\n<tool-use-id>t-loop</tool-use-id>\n<status>completed</status>\n<result>{"waiting":"owner","review_id":"r1"}</result>\n</task-notification>' } },
        { type: "assistant", uuid: "a5", timestamp: minuteAt(5), message: { id: "m4", role: "assistant", content: [{ type: "text", text: "The setup loop waits for your decision." }] } },
        { type: "system", uuid: "s3", timestamp: minuteAt(6), subtype: "turn_duration", durationMs: 125000 },
        { type: "user", uuid: "u6", timestamp: minuteAt(7), message: { role: "user", content: "<local-command-stdout>noise</local-command-stdout>" } },
        { type: "user", uuid: "u7", timestamp: minuteAt(8), message: { role: "user", content: "Make it shorter\n\n[On the canvas: Step 2 · Task loop]" } },
        { type: "assistant", uuid: "a6", timestamp: minuteAt(9), isApiErrorMessage: true, message: { id: "m5", role: "assistant", content: [{ type: "text", text: "API Error: 400 reasoning effort" }] } },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );
    const timelineOf = async (query: string) => JSON.parse((await request(at(`api/authoring/timeline?${query}`), { cookie })).body);
    const shown = await timelineOf("id=c9");
    assert.deepEqual([shown.record_missing, shown.streaming], [null, ""]);
    assert.deepEqual(
      shown.items.map((item: { kind: string; tool?: string; status?: string }) => [item.kind, item.tool ?? item.status ?? ""].filter(Boolean).join(":")),
      ["prompt", "thinking", "tool:shell", "tool:edit", "tool:workflow", "notice", "text", "turn-end", "owner", "notice"],
      "the bookkeeping, the local command's noise and the tool results' own rows are left out",
    );
    const [prompt, , bash, edit, loopRow, retry, text, turnEnd, owner, failure] = shown.items;
    assert.deepEqual([prompt.loop, JSON.parse(prompt.args)], ["setup", { answers: {} }]);
    assert.deepEqual([bash.title, bash.summary, bash.status], ["", "ls .claude/loops", "done"]);
    assert.deepEqual([edit.summary, edit.status], ["task.md", "done"], "a path inside the project, from the project's folder");
    assert.deepEqual([loopRow.status, loopRow.result, loopRow.run.id], ["done", "waiting:owner", "wf_run1"], "a loop runs until its notification");
    assert.deepEqual(loopRow.run.roles, [{ agent: "a1", role: "project-setup", phase: "Goal", label: "goal", done: true }, { agent: "a2", role: "loop-query", phase: "Task loop", label: "task loop", done: false }]);
    assert.deepEqual([retry.level, retry.text], ["warning", "Request timed out. (retry 2/10)"], "retries are one notice that follows them");
    assert.equal(text.text, "The setup loop waits for your decision.");
    assert.equal(turnEnd.durationMs, 125000);
    assert.deepEqual([owner.text, owner.pointers], ["Make it shorter", ["Step 2 · Task loop"]]);
    assert.deepEqual([failure.level, failure.text], ["error", "API Error: 400 reasoning effort"]);
    // A tool call in full, read when the owner opens it.
    const toolOf = async (query: string) => JSON.parse((await request(at(`api/authoring/tool?${query}`), { cookie })).body);
    assert.deepEqual(await toolOf("id=c9&tool=t-bash"), { kind: "shell", command: "ls .claude/loops\nwc -l", output: "setup.md", error: "" });
    assert.deepEqual((await toolOf("id=c9&tool=t-edit")).lines, [{ kind: "hunk", text: "@@ -1,1 +1,1 @@" }, { kind: "remove", text: "old" }, { kind: "add", text: "new" }]);
    assert.equal((await request(at("api/authoring/tool?id=c9&tool=nope"), { cookie })).status, 404);
    // One role of the loop, from its own transcript.
    const role = await timelineOf("id=c9&run=wf_run1&agent=a1");
    assert.deepEqual(role.items.map((item: { kind: string }) => item.kind), ["prompt", "text"]);
    assert.equal((await request(at("api/authoring/timeline?id=c9&run=..&agent=a1"), { cookie })).status, 200, "a run that is no name reads nothing");
    assert.equal((await request(at("api/authoring/timeline?id=nope"), { cookie })).status, 404);
    // Stopping a conversation no session runs asks nothing of anything; one the project does not have is an error.
    assert.equal((await request(at("api/authoring/stop"), { cookie, method: "POST", body: { id: "c9" } })).status, 200);
    assert.equal((await request(at("api/authoring/stop"), { cookie, method: "POST", body: { id: "nope" } })).status, 500);
    fs.rmSync(path.join(first, ".contrejour/studio/conversations.json"));
  } finally {
    await studio.close();
  }
  // Closing the Studio ends its sessions; each is there to continue later.
  assert.ok(fakeSessions.at(-1)!.closed, "the session still running ended with the Studio");
  assert.equal(fs.existsSync(path.join(claudeConfig, ".claude.json")), false, "the Studio writes nothing in Claude Code's own config");
  // Only a project is opened: a folder the installer never made one says so, with its path, and how to make one.
  await assert.rejects(serveStudio(path.join(sandbox, "not-a-project"), { port: 0 }), /not-a-project is not a project .*Projects page/);
  // The loop on the canvas is what the owner's words change, unless they ask for another loop; a role chosen to change is changed.
  const { describeRequest } = (await import(pathToFileURL(path.join(source, "dist/tools/studio-authoring.js")).href)) as {
    describeRequest(loop: string, base: { name: string; source: string } | null, text: string, pointers: { kind: string; id: string; label: string }[]): string;
  };
  assert.match(describeRequest("loop-authoring", { name: "iterate-and-check", source: "project" }, "Add a review", []), /looking at the loop `iterate-and-check`.*unless they ask for another loop: Add a review/);
  assert.match(describeRequest("role-authoring", { name: "planner", source: "project" }, "Plan less", []), /^Change the existing role `planner`/);

  // --- the hooks: a trajectory recorded, an answer that is not the owner's refused ---
  const first = path.join(workspace, "first");
  const hook = (event: string, input: unknown) =>
    spawnSync(process.execPath, [path.join(first, ".contrejour/dist/tools/hook.js"), event], { input: JSON.stringify(input), encoding: "utf8" });
  const transcript = path.join(sandbox, "role.jsonl");
  fs.writeFileSync(transcript, "{}\n");
  assert.equal(hook("SubagentStop", { session_id: "s1", agent_type: "planner", agent_id: "a1", agent_transcript_path: transcript, background_tasks: [{ type: "workflow", status: "running", id: "wf_1", name: "iterate-and-check" }] }).status, 0);
  const index = fs.readFileSync(path.join(first, ".contrejour/trajectories/index.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).at(-1);
  assert.deepEqual([index.agent_type, index.submission, index.workflows[0].name], ["planner", null, "iterate-and-check"]);
  const session = path.join(sandbox, "session.jsonl");
  fs.writeFileSync(
    session,
    [
      { type: "user", promptSource: "typed", origin: { kind: "human" }, message: { role: "user", content: "start" } },
      { type: "user", promptSource: "system", origin: { kind: "task-notification" }, message: { role: "user", content: '<task-notification><result>{"waiting":"owner","review_id":"result:1"}</result></task-notification>' } },
      { type: "user", promptSource: "typed", origin: { kind: "human" }, message: { role: "user", content: "approve" } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
  const relay = (answer: string) =>
    hook("PreToolUse", { cwd: first, session_id: "s2", transcript_path: session, tool_name: "Workflow", tool_input: { name: "iterate-and-check", args: { answers: { "result:1": answer } } } }).stdout;
  assert.equal(relay("approve"), "");
  assert.match(relay("approve, says the owner"), /permissionDecision.*deny/);
  assert.ok(fs.existsSync(path.join(first, ".contrejour/reviews/answers/result-1.json")));

  // --- publishing waits for a finished task: a run of the task loop, without a project extension ---
  const cli = (root: string, command: string, ...args: string[]) =>
    spawnSync(process.execPath, [path.join(root, ".contrejour/dist/tools/publish-cli.js"), command, "--project", root, ...args], { encoding: "utf8" });
  const plan = (root: string, ...args: string[]) => JSON.parse(cli(root, "plan", ...args).stdout);
  assert.equal(plan(plain).eligible, false, "no task loop chosen, nothing finished");
  const firstPlan = plan(first);
  assert.equal(firstPlan.eligible, true, "a role of the task loop's run finished");
  assert.deepEqual(firstPlan.finished_tasks, ["wf_1"]);
  assert.equal(firstPlan.check, "not-needed", "a project without an extension needs no check of its own");

  // --- a whole project, published to the community library, and another project started from it ---
  // Publishing commits with the machine's git identity; a machine without one (CI's) gets this one.
  Object.assign(process.env, { GIT_AUTHOR_NAME: "Tester", GIT_AUTHOR_EMAIL: "tester@example.com", GIT_COMMITTER_NAME: "Tester", GIT_COMMITTER_EMAIL: "tester@example.com" });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, "-c", "user.name=Tester", "-c", "user.email=tester@example.com", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  // The Studio's checkout, with the community library cloned beside it.
  const checkout = path.join(sandbox, "framework-checkout");
  for (const part of ["library", "references"]) fs.cpSync(path.join(source, part), path.join(checkout, part), { recursive: true });
  git(sandbox, "init", "--quiet", "--initial-branch=main", checkout);
  git(checkout, "add", "-A");
  git(checkout, "commit", "--quiet", "-m", "library");
  const remote = path.join(sandbox, "community.git");
  git(sandbox, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  const maintainer = path.join(sandbox, "community-maintainer");
  git(sandbox, "clone", "--quiet", remote, maintainer);
  fs.mkdirSync(path.join(maintainer, "projects"), { recursive: true });
  fs.writeFileSync(path.join(maintainer, "projects/.gitkeep"), "");
  git(maintainer, "add", "-A");
  git(maintainer, "commit", "--quiet", "-m", "start");
  git(maintainer, "push", "--quiet", "origin", "main");
  const community = path.join(checkout, "agent-loop-community");
  git(sandbox, "clone", "--quiet", remote, community);
  const { applyExample, applyReference, listReferences } = (await import(pathToFileURL(path.join(source, "dist/tools/workspace.js")).href)) as {
    applyExample(root: string, dir: string, source: string): { added: string[]; loop: string };
    applyReference(root: string, name: string): { added: string[]; loop: string };
    listReferences(library: string): { name: string; source: string; task_loop: string; params?: Record<string, unknown> }[];
  };
  // A project started from the framework's example, its task run once, one base role improved.
  const maker = path.join(workspace, "maker");
  execFileSync(process.execPath, [installer, "--role", "default", "--project", maker, "--library", checkout], { stdio: "ignore" });
  applyReference(maker, "iterate-and-check");
  fs.mkdirSync(path.join(maker, ".contrejour/trajectories"), { recursive: true });
  fs.writeFileSync(path.join(maker, ".contrejour/trajectories/index.jsonl"), `${JSON.stringify({ agent_type: "planner", workflows: [{ id: "wf_9", name: "iterate-and-check" }] })}\n`);
  fs.appendFileSync(path.join(maker, ".claude/agents/owner-review.md"), "\nA project's improvement to a base role.\n");
  // What the project is: written by project-publisher in the publish loop.
  assert.match(plan(maker).metadata.problem, /reference\.json/);
  fs.mkdirSync(path.join(maker, ".contrejour/publish"), { recursive: true });
  fs.writeFileSync(
    path.join(maker, ".contrejour/publish/reference.json"),
    JSON.stringify({ title: { zh: "边做边检查", en: "Plan, build, check" }, description: { zh: "一轮轮做、检查。", en: "Work in checked rounds." } }),
  );
  let published = plan(maker);
  assert.equal(published.name, "maker");
  assert.deepEqual(published.libraries.map((library: { name: string }) => library.name), ["framework-checkout", "agent-loop-community"]);
  // The whole project: what it got from its example and its version of a base role; the base roles it left as they were stay out.
  assert.deepEqual(
    published.selected.map((unit: { kind: string; name: string }) => `${unit.kind}:${unit.name}`).sort(),
    ["loop:iterate-and-check", "project:maker", "role:builder", "role:checker", "role:owner-review", "role:planner"],
  );
  assert.ok(published.not_selected.every((unit: { state: string }) => unit.state !== "unchanged"));
  assert.ok(published.unchanged >= 8, "the framework's base loops and roles, as installed, are not copied");
  assert.equal(published.library_check.ok, true, JSON.stringify(published.library_check));
  assert.equal(published.selected.find((unit: { kind: string }) => unit.kind === "project").files[0].target, "projects/maker/reference.json");
  // Exactly the approved plan leaves.
  assert.equal(JSON.parse(cli(maker, "publish", "--digest", "0".repeat(64)).stderr).reason, "PLAN_CHANGED");
  let sent = cli(maker, "publish", "--digest", published.digest);
  assert.equal(sent.status, 0, sent.stdout + sent.stderr);
  let result = JSON.parse(sent.stdout);
  assert.equal(result.status, "pushed");
  assert.match(result.branch, /^publish\/maker-\d{8}$/);
  assert.equal(git(remote, "show", `${result.branch}:projects/maker/reference.json`).includes('"task_loop": "iterate-and-check"'), true);
  assert.match(git(remote, "show", `${result.branch}:projects/maker/roles/owner-review.md`), /A project's improvement to a base role/);
  assert.equal(read(path.join(maker, ".contrejour/published.json")).name, "maker");
  // The maintainers merge it; another machine's Studio then starts a project from it.
  git(maintainer, "fetch", "--quiet", "origin");
  git(maintainer, "merge", "--quiet", "--no-edit", `origin/${result.branch}`);
  git(maintainer, "push", "--quiet", "origin", "main");
  git(community, "pull", "--quiet", "--ff-only");
  const example = listReferences(checkout).find((entry) => entry.name === "maker");
  assert.deepEqual([example?.source, example?.task_loop], ["community", "iterate-and-check"]);
  const follower = path.join(workspace, "follower");
  execFileSync(process.execPath, [installer, "--role", "default", "--project", follower, "--library", checkout], { stdio: "ignore" });
  applyReference(follower, "maker");
  assert.match(fs.readFileSync(path.join(follower, ".claude/agents/owner-review.md"), "utf8"), /A project's improvement to a base role/, "the example's version of a base role takes its place");
  assert.ok(fs.existsSync(path.join(follower, ".claude/agents/planner.md")));
  assert.deepEqual(read(path.join(follower, ".contrejour/loop.json")), { schema_version: 1, loop: "iterate-and-check", params: { max_rounds: 3 } });
  assert.ok(read(path.join(follower, ".contrejour/reference.json")).files.includes(".claude/agents/owner-review.md"));
  const followerUpdate = JSON.parse(execFileSync(process.execPath, [installer, "--role", "default", "--project", follower, "--library", checkout], { encoding: "utf8" }).split(/^Next:/m)[0]!);
  assert.deepEqual(followerUpdate.updated, [], "the example's version of a base role is the project's own");
  assert.match(fs.readFileSync(path.join(follower, ".claude/agents/owner-review.md"), "utf8"), /A project's improvement to a base role/);
  // A folder whose reference.json names another folder is no example, wherever it is.
  const misnamed = path.join(sandbox, "misnamed");
  fs.mkdirSync(misnamed);
  fs.writeFileSync(path.join(misnamed, "reference.json"), JSON.stringify({ name: "maker", task_loop: "iterate-and-check" }));
  assert.throws(() => applyExample(follower, misnamed, "community"), /is not an example project/);
  // Published again after a change: only what changed, and what the project no longer has is removed.
  assert.equal(plan(maker).digest, null, "the community already has exactly this project");
  fs.appendFileSync(path.join(maker, ".claude/agents/planner.md"), "\nLearned later.\n");
  fs.rmSync(path.join(maker, ".claude/agents/builder.md"));
  published = plan(maker);
  assert.deepEqual(published.selected.map((unit: { name: string; state: string }) => [unit.name, unit.state]), [["planner", "changed"]]);
  assert.deepEqual(published.removed, ["projects/maker/roles/builder.md"]);
  // A project of the same name that did not publish it cannot overwrite it.
  const other = path.join(sandbox, "elsewhere", "maker");
  fs.mkdirSync(path.dirname(other), { recursive: true });
  execFileSync(process.execPath, [installer, "--role", "default", "--project", other, "--library", checkout], { stdio: "ignore" });
  applyReference(other, "iterate-and-check");
  fs.mkdirSync(path.join(other, ".contrejour/publish"), { recursive: true });
  fs.copyFileSync(path.join(maker, ".contrejour/publish/reference.json"), path.join(other, ".contrejour/publish/reference.json"));
  const clash = plan(other);
  assert.ok(clash.not_selected.some((unit: { reason?: string }) => /another project is published as maker/.test(unit.reason ?? "")));
  assert.deepEqual(clash.removed, []);
  assert.equal(plan(other, "--name", "maker-two").not_selected.some((unit: { state: string }) => unit.state === "conflict"), false, "another name publishes it");
  // Without the community library, there is nowhere to publish until the owner has it fetched.
  fs.rmSync(community, { recursive: true, force: true });
  const nowhere = plan(maker);
  assert.equal(nowhere.library.available, false);
  assert.match(nowhere.library.reason, /publish-cli\.js clone/);

  // --- the Studio fetches the community library beside its checkout, and offers its projects as examples ---
  Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${remote}.insteadOf`, GIT_CONFIG_VALUE_0: "https://github.com/justforyou16007/agent-loop-community.git" });
  const studio2 = await serveStudio("", { port: 0, workspace, library: checkout });
  try {
    const at = (relative: string) => new URL(relative, studio2.url).href;
    const cookie = String((await request(studio2.loginUrl)).headers["set-cookie"]).split(";")[0]!;
    let listed = JSON.parse((await request(at("api/projects"), { cookie })).body);
    assert.deepEqual([listed.community.present, listed.references.map((entry: { name: string }) => entry.name)], [false, ["iterate-and-check"]]);
    const fetched = await request(at("api/projects/community"), { cookie, method: "POST", body: {} });
    assert.equal(fetched.status, 200, fetched.body);
    listed = JSON.parse((await request(at("api/projects"), { cookie })).body);
    assert.equal(listed.community.present, true);
    assert.deepEqual(
      listed.references.map((entry: { name: string; source: string }) => [entry.name, entry.source]),
      [["iterate-and-check", "framework"], ["maker", "community"]],
    );
    assert.equal(listed.projects.find((entry: { name: string }) => entry.name === "maker").published.name, "maker");
    // A project started from a community project opens on the task loop it brought, not on the framework's setup.
    assert.equal((await request(at("api/projects/open"), { cookie, method: "POST", body: { name: "follower" } })).status, 200);
    const followed = JSON.parse((await request(at("api/overview"), { cookie })).body);
    assert.deepEqual([followed.project.example, followed.project.setup_finished], ["maker", null]);
    assert.deepEqual(openingOf(followed), { key: "welcome_chosen", loop: "iterate-and-check" });
  } finally {
    await studio2.close();
  }

  // --- started from its own checkout, the Studio keeps a workspace of projects ---
  const home = path.join(sandbox, "home-workspace");
  const started = spawn(process.execPath, [path.join(source, "dist/tools/studio.js"), "--port", "0"], {
    env: { ...process.env, AGENT_LOOP_WORKSPACE: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const printed2 = await new Promise<string>((resolve, reject) => {
    let out = "";
    started.stdout.on("data", (chunk) => {
      out += String(chunk);
      if (out.includes("sign in")) resolve(out);
    });
    started.on("exit", (code) => reject(new Error(`the Studio exited with ${code}: ${out}`)));
  });
  started.kill();
  assert.match(printed2, new RegExp(`Agent Loop Studio for ${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is running`));
  assert.ok(fs.existsSync(home), "the workspace is made when it is missing");
  console.log("project: ok");
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
