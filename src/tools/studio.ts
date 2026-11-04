#!/usr/bin/env node
/**
 * Contrejour Studio: the owner's console, a page served on this machine. It
 * shows the project's loops as flows on a canvas, finds the loops close to what
 * the owner asks for and previews them, and shows roles and runs. Only the owner
 * may use it: it answers only on this machine's own address, and only to a
 * browser signed in with the one-time link it prints when it starts, which it
 * keeps in memory and never writes to a file, so no agent on the machine can act
 * as the owner through it.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCli, runCli } from "../lib/cli.js";
import { flowOf, searchLoops, summarize } from "./flow.js";
import { collectView, fingerprint, type ViewData } from "./loop-view.js";
import type { SessionOptions } from "./sessions.js";
import { COMMUNITY_LIBRARY, COMMUNITY_URL, installedLibrary } from "./installation.js";
import { useLoop } from "./project-loop.js";
import { copyProject, createProject, listProjects, listReferences } from "./workspace.js";
import {
  answerConversation,
  conversationStatuses,
  runLoop,
  startConversation,
  type AuthoringLoop,
  type Pointer,
  trialLoop,
} from "./studio-authoring.js";
import type { LoopDetail, Overview, RoleDetail } from "./studio-types.js";
import { isRecord } from "./validate.js";

const ASSETS = fileURLToPath(new URL("../studio/", import.meta.url));
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const COOKIE = "contrejour_studio";
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
};
/** The page loads only its own files and data; inline style attributes are how the canvas places its boxes. */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");
const SECURITY = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-frame-options": "DENY",
};

