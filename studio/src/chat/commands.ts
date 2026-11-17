/** What, typed alone in the chat, asks how the project's loops stand rather than starting anything. */
const STATUS_COMMANDS = new Set(["/status", "/状态", "/运行状态"]);

/** Whether the owner's words ask for the status report: the command alone, in any case, spaces around it aside. */
export const isStatusCommand = (text: string): boolean =>
  STATUS_COMMANDS.has(text.trim().toLowerCase());
