#!/usr/bin/env node
/**
 * Check the library's loops and roles as a project of each side sees them, each
 * under the side it declares, with the compiled helper (`npm run build` first).
 * With --stamp, first record in each library script the digest of its
 * definition, which a maintainer does after regenerating a script.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const library = path.join(root, "library");
const checker = path.join(root, "dist", "tools", "library-cli.js");
const stamp = process.argv.includes("--stamp");
const DIGEST = /^\/\/ contrejour-loop-definition-sha256: [0-9a-f]{64}[ \t]*$/gm;

const files = (dir, extension) =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((file) => file.endsWith(extension)).sort() : [];

// The package's manifest names the hook actions its loops may declare; the shared library has none.
const manifestFile = path.join(root, "project.json");
const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : undefined;
const sides = fs.existsSync(path.join(library, "loops"))
  ? fs
      .readdirSync(path.join(library, "loops"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  : [];

if (stamp)
  for (const side of sides) {
    const dir = path.join(library, "loops", side);
    for (const definition of files(dir, ".md")) {
      const script = path.join(dir, definition.replace(/\.md$/, ".js"));
      if (!fs.existsSync(script)) continue;
      const digest = crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, definition))).digest("hex");
      const text = fs.readFileSync(script, "utf8").replace(DIGEST, "").trimEnd();
      fs.writeFileSync(script, `${text}\n\n// contrejour-loop-definition-sha256: ${digest}\n`);
    }
  }

if (!fs.existsSync(checker)) throw new Error("Run npm run build first: dist/tools/library-cli.js is missing.");
const { checkLibrary } = await import(pathToFileURL(checker).href);
const { ok, reports } = await checkLibrary(library, manifest);
console.log(JSON.stringify(reports, null, 2));
process.exitCode = ok ? 0 : 1;
