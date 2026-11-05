/** Something on the canvas the owner points at in the chat: a step, an arrow, or a parameter. */
export interface Reference {
  kind: "node" | "edge" | "param";
  id: string;
  label: string;
}
/** What the chat's @ list offers: a reference, with what tells it apart (an arrow's condition, a parameter's meaning). */
export interface Pointable extends Reference {
  detail: string;
}
/**
 * What the chat points out on the canvas, the rest greyed: the steps a role
 * does, a step by its title, the steps that run a loop, or what the owner
 * pointed at.
 */
export type Focus =
  | { kind: "role" | "step" | "loop"; name: string }
  | { kind: "pointer"; reference: Reference };
/** What bringing a project up to the Studio's framework did when it was opened: the files written, or why not. */
export interface ProjectUpdate {
  written: string[];
  problem: string | null;
}
/** The roles and loops the project knows: their names in the chat point them out on the canvas. */
export interface Names {
  roles: Set<string>;
  loops: Set<string>;
}

export interface ChatMessage {
  id: number;
  from: "owner" | "studio";
  /** The owner's words, or the Studio's when they are not one of its own sentences. */
  text?: string;
  /** One of the Studio's own sentences, shown in the page's current language. */
  key?: import("./i18n.js").TextKey;
  values?: Record<string, string | number>;
  references?: Reference[];
  /** Loops the Studio found for this message. */
  candidates?: import("../../src/tools/studio-types.js").Candidate[];
  pending?: boolean;
  /** A review note or the session's words, Markdown. */
  markdown?: string;
  /** Quick replies to the review this message shows. */
  actions?: boolean;
  /** A role draft's files, to view beside the current versions. */
  files?: { name: string; text: string; original: string | null }[];
  /** The roles the loop's run has started so far. */
  progress?: { phase: string; role: string; done: boolean }[];
  /** A folder Claude Code must be told to trust before loops run in it, and why the Studio could not record it. */
  trust?: { folder: string; detail?: string };
  /** Starts again what could not start, once what stood in the way is gone. */
  retry?: () => void;
  /** A conversation with a background session, shown as it goes under this message. */
  session?: string;
  /** That conversation's latest status, kept with the message once the chat moves on. */
  status?: import("../../src/tools/studio-types.js").AuthoringStatus | null;
  /** What the owner sent it that its transcript does not show yet. */
  replies?: { text: string; at: string }[];
}
