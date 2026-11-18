/**
 * What, typed alone in the chat, asks the Studio how the project's loops stand
 * rather than the session anything. Claude Code's own commands (`/status` among
 * them) go to the session.
 */
const STATUS_COMMANDS = new Set(["/状态", "/运行状态"]);

/** Claude Code's command that leaves the conversation for a fresh one, with its aliases: the chat clears too. */
export const isClearCommand = (text: string): boolean =>
  /^\/(clear|reset|new)\s*$/i.test(text.trim());

/** Whether the owner's words ask for the status report: the command alone, in any case, spaces around it aside. */
export const isStatusCommand = (text: string): boolean =>
  STATUS_COMMANDS.has(text.trim().toLowerCase());
