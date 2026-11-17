/**
 * A loop in the owner's language. A loop's definition is written in English,
 * the language it runs in; beside it, `<loop>.<lang>.json` translates what the
 * Studio shows of it: `{"lang": "zh", "strings": {"<English>": "<translation>"}}`,
 * every string as the Studio shows it (the loop's description and purpose, each
 * step's title, text, notes and items, each arrow's condition, each parameter's
 * description, each other section's title and text). The page shows a string's
 * translation when there is one and the English otherwise, so a translation made
 * for an earlier version still covers what did not change.
 */
import fs from "node:fs";
import path from "node:path";
import type { Flow, LoopSummary } from "./studio-types.js";
import { isRecord } from "./validate.js";

/** The languages a loop is translated into, besides the English it is written in. */
export const TRANSLATED = ["zh"] as const;
export type Lang = "en" | (typeof TRANSLATED)[number];
export type Strings = Record<string, string>;

/** The translation of a definition into a language: `<loop>.<lang>.json` beside `<loop>.md`. */
export const translationFile = (definition: string, lang: string): string =>
  path.join(path.dirname(definition), `${path.basename(definition, ".md")}.${lang}.json`);

/** A translation file's strings; empty when there is none, or it is not one. */
export function readTranslation(file: string): Strings {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.strings)) return {};
    return Object.fromEntries(
      Object.entries(parsed.strings).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" && entry[1].trim() !== "",
      ),
    );
  } catch {
    return {};
  }
}
/** Every translation a definition has, by language. */
export function readTranslations(definition: string): Partial<Record<Lang, Strings>> {
  const found: Partial<Record<Lang, Strings>> = {};
  for (const lang of TRANSLATED) {
    const strings = readTranslation(translationFile(definition, lang));
    if (Object.keys(strings).length) found[lang] = strings;
  }
  return found;
}

/** Every string the Studio shows of a loop, once each, in the order it shows them. */
export function flowStrings(flow: Flow): string[] {
  const out: string[] = [];
  const add = (text: string | null | undefined) => {
    const trimmed = text?.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  };
  add(flow.loop.description);
  add(flow.purpose);
  for (const node of flow.nodes) {
    add(node.title);
    add(node.text);
    node.notes.forEach(add);
    node.items.forEach((item) => add(item.text));
    add(node.group);
  }
  flow.edges.forEach((edge) => add(edge.label));
  flow.params.forEach((param) => add(param.description));
  for (const section of flow.sections) {
    add(section.title);
    add(section.markdown);
  }
  return out;
}

/** The strings of a loop its translation does not have. */
export const missingStrings = (strings: string[], translation: Strings): string[] =>
  strings.filter((text) => !translation[text]);

const shown = (translation: Strings) => (text: string) => translation[text.trim()] ?? text;
/** A loop's summary in a language: its description translated, when it can be. */
export function translateSummary<T extends Pick<LoopSummary, "description">>(
  summary: T,
  translation: Strings,
): T {
  return { ...summary, description: shown(translation)(summary.description) };
}
/** A loop's flow in a language: every string it shows that the translation has, translated. */
export function translateFlow(flow: Flow, translation: Strings): Flow {
  const tr = shown(translation);
  return {
    ...flow,
    loop: translateSummary(flow.loop, translation),
    purpose: tr(flow.purpose),
    nodes: flow.nodes.map((node) => ({
      ...node,
      title: tr(node.title),
      text: tr(node.text),
      notes: node.notes.map(tr),
      items: node.items.map((item) => ({ ...item, text: tr(item.text) })),
      group: node.group === null ? null : tr(node.group),
    })),
    edges: flow.edges.map((edge) => ({ ...edge, label: tr(edge.label) })),
    params: flow.params.map((param) => ({ ...param, description: tr(param.description) })),
    sections: flow.sections.map((section) => ({
      title: tr(section.title),
      markdown: tr(section.markdown),
    })),
  };
}
