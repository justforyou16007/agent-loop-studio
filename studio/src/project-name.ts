/**
 * A project's name, as the Studio takes it (the server checks the same,
 * `workspace.ts`): lowercase letters, digits, dots, dashes and underscores,
 * starting with a letter or a digit, at most 64 characters. The page says which
 * of these a name breaks, rather than only greying out the button.
 */
export const PROJECT_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type NameProblem =
  | { key: "name_empty" }
  | { key: "name_uppercase" }
  | { key: "name_characters"; characters: string[] }
  | { key: "name_start" }
  | { key: "name_too_long"; length: number }
  | { key: "name_taken" };

/** Why a name cannot be a new project's, the first reason found; null when it can be. */
export function nameProblem(name: string, taken: readonly string[] = []): NameProblem | null {
  if (!name) return { key: "name_empty" };
  if (/[A-Z]/.test(name)) return { key: "name_uppercase" };
  const characters = [...new Set(name.match(/[^a-zA-Z0-9._-]/gu) ?? [])];
  if (characters.length) return { key: "name_characters", characters };
  if (!/^[a-z0-9]/.test(name)) return { key: "name_start" };
  if (name.length > 64) return { key: "name_too_long", length: name.length };
  if (taken.includes(name)) return { key: "name_taken" };
  return null;
}

/**
 * A name the Studio takes, made from the one typed: lowercase, what lies
 * between the words a dash, and a number after it when the workspace has one of
 * that name. Null when nothing can be made of it.
 */
export function suggestedName(name: string, taken: readonly string[] = []): string | null {
  const made = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  if (!made) return null;
  for (let count = 1; count < 100; count += 1) {
    const candidate = count === 1 ? made : `${made}-${count}`;
    if (PROJECT_NAME.test(candidate) && !taken.includes(candidate))
      return candidate === name ? null : candidate;
  }
  return null;
}
