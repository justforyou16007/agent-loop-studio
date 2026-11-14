import type { Overview } from "../../src/tools/studio-types.js";

/** What a project opens on: a loop put on the canvas with what the Studio says of it, the empty project's words alone, or nothing. */
export type Opening =
  | { key: "welcome_chosen" | "welcome_setup"; loop: string }
  | { key: "welcome_empty"; loop: null }
  | null;

/**
 * A project opens on its task loop, whether its setup chose it or the example it
 * started from did. One without a task loop opens with its setup loop until it is
 * set up, except one started empty in the Studio (the framework's own profile, no
 * example): it opens blank, to be built in the chat, its setup run when the owner
 * picks it.
 */
export function openingOf(data: Pick<Overview, "project" | "loops">): Opening {
  const chosen = data.project.chosen?.loop;
  if (chosen && data.loops.some((loop) => loop.name === chosen && loop.source === "project"))
    return { key: "welcome_chosen", loop: chosen };
  const setup = data.loops.find((loop) => loop.kind === "setup" && loop.source === "project");
  const startedEmpty = data.project.side === "default" && !data.project.example;
  if (!data.project.setup_finished && setup && !startedEmpty)
    return { key: "welcome_setup", loop: setup.name };
  if (startedEmpty && !data.loops.some((loop) => loop.source === "project" && !loop.framework))
    return { key: "welcome_empty", loop: null };
  return null;
}
