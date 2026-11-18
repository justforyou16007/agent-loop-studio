/**
 * The reasoning efforts the framework passes on to the model's provider: a
 * role's `effort`, and the level the owner chooses in the Studio's chat for the
 * sessions it starts. `medium` is left out: some providers Claude Code reaches
 * (DeepSeek among them) refuse it. No level at all is Claude Code's own.
 */
export const EFFORTS = ["low", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** Whether a value is one of the efforts. */
export const isEffort = (value: unknown): value is Effort =>
  (EFFORTS as readonly unknown[]).includes(value);
