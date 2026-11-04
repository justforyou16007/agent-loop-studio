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
}
