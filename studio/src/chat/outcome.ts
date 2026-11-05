import type { TextKey } from "../i18n.js";

/** The end of a loop, as the owner reads it: installed, chosen as it is, not installed and why, or what it returned. */
export function outcomeOf(result: unknown): { key: TextKey; values: Record<string, string> } {
  const fields = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const name =
    typeof fields.loop === "string"
      ? fields.loop
      : typeof fields.role === "string"
        ? fields.role
        : "";
  if (fields.installed === true || typeof fields.installed === "string")
    return {
      key: "authoring_installed",
      values: { name: typeof fields.installed === "string" ? fields.installed : name },
    };
  // The owner chose an existing loop as it is: nothing was drafted, nothing failed.
  if (fields.reused === true && name) return { key: "authoring_reused", values: { name } };
  if (fields.installed === false)
    return {
      key: "authoring_not_installed",
      values: { name, reason: String(fields.reason ?? "") },
    };
  return { key: "authoring_done", values: { result: resultLine(result) } };
}

/** What a loop returned, in a line: the name it installed, or its result as it is. */
export function resultLine(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const fields = result as Record<string, unknown>;
    for (const key of ["installed", "loop", "role", "name", "reason"])
      if (typeof fields[key] === "string") return String(fields[key]);
    return JSON.stringify(result).slice(0, 300);
  }
  return String(result ?? "");
}
