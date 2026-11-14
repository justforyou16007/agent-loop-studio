import type {
  AuthoringStatus,
  CanvasPointer,
  Flow,
  FolderListing,
  LoopDetail,
  LoopSource,
  OutputList,
  Overview,
  ProjectsInfo,
  RoleDetail,
  SearchResult,
  SessionTimeline,
  ToolDetail,
} from "../../src/tools/studio-types.js";

/** What went wrong, as the owner reads it: the helper's words without its code (`NOT_A_PROJECT: ...`). */
const readable = (message: string): string => message.replace(/^[A-Z][A-Z0-9_]+: /, "");

/** The Studio's own server, same origin; the session cookie goes along by itself. */
async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  if (response.status === 401) {
    window.location.reload();
    throw new Error("signed out");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw Object.assign(new Error(readable(body.error ?? `HTTP ${response.status}`)), {
      status: response.status,
    });
  }
  return (await response.json()) as T;
}
const query = (values: Record<string, string | undefined>): string =>
  new URLSearchParams(
    Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1])),
  ).toString();

/** A request that acts: only this page can send the header that lets it through. */
async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-contrejour-studio": "1",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (response.status === 401) {
    window.location.reload();
    throw new Error("signed out");
  }
  const reply = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok)
    throw Object.assign(new Error(readable(reply.error ?? `HTTP ${response.status}`)), {
      status: response.status,
    });
  return reply;
}

export interface AuthoringRequest {
  loop: "loop-authoring" | "role-authoring";
  base: { name: string; source: LoopSource } | null;
  text: string;
  references: CanvasPointer[];
}

export const api = {
  overview: () => get<Overview>("/api/overview"),
  flow: (name: string, source?: LoopSource) => get<Flow>(`/api/flow?${query({ name, source })}`),
  loop: (name: string, source?: LoopSource) =>
    get<LoopDetail>(`/api/loop?${query({ name, source })}`),
  role: (name: string) => get<RoleDetail>(`/api/role?${query({ name })}`),
  search: (q: string) => get<SearchResult>(`/api/search?${query({ q })}`),
  conversations: () => get<{ conversations: AuthoringStatus[] }>("/api/authoring"),
  startAuthoring: (request: AuthoringRequest) => post<{ id: string }>("/api/authoring", request),
  projects: () => get<ProjectsInfo>("/api/projects"),
  openProject: (name: string) =>
    post<{ current: string; update?: import("./types.js").ProjectUpdate }>("/api/projects/open", {
      name,
    }),
  fetchCommunity: () => post<{ present: boolean }>("/api/projects/community", {}),
  newProject: (name: string, reference: string | null) =>
    post<{ current: string }>("/api/projects/new", { name, reference }),
  copyProject: (from: string, name: string) =>
    post<{ current: string }>("/api/projects/copy", { from, name }),
  deleteProject: (name: string) =>
    post<{ deleted: string; current: string | null }>("/api/projects/delete", { name }),
  folders: (path?: string) => get<FolderListing>(`/api/projects/folders?${query({ path })}`),
  useWorkspace: (path: string, create: boolean) =>
    post<{ workspace: string; current: string | null }>("/api/projects/workspace", {
      path,
      create,
    }),
  use: (name: string, params: Record<string, unknown>) =>
    post<{ loop: string; params: Record<string, unknown>; added: string[] }>("/api/use", {
      name,
      params,
    }),
  run: (name: string) => post<{ id: string }>("/api/run", { name }),
  trial: (name: string, goal: string) => post<{ id: string }>("/api/trial", { name, goal }),
  /** A conversation as the chat shows it, row by row; or one role of a loop it ran. */
  timeline: (id: string, role?: { run: string; agent: string }) =>
    get<SessionTimeline>(
      `/api/authoring/timeline?${query({ id, run: role?.run, agent: role?.agent })}`,
    ),
  /** One tool call of a conversation, or of a role, in full. */
  tool: (id: string, tool: string, role?: { run: string; agent: string }) =>
    get<ToolDetail>(
      `/api/authoring/tool?${query({ id, tool, run: role?.run, agent: role?.agent })}`,
    ),
  stop: (id: string) => post<{ stopped: string }>("/api/authoring/stop", { id }),
  /** What the project's roles and loops gave, newest first, at or before a time. */
  outputs: (filter: { before?: string; kind?: "role" | "loop"; name?: string }) =>
    get<OutputList>(`/api/outputs?${query(filter)}`),
  /** Every loop the Studio runs here, with how it stands. */
  executions: () => get<{ executions: AuthoringStatus[] }>("/api/executions"),
  /** Resume a loop run where it stopped. */
  resume: (id: string) => post<{ id: string; run: string }>("/api/executions/resume", { id }),
  answer: (id: string, text: string, references: CanvasPointer[]) =>
    post<{ id: string }>("/api/authoring/answer", { id, text, references }),
};
