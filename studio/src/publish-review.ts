import type { PublishPlan, PublishUnit } from "../../src/tools/studio-types.js";

/**
 * The owner's review of a publication, entry by entry: every memory entry of
 * the plan, ticked when it leaves. Untick one and it stays out; tick one the
 * owner left out before and it goes back. What changes goes to the publish loop
 * as the owner's reply, which plans again; nothing changed is an approval.
 */

const LEAVING = new Set(["new", "changed"]);
/** Whether a unit leaves as the plan stands. */
export const leaves = (unit: PublishUnit): boolean => LEAVING.has(unit.state);
/** Whether the owner may tick it: an entry that leaves, or one they left out before. */
export const choosable = (unit: PublishUnit): boolean => leaves(unit) || unit.state === "excluded";
/** Whether it is shown ticked without being the owner's to change: already in the community as it is. */
export const alreadyThere = (unit: PublishUnit): boolean =>
  unit.state === "in-library" || unit.state === "already-sent";

/** The plan's memory entries, by role, roles and entries in name order. */
export function memoryByRole(plan: PublishPlan): { role: string; units: PublishUnit[] }[] {
  const roles = new Map<string, PublishUnit[]>();
  for (const unit of [...plan.selected, ...plan.not_selected]) {
    if (unit.kind !== "memory" || !unit.memory) continue;
    roles.set(unit.memory.role, [...(roles.get(unit.memory.role) ?? []), unit]);
  }
  return [...roles.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([role, units]) => ({
      role,
      units: units.sort((a, b) => a.name.localeCompare(b.name)),
    }));
}

/** The entries ticked as the plan stands: the ones that leave. */
export const plannedTicks = (plan: PublishPlan): Set<string> =>
  new Set(
    memoryByRole(plan)
      .flatMap((group) => group.units)
      .filter(leaves)
      .map((unit) => unit.name),
  );

/** What the owner's ticks change: entries that leave and should not, and entries left out that should go. */
export function selectionChange(
  plan: PublishPlan,
  ticked: ReadonlySet<string>,
): { leaveOut: string[]; putBack: string[] } {
  const units = memoryByRole(plan).flatMap((group) => group.units);
  return {
    leaveOut: units
      .filter((unit) => leaves(unit) && !ticked.has(unit.name))
      .map((unit) => unit.name),
    putBack: units
      .filter((unit) => unit.state === "excluded" && ticked.has(unit.name))
      .map((unit) => unit.name),
  };
}
