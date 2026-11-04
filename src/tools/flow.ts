/**
 * A loop as the Studio draws it: the steps of its definition as boxes, with the
 * roles each names, the stage it belongs to, the groups of roles inside it, the
 * points where the loop waits for the owner; arrows on to the next step, ahead
 * on a condition, back to an earlier step and to the end, taken from what the
 * definition says; and its parameters with the steps that use them. Also the
 * quick search the Studio runs while the owner types what they want.
 */
import type { LoopView, ViewData } from "./loop-view.js";
import type {
  Candidate,
  Flow,
  FlowEdge,
  FlowItem,
  FlowNode,
  FlowParam,
  LoopSummary,
  RoleSummary,
  SearchResult,
} from "./studio-types.js";

const backticked = (text: string): string[] =>
  [...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!.trim());
const named = (text: string, known: Set<string>): string[] => [
  ...new Set(backticked(text).filter((name) => known.has(name))),
];

export function summarize(loop: LoopView): LoopSummary {
  const steps = loop.steps.filter((step) => step.kind === "step");
  return {
    name: loop.name,
    source: loop.source,
    side: loop.side,
    kind: loop.kind,
    description: loop.description,
    chosen: loop.chosen,
    trial: loop.trial,
    steps: steps.length,
    waits: steps.filter((step) => step.roles.includes("owner-review")).length,
    roles: loop.roles,
    check: !loop.check ? "none" : loop.check.ok ? "ok" : loop.check.stale ? "stale" : "failed",
  };
}

/** A step's own text, and the list items under it (such as the groups of roles that run at once). */
function splitItems(
  text: string,
  roles: Set<string>,
  params: Set<string>,
): { text: string; items: FlowItem[] } {
  const own: string[] = [];
  const items: FlowItem[] = [];
  for (const line of text.split("\n")) {
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (item) {
      const itemText = item[1]!.trim();
      items.push({
        text: itemText,
        roles: named(itemText, roles),
        params: named(itemText, params),
      });
    } else if (items.length && /^\s+\S/.test(line)) {
      const last = items.at(-1)!;
      last.text = `${last.text} ${line.trim()}`;
      last.roles = named(last.text, roles);
      last.params = named(last.text, params);
    } else own.push(line);
  }
  return { text: own.join("\n").trim(), items };
}

const shorten = (text: string): string => (text.length > 48 ? `${text.slice(0, 47)}…` : text);

/**
 * When a step runs at all, as its text opens: "only with `regenerate`:",
 * "when a loop already does exactly this,", "on approval,".
 */
function entryOf(text: string): { label: string; length: number } | null {
  const opening = /^(only with|only when|only if|when|if|on|unless)\s+([^,:—]+?)\s*[,:—]/i.exec(
    text,
  );
  if (!opening) return null;
  const words = opening[2]!.replace(/`/g, "").trim();
  const label = /^(only with|on)$/i.test(opening[1]!)
    ? words
    : `${opening[1]!.toLowerCase()} ${words}`;
  return { label: shorten(label), length: opening[0].length };
}

/**
 * The condition a clause states before where it leads: "If it cannot get a
 * deliverable ready", `revise`, "otherwise", "Approval". Role and parameter
 * names are what a step does, not a condition.
 */
function conditionOf(before: string, known: Set<string>): string {
  const options = backticked(before).filter(
    (word) => /^[a-z][a-z0-9-]*$/.test(word) && !known.has(word),
  );
  if (options.length) return shorten(options.join(" / "));
  const phrase = /^\s*(if|when|with|unless|once|on)\s+([^,;]+)/i.exec(before);
  if (phrase) {
    const words = phrase[2]!.replace(/`/g, "").trim();
    return shorten(/^on$/i.test(phrase[1]!) ? words : `${phrase[1]} ${words}`);
  }
  if (/\botherwise\b/i.test(before)) return "otherwise";
  const plain = before
    .replace(/`/g, "")
    .replace(/[,;:\s]+$/, "")
    .trim();
  return plain && plain.split(/\s+/).length <= 3 && !/^(and|the loop|the round|it)$/i.test(plain)
    ? plain
    : "";
}

interface Route {
  to: number | "end" | "self";
  label: string;
}
/** Where a step's text says the loop goes from it: on to a step, back to one, or to its end. */
function routesOf(text: string, known: Set<string>): Route[] {
  const routes: Route[] = [];
  const entry = entryOf(text);
  const body = entry ? text.slice(entry.length) : text;
  const clauses = body
    .replace(/\n/g, " ")
    .split(/;\s+|\.\s+(?=[A-Z`(])|\.$/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  for (const clause of clauses) {
    const step = /\b(?:back to|on to|to) step (\d+)\b/i.exec(clause);
    const self = /\bback to this step\b/i.exec(clause);
    const end =
      /\b(ends? the (?:loop|round)|the (?:loop|round) ends|end the loop|the loop stops)\b/i.exec(
        clause,
      );
    const found = [step, self, end].filter(Boolean).sort((a, b) => a!.index - b!.index)[0];
    if (!found) continue;
    const label = conditionOf(clause.slice(0, found.index), known);
    if (found === step) routes.push({ to: Number(step![1]), label });
    else if (found === self) routes.push({ to: "self", label });
    else routes.push({ to: "end", label });
  }
  return routes;
}

