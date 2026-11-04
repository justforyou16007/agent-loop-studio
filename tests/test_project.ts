/**
 * A project built with the framework alone, as the owner meets it: installed
 * from the framework's own package, started in the Studio from a reference
 * project, copied, its loops checked, its hooks recording trajectories and
 * guarding the owner's answers, its contribution waiting for a finished task.
 * No project package is involved. Run `npm run build` first.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
assert.ok(fs.existsSync(path.join(source, "dist", "studio", "index.html")), "run npm run build first");
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-project-")));
const workspace = path.join(sandbox, "workspace");
fs.mkdirSync(workspace);
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

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
  assert.match(printed, /studio\.js --project/);
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
  const refused = spawnSync(process.execPath, [installer, "--role", "worker", "--project", path.join(sandbox, "nope")], { encoding: "utf8" });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /--role default/);

  // --- the Studio starts, opens and copies projects in a workspace ---
  const { serveStudio } = (await import(pathToFileURL(path.join(source, "dist/tools/studio.js")).href)) as {
    serveStudio(root: string, options?: { port?: number; workspace?: string; library?: string }): Promise<{ url: string; loginUrl: string; close(): Promise<void> }>;
  };
  const studio = await serveStudio("", { port: 0, workspace, library: source });
  try {
    const at = (relative: string) => new URL(relative, studio.url).href;
    const cookie = String((await request(studio.loginUrl)).headers["set-cookie"]).split(";")[0]!;
    assert.equal((await request(at("api/overview"), { cookie })).status, 409, "no project is open yet");
    let projects = JSON.parse((await request(at("api/projects"), { cookie })).body);
    assert.equal(projects.current, null);
    assert.deepEqual(projects.projects.map((entry: { name: string }) => entry.name), ["plain"]);
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
    for (const command of ["check", "roles"]) {
      const checked = spawnSync(process.execPath, [path.join(first, ".contrejour/dist/tools/loop-check.js"), command, "--project", first], { encoding: "utf8" });
      assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    }
    const overview = JSON.parse((await request(at("api/overview"), { cookie })).body);
    assert.equal(overview.project.name, "first");
    // Not set up yet: the page opens it with its setup loop, the framework's.
    assert.equal(overview.project.setup_finished, null);
    assert.equal(overview.loops.find((loop: { name: string }) => loop.name === "setup").kind, "setup");
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
  } finally {
    await studio.close();
  }

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