/** A small page with no data, shown to a browser that has not signed in. */
const signInPage = (message: string): string => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Contrejour Studio</title></head>
<body style="font:15px/1.6 system-ui,sans-serif;margin:15vh auto;max-width:560px;color:#1d2939">
<h1 style="font-size:20px">Contrejour Studio</h1><p>${message}</p></body></html>`;

function cookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) out.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return out;
}
const same = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

/** A request's JSON body, at most 64 KiB. */
function readBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 65_536) {
        reject(new Error("the request is too large"));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        resolve(isRecord(parsed) ? parsed : {});
      } catch {
        reject(new Error("the request is not JSON"));
      }
    });
    request.on("error", reject);
  });
}
const pointersOf = (value: unknown): Pointer[] =>
  Array.isArray(value)
    ? value
        .filter(
          (entry): entry is Pointer =>
            isRecord(entry) &&
            ["node", "edge", "param"].includes(String(entry.kind)) &&
            typeof entry.id === "string" &&
            typeof entry.label === "string",
        )
        .slice(0, 20)
        .map((entry) => ({
          kind: entry.kind,
          id: entry.id.slice(0, 120),
          label: entry.label.slice(0, 200),
        }))
    : [];

export interface Studio {
  url: string;
  /** Opens the Studio once: the first browser to use it is signed in, and the link stops working. */
  loginUrl: string;
  close(): Promise<void>;
}

export async function serveStudio(
  projectRoot: string,
  options: {
    host?: string;
    port?: number;
    assets?: string;
    session?: Partial<SessionOptions>;
    /** A folder of projects the owner switches between, starts and copies; `projectRoot` may then be empty. */
    workspace?: string;
    /** The library checkout new projects are installed from, when no project names one. */
    library?: string;
  } = {},
): Promise<Studio> {
  let root = projectRoot ? path.resolve(projectRoot) : "";
  const workspace = options.workspace
    ? path.resolve(options.workspace)
    : root
      ? path.dirname(root)
      : "";
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK.has(host))
    throw new Error(
      `the Studio is served only on this machine (127.0.0.1, localhost or ::1), not on ${host}; from another machine, forward the port with ssh -L`,
    );
  const assets = path.resolve(options.assets ?? ASSETS);
  if (!fs.existsSync(path.join(assets, "index.html")))
    throw new Error(
      `the Studio page is missing (${assets}); build the Contrejour checkout (npm run build) and reinstall`,
    );

  // Authoring sessions run unattended, so they need a mode that does not wait for approvals.
  const sessionOptions: SessionOptions = {
    claude_command: options.session?.claude_command ?? ["claude"],
    permission_mode: options.session?.permission_mode ?? "bypassPermissions",
    model: options.session?.model ?? null,
  };
  let loginToken: string | null = crypto.randomBytes(24).toString("base64url");
  const sessions = new Set<string>();
  let cache: { key: string; data: Promise<ViewData> } | null = null;
  const view = (): Promise<ViewData> => {
    const key = fingerprint(root);
    if (!cache || cache.key !== key) cache = { key, data: collectView(root, true) };
    return cache.data;
  };
  let allowedHosts = new Set<string>();

  const json = (response: http.ServerResponse, status: number, body: unknown, head = false) => {
    response.writeHead(status, { ...SECURITY, "content-type": "application/json; charset=utf-8" });
    response.end(head ? undefined : JSON.stringify(body));
  };

  async function api(
    request: http.IncomingMessage,
    url: URL,
    head: boolean,
    response: http.ServerResponse,
  ): Promise<void> {
    if (url.pathname.startsWith("/api/projects")) return projects(request, url, head, response);
    // Everything else is about the project open now.
    if (!root) return json(response, 409, { error: "open or create a project first" }, head);
    if (url.pathname.startsWith("/api/authoring")) return authoring(request, url, head, response);
    if (url.pathname === "/api/trial") {
      if (request.method !== "POST") return json(response, 405, { error: "POST only" });
      const body = await readBody(request);
      const name = typeof body.name === "string" ? body.name : "";
      const goal = typeof body.goal === "string" ? body.goal : "";
      const loops = (await view()).loops.filter((loop) => loop.source === "project");
      if (!loops.some((loop) => loop.name === name))
        return json(response, 404, { error: `this project has no loop ${name}` });
      if (!loops.some((loop) => loop.name === "loop-trial"))
        return json(response, 409, {
          error: "this project has no loop-trial loop: update its installation",
        });
      const conversation = await trialLoop(root, sessionOptions, name, goal);
      return json(response, 200, { id: conversation.id, session: conversation.session.id });
    }
    if (url.pathname === "/api/use" || url.pathname === "/api/run") {
      if (request.method !== "POST") return json(response, 405, { error: "POST only" });
      const body = await readBody(request);
      const name = typeof body.name === "string" ? body.name : "";
      if (url.pathname === "/api/use") {
        // The owner chooses the project's task loop and its parameter values.
        const params = isRecord(body.params) ? body.params : {};
        try {
          const used = useLoop(root, { name, params });
          cache = null;
          return json(response, 200, used);
        } catch (error) {
          return json(response, 400, { error: (error as Error).message });
        }
      }
      if (!(await view()).loops.some((loop) => loop.name === name && loop.source === "project"))
        return json(response, 404, { error: `this project has no loop ${name}` });
      const conversation = await runLoop(root, sessionOptions, name);
      return json(response, 200, { id: conversation.id, session: conversation.session.id });
    }
    const data = await view();
    const name = url.searchParams.get("name") ?? "";
    const source = url.searchParams.get("source");
    const loopOf = () =>
      data.loops.find((loop) => loop.name === name && (!source || loop.source === source));
    switch (url.pathname) {
      case "/api/overview": {
        const overview: Overview = {
          project: {
            name: data.project.name,
            root: data.project.root,
            side: data.project.side,
            language: data.project.language,
            library: data.project.library,
            chosen: data.project.chosen,
            setup_finished: data.project.setup_finished,
          },
          loops: data.loops.map(summarize),
          roles: data.roles.map((role) => ({
            name: role.name,
            source: role.source,
            side: role.side,
            description: role.description,
          })),
          generated_at: data.project.generated_at,
        };
        return json(response, 200, overview, head);
      }
      case "/api/flow": {
        const loop = loopOf();
        return loop
          ? json(response, 200, flowOf(data, loop), head)
          : json(response, 404, { error: `no loop ${name}` }, head);
      }
      case "/api/loop": {
        const loop = loopOf();
        if (!loop) return json(response, 404, { error: `no loop ${name}` }, head);
        const detail: LoopDetail = {
          loop: summarize(loop),
          definition: loop.definition,
          script: loop.script,
          defects: loop.check?.defects ?? [],
          runs: loop.runs,
        };
        return json(response, 200, detail, head);
      }
      case "/api/role": {
        const role = data.roles.find((entry) => entry.name === name);
        if (!role) return json(response, 404, { error: `no role ${name}` }, head);
        const detail: RoleDetail = { ...role };
        return json(response, 200, detail, head);
      }
      case "/api/search":
        return json(response, 200, searchLoops(data, url.searchParams.get("q") ?? ""), head);
      default:
        return json(response, 404, { error: "not found" }, head);
    }
  }

  /** The workspace's projects: list them with the reference projects, open one, start one, copy one. */
  async function projects(
    request: http.IncomingMessage,
    url: URL,
    head: boolean,
    response: http.ServerResponse,
  ): Promise<void> {
    const library = options.library ?? (root ? installedLibrary(root) : null) ?? null;
    const community = library ? path.join(library, COMMUNITY_LIBRARY) : null;
    if (request.method === "GET" || request.method === "HEAD")
      return json(
        response,
        200,
        {
          workspace,
          current: root ? path.basename(root) : null,
          projects: workspace ? listProjects(workspace) : [],
          references: listReferences(library),
          can_create: Boolean(workspace && library),
          community: { present: Boolean(community && fs.existsSync(path.join(community, ".git"))) },
        },
        head,
      );
    // The community library, beside the Studio's checkout: its published projects are the examples to start from.
    if (url.pathname === "/api/projects/community") {
      if (!library || !community)
        return json(response, 400, {
          error: "no library checkout to keep the community library beside",
        });
      const fetched = fs.existsSync(path.join(community, ".git"))
        ? spawnSync("git", ["-C", community, "pull", "--ff-only", "--quiet"], {
            encoding: "utf8",
            windowsHide: true,
          })
        : spawnSync("git", ["clone", "--quiet", COMMUNITY_URL, community], {
            encoding: "utf8",
            windowsHide: true,
          });
      if (fetched.status !== 0)
        return json(response, 502, {
          error: `could not fetch the community library: ${(fetched.stderr || String(fetched.error ?? "")).trim()}`,
        });
      return json(response, 200, { present: true, references: listReferences(library) });
    }
    const body = await readBody(request);
    const name = typeof body.name === "string" ? body.name : "";
    if (!workspace)
      return json(response, 400, { error: "the Studio was started without a workspace" });
    try {
      if (url.pathname === "/api/projects/open") {
        const found = listProjects(workspace).find((entry) => entry.name === name);
        if (!found) return json(response, 404, { error: `no project ${name}` });
        root = found.root;
      } else if (url.pathname === "/api/projects/new") {
        if (!library)
          return json(response, 400, { error: "no library checkout to install a project from" });
        const reference =
          typeof body.reference === "string" && body.reference ? body.reference : null;
        root = createProject(workspace, name, { library, reference }).root;
      } else if (url.pathname === "/api/projects/copy") {
        const from = typeof body.from === "string" ? body.from : "";
        root = copyProject(workspace, from, name).root;
      } else return json(response, 404, { error: "not found" });
    } catch (error) {
      return json(response, 400, { error: (error as Error).message });
    }
    cache = null;
    return json(response, 200, { current: path.basename(root) });
  }

  /** The chat's conversations with the authoring loops: start one, answer it, see how they stand. */
  async function authoring(
    request: http.IncomingMessage,
    url: URL,
    head: boolean,
    response: http.ServerResponse,
  ): Promise<void> {
    if (request.method === "GET" || request.method === "HEAD") {
      if (url.pathname !== "/api/authoring")
        return json(response, 404, { error: "not found" }, head);
      return json(
        response,
        200,
        { conversations: await conversationStatuses(root, sessionOptions) },
        head,
      );
    }
    const body = await readBody(request);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const pointers = pointersOf(body.references);
    if (url.pathname === "/api/authoring") {
      const loop: AuthoringLoop =
        body.loop === "role-authoring" ? "role-authoring" : "loop-authoring";
      const base =
        isRecord(body.base) &&
        typeof body.base.name === "string" &&
        typeof body.base.source === "string"
          ? { name: body.base.name, source: body.base.source }
          : null;
      if (!text) return json(response, 400, { error: "say what you want" });
      const conversation = await startConversation(root, sessionOptions, {
        loop,
        base,
        text,
        pointers,
      });
      return json(response, 200, { id: conversation.id, session: conversation.session.id });
    }
    if (url.pathname === "/api/authoring/answer") {
      if (typeof body.id !== "string") return json(response, 400, { error: "which conversation" });
      if (!text && !pointers.length) return json(response, 400, { error: "the reply is empty" });
      if (!(await conversationStatuses(root, sessionOptions)).some((entry) => entry.id === body.id))
        return json(response, 404, { error: `no conversation ${body.id}` });
      const conversation = await answerConversation(root, sessionOptions, {
        id: body.id,
        text,
        pointers,
      });
      return json(response, 200, { id: conversation.id, session: conversation.session.id });
    }
    return json(response, 404, { error: "not found" });
  }

  function file(pathname: string, head: boolean, response: http.ServerResponse): void {
    // Paths without an extension are the page's own routes: they all get the page.
    const relative = path.extname(pathname)
      ? decodeURIComponent(pathname).replace(/^\/+/, "")
      : "index.html";
    const target = path.resolve(assets, relative);
    if (target !== assets && !target.startsWith(assets + path.sep)) {
      response.writeHead(404, { ...SECURITY, "content-type": "text/plain" }).end("not found");
      return;
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      response.writeHead(404, { ...SECURITY, "content-type": "text/plain" }).end("not found");
      return;
    }
    const type = TYPES[path.extname(target)] ?? "application/octet-stream";
    const headers: Record<string, string> = { ...SECURITY, "content-type": type };
    if (type.startsWith("text/html")) headers["content-security-policy"] = CSP;
    response.writeHead(200, headers);
    response.end(head ? undefined : fs.readFileSync(target));
  }

  async function handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    // Another site's name pointing at this machine gets nothing.
    if (!allowedHosts.has(String(request.headers.host ?? ""))) {
      response.writeHead(421, { ...SECURITY, "content-type": "text/plain" }).end("wrong host");
      return;
    }
    const method = request.method ?? "GET";
    if (!["GET", "HEAD", "POST"].includes(method)) {
      response.writeHead(405, { ...SECURITY, allow: "GET, HEAD, POST" }).end();
      return;
    }
    const head = method === "HEAD";
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/auth") {
      const token = url.searchParams.get("t") ?? "";
      if (!loginToken || !same(token, loginToken)) {
        response
          .writeHead(403, {
            ...SECURITY,
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": CSP,
          })
          .end(
            signInPage(
              "这个登录链接已经用过或不对。重新启动 Studio 会打印一个新的。<br>This sign-in link was used or is wrong; restart the Studio for a new one.",
            ),
          );
        return;
      }
      loginToken = null;
      const session = crypto.randomBytes(24).toString("base64url");
      sessions.add(session);
      response
        .writeHead(302, {
          ...SECURITY,
          location: "/",
          "set-cookie": `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/`,
        })
        .end();
      return;
    }
    const session = cookies(request.headers.cookie).get(COOKIE) ?? "";
    const signedIn = [...sessions].some((known) => same(session, known));
    if (url.pathname.startsWith("/api/")) {
      if (!signedIn)
        return json(response, 401, { error: "sign in with the link the Studio printed" }, head);
      // A form on another site cannot send this header, so it cannot act for the owner.
      if (method === "POST" && request.headers["x-contrejour-studio"] !== "1")
        return json(response, 403, { error: "missing the Studio's request header" }, head);
      try {
        await api(request, url, head, response);
      } catch (error) {
        cache = null;
        json(response, 500, { error: (error as Error).message }, head);
      }
      return;
    }
    if (method === "POST") {
      response.writeHead(405, { ...SECURITY, allow: "GET, HEAD" }).end();
      return;
    }
    if (!signedIn) {
      response
        .writeHead(401, {
          ...SECURITY,
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": CSP,
        })
        .end(
          head
            ? undefined
            : signInPage(
                "请打开启动 Studio 的终端里打印的登录链接。<br>Open the sign-in link printed in the terminal where the Studio runs.",
              ),
        );
      return;
    }
    file(url.pathname, head, response);
  }

  const server = http.createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) json(response, 500, { error: (error as Error).message });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8790, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (options.port ?? 8790);
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const shown = host.includes(":") ? `[${host}]` : host;
  const url = `http://${shown}:${port}/`;
  return {
    url,
    loginUrl: `${url}auth?t=${loginToken}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The framework's checkout this Studio runs from, when it runs from one rather than from a project's copy. */
function studioCheckout(): string | null {
  const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  try {
    const manifest: unknown = JSON.parse(
      fs.readFileSync(path.join(checkout, "project.json"), "utf8"),
    );
    return isRecord(manifest) &&
      fs.existsSync(path.join(checkout, "distribution", "install-from-repo.mjs"))
      ? checkout
      : null;
  } catch {
    return null;
  }
}
/** Where the Studio keeps its projects unless told otherwise. */
const defaultWorkspace = (): string =>
  process.env.AGENT_LOOP_WORKSPACE || path.join(os.homedir(), "agent-loop-projects");

function cli(): void {
  const program = createCli(
    "studio",
    "Contrejour Studio: the owner's console for this project's loops and roles, in a browser on this machine",
  );
  program
    .option("--project <dir>", "the project to open")
    .option(
      "--workspace <dir>",
      "the folder of projects to switch between, start and copy (default, from the Studio's checkout: ~/agent-loop-projects, or AGENT_LOOP_WORKSPACE)",
    )
    .option(
      "--library <dir>",
      "the checkout new projects are installed from (default: the Studio's own checkout)",
    )
    .option(
      "--host <host>",
      "this machine's address to listen on: 127.0.0.1, localhost or ::1",
      "127.0.0.1",
    )
    .option("--port <port>", "port to listen on", "8790")
    .option("--claude <command>", "the Claude Code command the authoring sessions run", "claude")
    .option(
      "--permission-mode <mode>",
      "permission mode of the unattended authoring sessions: bypassPermissions or auto",
      "bypassPermissions",
    )
    .option("--model <model>", "model of the authoring sessions (default: Claude Code's)")
    .action(
      async (options: {
        project?: string;
        workspace?: string;
        library?: string;
        host: string;
        port: string;
        claude: string;
        permissionMode: string;
        model?: string;
      }) => {
        const port = Number(options.port);
        if (!Number.isInteger(port) || port < 0 || port > 65535)
          throw new Error("--port must be a port number");
        try {
          if (!["bypassPermissions", "auto"].includes(options.permissionMode))
            throw new Error(
              "--permission-mode must be bypassPermissions or auto: nobody is there to approve",
            );
          // Started from the Studio's own checkout, it keeps a workspace of projects and installs them from itself.
          const checkout = studioCheckout();
          const workspace =
            options.workspace ??
            (options.project ? undefined : checkout ? defaultWorkspace() : undefined);
          if (!options.project && !workspace)
            throw new Error("open a --project, or a --workspace of projects");
          if (workspace) fs.mkdirSync(path.resolve(workspace), { recursive: true });
          const studio = await serveStudio(options.project ?? "", {
            workspace,
            library: options.library ? path.resolve(options.library) : (checkout ?? undefined),
            host: options.host,
            port,
            session: {
              claude_command: [options.claude],
              permission_mode: options.permissionMode,
              model: options.model ?? null,
            },
          });
          console.log(
            [
              `Agent Loop Studio for ${options.project ? path.basename(path.resolve(options.project)) : path.resolve(workspace!)} is running (Ctrl+C stops it).`,
              `Open this link once to sign in; it works for one browser only and is not saved anywhere:`,
              `  ${studio.loginUrl}`,
            ].join("\n"),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EADDRINUSE")
            throw new Error(`port ${port} is in use: pass another with --port`);
          throw error;
        }
      },
    );
  runCli(program);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli();
