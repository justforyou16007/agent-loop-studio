import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    role: { type: "string" },
    project: { type: "string" },
    provider: { type: "string" },
    library: { type: "string" },
    force: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
const source = path.dirname(fileURLToPath(import.meta.url));
// The package says which profiles a project can be installed as, and how each starts. In a package
// project.json sits next to this installer; in a checkout, one level up from distribution/.
const manifestPath = [
  path.join(source, "project.json"),
  path.join(source, "..", "project.json"),
].find((file) => fs.existsSync(file));
if (!manifestPath) throw new Error("This package has no project.json naming its profiles.");
const packageManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const profiles = Object.keys(packageManifest.profiles ?? {});
if (values.help) {
  console.log(`bash install.sh --role ${profiles.join("|")} --project PATH [--dry-run] [--force]`);
  process.exit(0);
}
if (!values.project || !profiles.includes(values.role)) {
  throw new Error(`Specify --role ${profiles.join("|")} and --project PATH. See --help.`);
}
if (values.provider !== undefined) {
  throw new Error("Contrejour runs on Claude Code only; --provider was removed. See --help.");
}
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 12)) throw new Error("Node.js 22.12+ required");

const root = path.resolve(values.project);
const role = values.role;
const manifestFile = path.join(root, ".contrejour/install.json");
function digest(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
function safeRelative(relative) {
  return (
    typeof relative === "string" &&
    relative !== "" &&
    !relative.includes("\\") &&
    !path.isAbsolute(relative) &&
    relative.split("/").every((part) => part && part !== "." && part !== "..")
  );
}
function destination(relative) {
  if (!safeRelative(relative)) throw new Error(`Unsafe install path: ${relative}`);
  const target = path.join(root, relative);
  let current = target;
  while (true) {
    if (
      fs.existsSync(current) ||
      (() => {
        try {
          return fs.lstatSync(current).isSymbolicLink();
        } catch {
          return false;
        }
      })()
    ) {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Refusing symlink: ${current}`);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return target;
}
destination(".contrejour/install.json");
// Releases named ARL kept their data under .aris/; they are not migrated.
if (fs.existsSync(path.join(root, ".aris/install.json"))) {
  throw new Error(
    "This project was installed by an earlier release under .aris/ (ARL), which Contrejour does not migrate; install into a fresh project.",
  );
}
const previous = fs.existsSync(manifestFile)
  ? JSON.parse(fs.readFileSync(manifestFile, "utf8"))
  : null;
if (previous && !profiles.includes(previous.role)) {
  throw new Error(
    `This project's installation record names no profile of this package (${profiles.join(", ")}); install into a fresh project.`,
  );
}
if (previous && previous.role !== role) {
  throw new Error(`This project is installed for ${previous.role}; keep its role when updating.`);
}
// Earlier releases could install Codex projects; Contrejour runs on Claude Code only and does not migrate them.
if (previous?.provider !== undefined && previous.provider !== "claude") {
  throw new Error(
    `This project was installed for ${previous.provider}, which Contrejour no longer supports; install into a fresh project.`,
  );
}
const skills = ".claude/skills";
/**
 * Loops and roles from the library are seeded: written when the project has
 * none of that name. A copy of what was seeded stays under .contrejour/seeded/:
 * the baseline that tells what this project changed. Once the project changes one
 * (the optimizer fixes a role, the owner changes a loop), it is the project's own
 * and an update never replaces it; one still as seeded is the library's as
 * installed, and an update brings it to the library's new version, with its
 * baseline. What the example the project started from gave is the project's own
 * from the start. Nothing is ever removed. A project gets the framework's roles
 * and loops and its own side's.
 */
const sides = new Set(["framework", ...(packageManifest.profiles[role].sides ?? [])]);
function seededTarget(relative) {
  const role_ = /^library\/roles\/([a-z0-9-]+)\/([^/]+\.md)$/.exec(relative);
  if (role_) return sides.has(role_[1]) ? `.claude/agents/${role_[2]}` : null;
  const loop = /^library\/loops\/([a-z0-9-]+)\/([^/]+)\.(md|js)$/.exec(relative);
  if (loop && sides.has(loop[1]))
    return `.claude/${loop[3] === "md" ? "loops" : "workflows"}/${loop[2]}.${loop[3]}`;
  return null;
}
const seeded = [];
const kept = [];
const updated = [];
const baselines = [];
/** What the example the project started from gave it: the project's own, never brought to the library's version. */
const fromExample = (() => {
  try {
    const recorded = JSON.parse(
      fs.readFileSync(path.join(root, ".contrejour/reference.json"), "utf8"),
    );
    return new Set(
      Array.isArray(recorded.files)
        ? recorded.files.filter((file) => typeof file === "string")
        : [],
    );
  } catch {
    return new Set();
  }
})();
/** A seeded file the project has not changed: it still equals its baseline. */
function asSeeded(relative) {
  const target = destination(relative);
  const baseline = destination(`.contrejour/seeded/${relative.slice(".claude/".length)}`);
  return (
    fs.existsSync(target) &&
    fs.existsSync(baseline) &&
    digest(fs.readFileSync(target)) === digest(fs.readFileSync(baseline))
  );
}
/** A loop's definition and script are one: the other half of a loop's file, or null for a role. */
function otherHalf(relative) {
  const loop = /^\.claude\/loops\/(.+)\.md$/.exec(relative);
  if (loop) return `.claude/workflows/${loop[1]}.js`;
  const script = /^\.claude\/workflows\/(.+)\.js$/.exec(relative);
  return script ? `.claude/loops/${script[1]}.md` : null;
}
const manifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8"));
if (manifest.format !== 1 || !Array.isArray(manifest.files))
  throw new Error("Invalid Contrejour archive manifest");
const planned = [];
const hashes = {};
// A side's loop or role of the same name as the framework's takes its place: the project's own version.
const chosenSource = new Map();
for (const entry of manifest.files) {
  if (!entry.path.startsWith("library/")) continue;
  const target = seededTarget(entry.path);
  if (!target) continue;
  const known = chosenSource.get(target);
  if (
    !known ||
    known.startsWith("library/loops/framework/") ||
    known.startsWith("library/roles/framework/")
  )
    chosenSource.set(target, entry.path);
}
for (const entry of manifest.files) {
  if (!safeRelative(entry.path)) throw new Error("Invalid archive path");
  if (
    entry.path.startsWith("library/") &&
    chosenSource.get(seededTarget(entry.path) ?? "") !== entry.path
  )
    continue;
  const bytes = fs.readFileSync(path.join(source, entry.path));
  if (digest(bytes) !== entry.sha256)
    throw new Error(`Archive integrity check failed: ${entry.path}`);
  if (entry.path.startsWith("library/")) {
    const relative = seededTarget(entry.path);
    if (!relative) continue;
    const target = destination(relative);
    const baseline = destination(`.contrejour/seeded/${relative.slice(".claude/".length)}`);
    if (fs.existsSync(target)) {
      // Still as seeded, both halves of a loop: the library's as installed, so it takes the library's new version.
      const half = otherHalf(relative);
      if (
        digest(fs.readFileSync(target)) !== digest(bytes) &&
        !fromExample.has(relative) &&
        asSeeded(relative) &&
        (half === null ||
          !fs.existsSync(destination(half)) ||
          (!fromExample.has(half) && asSeeded(half)))
      ) {
        updated.push(relative);
        planned.push({ target, contents: bytes, relative });
        baselines.push({ target: baseline, contents: bytes });
        continue;
      }
      kept.push(relative);
      // From a release that kept no baseline, only an unedited copy has a known one.
      if (!fs.existsSync(baseline) && digest(fs.readFileSync(target)) === digest(bytes))
        baselines.push({ target: baseline, contents: bytes });
    } else {
      seeded.push(relative);
      planned.push({ target, contents: bytes, relative });
      baselines.push({ target: baseline, contents: bytes });
    }
    continue;
  }
  const isSkill = entry.path.startsWith("skills/");
  if (
    !isSkill &&
    !/^(dist|templates|node_modules)\//.test(entry.path) &&
    entry.path !== "package.json" &&
    entry.path !== "project.json"
  )
    continue;
  const relative = isSkill ? `${skills}/${entry.path.slice(7)}` : `.contrejour/${entry.path}`;
  const contents = bytes;
  const target = destination(relative);
  const nextHash = digest(contents);
  hashes[relative] = nextHash;
  if (fs.existsSync(target)) {
    const currentHash = digest(fs.readFileSync(target));
    if (currentHash === nextHash) continue;
    if (!values.force && currentHash !== previous?.files?.[relative]) {
      throw new Error(
        `Local file differs: ${relative}. Save your edits, then use --force to replace it.`,
      );
    }
  }
  planned.push({ target, contents, relative });
}
const removed = [];
for (const [relative, oldHash] of Object.entries(previous?.files ?? {})) {
  if (Object.hasOwn(hashes, relative)) continue;
  if (
    !relative.startsWith(`${skills}/`) &&
    !/^\.contrejour\/(dist|templates|node_modules)\//.test(relative) &&
    relative !== ".contrejour/project.json"
  ) {
    throw new Error(`Invalid managed path: ${relative}`);
  }
  const target = destination(relative);
  if (!fs.existsSync(target)) continue;
  if (!values.force && digest(fs.readFileSync(target)) !== oldHash) {
    throw new Error(
      `Removed upstream but locally edited: ${relative}. Save it before using --force.`,
    );
  }
  removed.push(target);
}
if (!values["dry-run"]) {
  for (const { target, contents } of [...planned, ...baselines]) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.contrejour-${process.pid}`;
    fs.writeFileSync(temp, contents);
    fs.renameSync(temp, target);
  }
  for (const target of removed) fs.unlinkSync(target);
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  const temp = `${manifestFile}.tmp`;
  fs.writeFileSync(
    temp,
    JSON.stringify(
      {
        format: 1,
        version: manifest.version,
        role,
        provider: "claude",
        ...(values.library
          ? { library: path.resolve(values.library) }
          : previous?.library
            ? { library: previous.library }
            : {}),
        files: hashes,
        seeded: [...new Set([...(previous?.seeded ?? []), ...seeded])].sort(),
      },
      null,
      2,
    ) + "\n",
  );
  fs.renameSync(temp, manifestFile);
  // Every session starts as the profile's entry role, the one that runs loops and relays the owner's
  // answers; the hooks check, among other things, that every answer it passes to a loop is the owner's own.
  const hooks = spawnSync(
    process.execPath,
    [path.join(root, ".contrejour/dist/tools/project-cli.js"), "hooks", "--project", root],
    { encoding: "utf8" },
  );
  if (hooks.status !== 0)
    throw new Error(
      `Could not write the hooks and the entry role in .claude/settings.json: ${hooks.stderr || hooks.stdout}`,
    );
}
console.log(
  JSON.stringify(
    {
      project: root,
      role,
      version: manifest.version,
      dry_run: values["dry-run"],
      written: planned.map((entry) => entry.relative),
      seeded,
      updated,
      kept_project_versions: kept,
      removed,
    },
    null,
    2,
  ),
);
// What to do next: what the package says this profile needs first, then setting up the project's workflow.
const next = [
  "Next: open claude in the project once and accept the folder trust prompt: background sessions start only in a trusted folder.",
  ...(packageManifest.profiles[role].next ?? []),
  `Setting up the workflow: the Studio, node ${path.join(root, ".contrejour/dist/tools/studio.js")} --project ${root}, opens a project not set up with its setup loop, which sets up the loop it runs and its values; in a session in the project, claude "Run the setup loop" does the same.`,
  "Loops and roles already in the project were kept as they are.",
];
console.log(next.join("\n"));
