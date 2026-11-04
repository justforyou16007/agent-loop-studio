/**
 * What the Studio's server sends its page. Plain types with no imports, so the
 * page (built for the browser) and the server (built for Node) share them.
 */

export type LoopSource = "project" | "library";

/** One box of a loop's flow as the owner sees it: a step, or where the loop starts or ends. */
export interface FlowNode {
  id: string;
  kind: "start" | "step" | "end";
  number: number | null;
  title: string;
  /** The step's text from the definition, Markdown. */
  text: string;
  /** Paragraphs of the definition between the previous step and this one. */
  notes: string[];
  /** Roles the step names, in order. */
  roles: string[];
  /** Loops the step runs as a step. */
  loops: string[];
  /** The loop stops here for the owner's decision. */
  waits: boolean;
  /** The stage the step belongs to, such as `build` or `record`. */
  group: string | null;
  /** The step's sub-items, such as groups of roles that run at once. */
  items: FlowItem[];
  /** Parameters the step's text names. */
  params: string[];
}
export interface FlowItem {
  text: string;
  roles: string[];
  params: string[];
}
/** An arrow: on to the next step, a branch ahead, back to an earlier step, or to the end. */
export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  kind: "next" | "branch" | "back" | "end";
  /** When this way is taken, in the definition's words; empty for the plain next step. */
  label: string;
}
export interface FlowParam {
  name: string;
  type: string;
  default: unknown;
  /** This project's value, when this loop is the project's task loop. */
  value?: unknown;
  min?: number;
  max?: number;
  choices?: string[];
  description: string;
  /** The nodes whose text names it: the dashed lines on the canvas. */
  links: string[];
}
export interface RoleSummary {
  name: string;
  source: LoopSource;
  side: string;
  description: string;
}
export interface LoopSummary {
  name: string;
  source: LoopSource;
  side: string;
  kind: string;
  description: string;
  chosen: boolean;
  /** It can be tried for real with loop-trial: its definition declares trial arguments. */
  trial: boolean;
  steps: number;
  waits: number;
  roles: string[];
  check: "ok" | "stale" | "failed" | "none";
}
export interface Flow {
  loop: LoopSummary;
  purpose: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  params: FlowParam[];
  roles: RoleSummary[];
  /** Other sections of the definition (bounds, waiting, inputs…), Markdown. */
  sections: { title: string; markdown: string }[];
  parameter_problem: string | null;
}
export interface Candidate extends LoopSummary {
  score: number;
  /** The words of the request it matched. */
  matched: string[];
}
export interface SearchResult {
  query: string;
  candidates: Candidate[];
}
export interface ProjectSummary {
  name: string;
  root: string;
  side: string;
  language: "zh" | "en";
  library: string | null;
  chosen: { loop: string; params: Record<string, unknown> } | null;
  /** When the project's setup loop last finished; null while the project is not set up. */
  setup_finished: string | null;
}
export interface Overview {
  project: ProjectSummary;
  loops: LoopSummary[];
  roles: RoleSummary[];
  generated_at: string;
}
export interface RoleDetail extends RoleSummary {
  tools: string;
  effort: string;
  body: string;
  used_by: string[];
}
export interface RunSummary {
  id: string;
  started: string;
  ended: string;
  roles: { role: string; at: string }[];
  submissions: string[];
}
export interface LoopDetail {
  loop: LoopSummary;
  definition: string;
  script: string | null;
  defects: string[];
  runs: RunSummary[];
}

/** Something on the canvas the owner pointed at, in the words the page showed. */
export interface CanvasPointer {
  kind: "node" | "edge" | "param";
  id: string;
  label: string;
}
/** Where a loop stopped for the owner. */
export interface ReviewWait {
  review_id: string;
  question: string;
  document: string;
}
/** A conversation with an authoring loop, as the page shows it. */
export interface AuthoringStatus {
  id: string;
  /** Changing a loop or role through its authoring loop, or running one of the project's loops. */
  purpose: "authoring" | "run";
  loop: string;
  base: { name: string; source: string } | null;
  /** The background session's short id, for `claude attach`. */
  session: string;
  started_at: string;
  state: "running" | "waiting" | "idle" | "done" | "stopped" | "gone";
  review: ReviewWait | null;
  /** The review note, or the session's last words when it did not stop at a review. */
  note: string;
  /** What the loop returned when it ended. */
  result: unknown;
  draft: {
    name: string;
    flow: Flow | null;
    roles: string[];
    /** The draft's role files, for a role being changed. */
    files: { name: string; text: string; original: string | null }[];
  } | null;
  /** The roles the loop's current run has started, with their phase and whether they finished. */
  progress: { phase: string; role: string; done: boolean }[];
  /** The owner's last reply did not reach the loop, which still waits at the same review. */
  reply_failed: boolean;
  /** What the session said about it. */
  last_words: string;
}

/** The workspace's projects and the reference projects a new one can start from. */
export interface ProjectsInfo {
  workspace: string;
  current: string | null;
  projects: {
    name: string;
    root: string;
    package: string | null;
    profile: string | null;
    loop: string | null;
    /** Its latest publication to the community library, when it has one. */
    published: { name: string; at: string; pull_request: string | null } | null;
  }[];
  references: {
    name: string;
    title: { zh: string; en: string };
    description: { zh: string; en: string };
    task_loop: string;
    /** The framework's own reference project, or a project published to the community library. */
    source: "framework" | "community";
  }[];
  can_create: boolean;
  /** Whether the community library is beside the Studio's checkout, so its published projects can be started from. */
  community: { present: boolean };
  /** Other workspaces used before on this machine, the latest first. */
  recent_workspaces: string[];
}

/** A folder, as the owner browses for a workspace: the folders in it, and how many projects it holds. */
export interface FolderListing {
  path: string;
  parent: string | null;
  exists: boolean;
  folders: { name: string; path: string }[];
  projects: number;
}