export function flowOf(view: ViewData, loop: LoopView): Flow {
  const roleNames = new Set(view.roles.map((role) => role.name));
  const paramNames = new Set(loop.parameters.map((parameter) => parameter.name));
  const nodes: FlowNode[] = [
    {
      id: "start",
      kind: "start",
      number: null,
      title: "",
      text: "",
      notes: [],
      roles: [],
      loops: [],
      waits: false,
      group: null,
      items: [],
      params: [],
    },
  ];
  let notes: string[] = [];
  for (const step of loop.steps) {
    if (step.kind === "note") {
      notes.push(step.text);
      continue;
    }
    const { text, items } = splitItems(step.text, roleNames, paramNames);
    nodes.push({
      id: `s${step.number}`,
      kind: "step",
      number: step.number,
      title: step.title,
      text,
      notes,
      roles: step.roles,
      loops: step.loops,
      waits: step.roles.includes("owner-review"),
      group: step.group,
      items,
      params: named(step.text, paramNames),
    });
    notes = [];
  }
  const end: FlowNode = {
    id: "end",
    kind: "end",
    number: null,
    title: "",
    text: "",
    notes,
    roles: [],
    loops: [],
    waits: false,
    group: null,
    items: [],
    params: [],
  };
  nodes.push(end);

  const steps = nodes.filter((node) => node.kind === "step");
  const edges: FlowEdge[] = [];
  const edge = (from: string, to: string, kind: FlowEdge["kind"], label: string) => {
    const same = edges.find((known) => known.from === from && known.to === to);
    if (same) {
      if (label && !same.label.split(" / ").includes(label))
        same.label = same.label ? `${same.label} / ${label}` : label;
      return;
    }
    edges.push({ id: `${from}-${to}`, from, to, kind, label });
  };
  const known = new Set([...roleNames, ...paramNames]);
  const routes = new Map(steps.map((node) => [node.id, routesOf(node.text, known)]));
  // A step that ends the loop whatever happens does not lead on to the next one.
  const stops = (node: FlowNode) =>
    routes.get(node.id)!.some((route) => route.to === "end" && !route.label);
  edge("start", steps[0]?.id ?? "end", "next", "");
  steps.forEach((node, index) => {
    const next = steps[index + 1];
    if (next && !stops(node)) edge(node.id, next.id, "next", "");
    for (const route of routes.get(node.id)!) {
      if (route.to === "end") edge(node.id, "end", "end", route.label);
      else {
        const target = route.to === "self" ? node : steps.find((step) => step.number === route.to);
        if (!target) continue;
        const ahead = target.number! > node.number!;
        edge(node.id, target.id, target === next ? "next" : ahead ? "branch" : "back", route.label);
      }
    }
    if (!next && !stops(node)) edge(node.id, "end", "end", "");
  });
  // A step that runs only on a condition: the way into it carries the condition, and
  // when the condition does not hold the loop goes on to the step after it.
  steps.forEach((node, index) => {
    const entry = entryOf(node.text);
    if (!entry) return;
    const into = edges.filter((known) => known.to === node.id && known.kind === "next");
    for (const way of into) if (!way.label) way.label = entry.label;
    const after = steps[index + 1];
    if (!after) return;
    for (const way of into)
      if (!edges.some((known) => known.from === way.from && known.to === after.id))
        edge(way.from, after.id, "branch", "otherwise");
  });

  const links = (name: string): string[] =>
    nodes
      .filter(
        (node) =>
          node.params.includes(name) || node.items.some((item) => item.params.includes(name)),
      )
      .map((node) => node.id);
  const params: FlowParam[] = loop.parameters.map((parameter) => ({
    ...parameter,
    links: links(parameter.name),
  }));
  const roles: RoleSummary[] = loop.roles.map((name) => {
    const role = view.roles.find((entry) => entry.name === name);
    return {
      name,
      source: role?.source ?? "project",
      side: role?.side ?? "unknown",
      description: role?.description ?? "",
    };
  });
  return {
    loop: summarize(loop),
    purpose: loop.purpose,
    nodes,
    edges,
    params,
    roles,
    sections: loop.sections,
    parameter_problem: loop.parameter_problem,
  };
}

/**
 * Words of a Chinese request mapped to the words loop definitions use, so the
 * quick search finds an English definition from a Chinese request. Only a first
 * guess: the `loop-query` role ranks the candidates for real.
 */
const SYNONYMS: [RegExp, string[]][] = [
  [/想法|点子|创意|思路/, ["idea", "ideat"]],
  [/评分|打分|评估|评价/, ["assess", "score", "rank"]],
  [/排序|挑选|选出|选择|筛选|最优/, ["rank", "select", "choos", "top", "ucb"]],
  [
    /记忆|经验|教训|知识|wiki/i,
    ["memory", "wiki", "lesson", "effective", "ineffective", "query pack"],
  ],
  [/实验|实现|构建|训练|代码/, ["experiment", "implement", "build"]],
  [/提交|交付/, ["submit", "submission", "deliverable"]],
  [/审核|审批|确认|批准|人工|人审/, ["review", "owner", "approv"]],
  [/评审|验证|测试|检验|基准/, ["review", "validat", "test", "benchmark", "evaluat"]],
  [/贡献|共享|分享|流程库|生态/, ["contribut", "library", "share", "pull request"]],
  [/迭代|循环|一轮|多轮|重复/, ["round", "iterat", "repeat"]],
  [/问题|选题|题目|读题|任务/, ["problem", "task"]],
  [/搭建|配置|安装|设置|初始化/, ["setup", "configur", "install"]],
  [/创建|新建|编写|生成/, ["creat", "author", "draft", "generat"]],
  [/角色|智能体/, ["role"]],
  [/流程|工作流/, ["loop", "workflow"]],
  [/结果|整理|记录/, ["result", "record"]],
  [/泄漏|泄露/, ["leak"]],
  [/优化|改进|修复/, ["optimiz", "improv", "fix", "trajector"]],
  [/调研|检索|搜索|文献|论文/, ["survey", "search", "research"]],
  [/并行|同时/, ["parallel", "at once"]],
  [/提案/, ["proposal"]],
];
const STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "loop",
  "want",
  "need",
  "make",
  "into",
]);

function stem(word: string): string {
  return word.length > 5 ? word.replace(/(ations?|ings?|ions?|ers?|ed|es|s)$/, "") : word;
}
/** The words the quick search looks for, each with the request's word it came from. */
function terms(query: string): { term: string; from: string }[] {
  const out: { term: string; from: string }[] = [];
  for (const word of query.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? [])
    if (!STOP.has(word)) out.push({ term: stem(word), from: word });
  for (const run of query.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (const [pattern, words] of SYNONYMS) {
      const hit = pattern.exec(run);
      if (hit) for (const term of words) out.push({ term, from: hit[0] });
    }
    // A Chinese definition is matched by the request's own two-character pieces.
    for (let index = 0; index + 2 <= run.length; index += 1)
      out.push({ term: run.slice(index, index + 2), from: run.slice(index, index + 2) });
  }
  return out;
}

export function searchLoops(view: ViewData, query: string): SearchResult {
  const wanted = terms(query);
  const roleText = new Map(
    view.roles.map((role) => [role.name, `${role.name} ${role.description}`.toLowerCase()]),
  );
  const candidates: Candidate[] = view.loops.map((loop) => {
    const fields: [string, number][] = [
      [loop.name.replace(/-/g, " "), 3],
      [loop.description, 2],
      [loop.purpose, 1.5],
      [loop.steps.map((step) => step.title).join(" "), 1.5],
      [loop.steps.map((step) => step.text).join(" "), 1],
      [loop.roles.map((role) => roleText.get(role) ?? role).join(" "), 0.5],
    ].map(([text, weight]) => [String(text).toLowerCase(), Number(weight)]);
    let score = 0;
    const matched = new Set<string>();
    const seen = new Set<string>();
    for (const { term, from } of wanted) {
      if (seen.has(term)) continue;
      seen.add(term);
      const best = Math.max(
        0,
        ...fields.filter(([text]) => text.includes(term)).map(([, weight]) => weight),
      );
      if (best) {
        score += best;
        matched.add(from);
      }
    }
    return { ...summarize(loop), score: Math.round(score * 10) / 10, matched: [...matched] };
  });
  const rank = (candidate: Candidate) => (candidate.source === "project" ? 0 : 1);
  candidates.sort((a, b) => b.score - a.score || rank(a) - rank(b) || a.name.localeCompare(b.name));
  return { query, candidates };
}
