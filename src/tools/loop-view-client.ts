/// <reference lib="dom" />
/**
 * The loop viewer's page script. `loop-view.ts` embeds `client.toString()` in
 * the page it serves or writes, so this function runs in the browser and uses
 * nothing from outside its own body. Every piece of text that comes from the
 * project is escaped before it reaches the page.
 */
export function client(): void {
  type Lang = "zh" | "en";
  interface Step {
    kind: "step" | "note";
    number: number | null;
    title: string;
    text: string;
    roles: string[];
    loops: string[];
    group: string | null;
  }
  interface Parameter {
    name: string;
    type: string;
    default: unknown;
    min?: number;
    max?: number;
    choices?: string[];
    description: string;
    value?: unknown;
  }
  interface Check {
    ok: boolean;
    stale: boolean;
    roles_called: string[];
    defects: string[];
  }
  interface Run {
    id: string;
    started: string;
    ended: string;
    roles: { role: string; at: string }[];
    submissions: string[];
  }
  interface Loop {
    name: string;
    source: string;
    side: string;
    kind: string;
    description: string;
    triggers: string[];
    chosen: boolean;
    parameters: Parameter[];
    parameter_problem: string | null;
    purpose: string;
    steps: Step[];
    sections: { title: string; markdown: string }[];
    roles: string[];
    children: string[];
    definition: string;
    script: string | null;
    check: Check | null;
    runs: Run[];
  }
  interface Role {
    name: string;
    source: string;
    side: string;
    description: string;
    tools: string;
    effort: string;
    body: string;
    used_by: string[];
  }
  interface Data {
    project: {
      name: string;
      root: string;
      side: string;
      library: string | null;
      language: Lang;
      chosen: { loop: string; params: Record<string, unknown> } | null;
      generated_at: string;
      live: boolean;
    };
    loops: Loop[];
    roles: Role[];
  }
  interface View {
    type: "home" | "loop" | "role";
    name: string;
    tab: string;
  }

  const TEXT: Record<Lang, Record<string, string>> = {
    zh: {
      loops: "流程",
      search: "搜索流程或角色",
      kind_task: "主任务",
      "kind_on-request": "按需运行",
      kind_setup: "项目设置",
      library_only: "流程库里有、本项目未装",
      roles: "角色",
      no_match: "没有匹配的流程或角色。",
      side_framework: "框架",
      side_unknown: "未知端",
      source_project: "本项目",
      source_library: "流程库",
      chosen: "本项目的主任务",
      check_ok: "检查通过",
      check_stale: "脚本过期",
      check_bad: "有缺陷",
      check_none: "未检查",
      tab_steps: "步骤",
      tab_parameters: "超参数",
      tab_roles: "角色",
      tab_runs: "运行记录",
      tab_definition: "定义原文",
      tab_script: "脚本",
      tab_check: "检查",
      purpose: "用途",
      waits_owner: "停下等 owner 决定",
      step: "步骤",
      no_steps: "定义里没有按编号写出的步骤。",
      no_parameters: "这个流程没有可设置的超参数。",
      param_name: "超参数",
      param_value: "本项目取值",
      param_default: "默认值",
      param_range: "范围",
      param_meaning: "含义",
      param_problem: "超参数声明有误：",
      no_roles: "这个流程没有调用角色。",
      no_runs:
        "还没有运行记录。记录来自轨迹索引 .contrejour/trajectories/index.jsonl：流程里每个角色结束时，hook 记一条。",
      run: "运行",
      run_started: "开始",
      run_ended: "最后一个角色结束",
      run_roles: "完成的角色",
      run_submissions: "提交",
      stale_note:
        "定义在脚本生成之后改过，脚本需要按定义重新生成（loop-authoring 的 regenerate）。",
      defects: "缺陷",
      no_defects: "没有缺陷。",
      roles_called: "检查时实际调用到的角色",
      children: "作为一步运行的流程",
      library_unchecked: "流程库里的流程在本项目里没有检查；装进项目后才会检查。",
      used_by: "用到它的流程",
      not_used: "目前没有流程用到它。",
      tools: "工具",
      all_tools: "全部工具",
      effort: "思考深度",
      refresh: "刷新",
      generated: "读取于",
      snapshot: "离线快照，生成于",
      lang: "English",
      raw: "看原文",
      formatted: "看排版",
      not_found: "没有这个流程或角色。",
      load_failed: "读取失败：",
      home_title: "这个项目的流程",
      home_task: "主任务流程",
      home_none: "还没有选定主任务流程：在 Studio 里选一个。",
      home_side: "本项目是",
      home_library: "流程库",
      home_no_library: "安装时没有记录流程库",
      home_counts: "流程数",
      triggers: "事件动作",
      no_script: "这个流程还没有脚本。",
      steps_n: "{n} 步",
      roles_n: "{n} 个角色",
      back: "全部流程",
    },
    en: {
      loops: "Loops",
      search: "Search loops and roles",
      kind_task: "Task",
      "kind_on-request": "On request",
      kind_setup: "Setup",
      library_only: "In the library, not installed",
      roles: "Roles",
      no_match: "No loop or role matches.",
      side_framework: "framework",
      side_unknown: "unknown side",
      source_project: "project",
      source_library: "library",
      chosen: "this project's task loop",
      check_ok: "check passed",
      check_stale: "script stale",
      check_bad: "defects",
      check_none: "not checked",
      tab_steps: "Steps",
      tab_parameters: "Parameters",
      tab_roles: "Roles",
      tab_runs: "Runs",
      tab_definition: "Definition",
      tab_script: "Script",
      tab_check: "Check",
      purpose: "Purpose",
      waits_owner: "stops for the owner",
      step: "Step",
      no_steps: "The definition has no numbered steps.",
      no_parameters: "This loop has no parameters to set.",
      param_name: "Parameter",
      param_value: "Value here",
      param_default: "Default",
      param_range: "Range",
      param_meaning: "Meaning",
      param_problem: "The parameters are declared wrongly: ",
      no_roles: "This loop calls no role.",
      no_runs:
        "No runs recorded yet. Runs come from the trajectory index, .contrejour/trajectories/index.jsonl: the hook adds an entry each time a role of a loop finishes.",
      run: "Run",
      run_started: "Started",
      run_ended: "Last role finished",
      run_roles: "Roles finished",
      run_submissions: "Submissions",
      stale_note:
        "The definition changed after the script was generated: regenerate the script from it (loop-authoring, regenerate).",
      defects: "Defects",
      no_defects: "No defects.",
      roles_called: "Roles the check reached",
      children: "Loops it runs as a step",
      library_unchecked: "Library loops are not checked in this project; they are once installed.",
      used_by: "Used by",
      not_used: "No loop uses it yet.",
      tools: "Tools",
      all_tools: "all tools",
      effort: "Effort",
      refresh: "Refresh",
      generated: "Read",
      snapshot: "Offline snapshot,",
      lang: "中文",
      raw: "Source",
      formatted: "Formatted",
      not_found: "No such loop or role.",
      load_failed: "Could not load: ",
      home_title: "This project's loops",
      home_task: "Task loop",
      home_none: "No task loop has been chosen yet: choose one in the Studio.",
      home_side: "This project is the",
      home_library: "Library",
      home_no_library: "No library was recorded at installation",
      home_counts: "Loops",
      triggers: "Event actions",
      no_script: "This loop has no script yet.",
      steps_n: "{n} steps",
      roles_n: "{n} roles",
      back: "All loops",
    },
  };
  const TABS = ["steps", "parameters", "roles", "runs", "definition", "script", "check"];
  const KINDS = ["setup", "task", "on-request"];

  const app = document.getElementById("app") as HTMLElement;
  const embedded = document.getElementById("data");
  let data: Data | null = null;
  let loops = new Map<string, Loop>();
  let roles = new Map<string, Role>();
  let lang: Lang = "zh";
  let query = "";
  let raw = false;

  const t = (key: string, n?: number): string =>
    (TEXT[lang][key] ?? key).replace("{n}", String(n ?? ""));
  const esc = (value: unknown): string =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
    );
  const enc = (value: string): string => encodeURIComponent(value);
  const short = (text: string, length: number): string =>
    text.length > length ? text.slice(0, length - 1).trimEnd() + "…" : text;
  const time = (iso: string): string => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? iso
      : date.toLocaleString(lang === "zh" ? "zh-CN" : "en-GB", {
          dateStyle: "medium",
          timeStyle: "short",
        });
  };
  const show = (value: unknown): string =>
    typeof value === "string" ? value : JSON.stringify(value);

  // --- Markdown, with every role and loop name turned into a link ---
  function codeSpan(text: string): string {
    if (roles.has(text))
      return '<a class="chip role" href="#/role/' + enc(text) + '">' + esc(text) + "</a>";
    if (loops.has(text))
      return '<a class="chip loop" href="#/loop/' + enc(text) + '">' + esc(text) + "</a>";
    return "<code>" + esc(text) + "</code>";
  }
  function inline(text: string): string {
    const codes: string[] = [];
    let html = String(text).replace(/`([^`]+)`/g, (_, code: string) => {
      codes.push(code);
      return "\uE000" + (codes.length - 1) + "\uE000";
    });
    html = esc(html);
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/(^|[\s(])\*(?!\s)([^*]+?)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
    html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, href: string) =>
      /^https?:\/\//.test(href)
        ? '<a href="' + href + '" target="_blank" rel="noreferrer noopener">' + label + "</a>"
        : '<span class="ref" title="' + href + '">' + label + "</span>",
    );
    return html.replace(/\uE000(\d+)\uE000/g, (_, n: string) => codeSpan(codes[Number(n)] ?? ""));
  }
  function dedent(lines: string[]): string[] {
    const indents = lines
      .filter((line) => line.trim())
      .map((line) => (/^\s*/.exec(line) ?? [""])[0].length);
    const cut = indents.length ? Math.min(...indents) : 0;
    return lines.map((line) => line.slice(cut));
  }
  const isList = (line: string) => /^\s*(?:[-*+]|\d+\.)\s+/.test(line);
  const isFence = (line: string) => /^\s*```/.test(line);
  const isHeading = (line: string) => /^#{1,6}\s/.test(line);
  const isRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
  function table(rows: string[]): string {
    const cells = (row: string) =>
      row
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim());
    const head = cells(rows[0] ?? "");
    return (
      '<div class="table"><table><thead><tr>' +
      head.map((cell) => "<th>" + inline(cell) + "</th>").join("") +
      "</tr></thead><tbody>" +
      rows
        .slice(2)
        .map(
          (row) =>
            "<tr>" +
            cells(row)
              .map((cell) => "<td>" + inline(cell) + "</td>")
              .join("") +
            "</tr>",
        )
        .join("") +
      "</tbody></table></div>"
    );
  }
  interface Item {
    indent: number;
    ordered: boolean;
    number: number;
    lines: string[];
  }
  function items(list: Item[], start: number, end: number): string {
    let html = "";
    let open = "";
    let i = start;
    while (i < end) {
      const item = list[i]!;
      let j = i + 1;
      while (j < end && list[j]!.indent > item.indent) j += 1;
      const tag = item.ordered ? "ol" : "ul";
      if (open !== tag) {
        if (open) html += "</" + open + ">";
        html +=
          "<" +
          tag +
          (item.ordered && item.number !== 1 ? ' start="' + item.number + '"' : "") +
          ">";
        open = tag;
      }
      const body = md([item.lines[0] ?? ""].concat(dedent(item.lines.slice(1))).join("\n")).replace(
        /^<p>([\s\S]*?)<\/p>/,
        "$1",
      );
      html += "<li>" + body + (j > i + 1 ? items(list, i + 1, j) : "") + "</li>";
      i = j;
    }
    return html + (open ? "</" + open + ">" : "");
  }
  function md(source: string): string {
    const lines = String(source ?? "")
      .replace(/\r\n/g, "\n")
      .split("\n");
    let html = "";
    let i = 0;
    while (i < lines.length) {
      const line = lines[i]!;
      if (!line.trim()) {
        i += 1;
      } else if (isFence(line)) {
        const body: string[] = [];
        i += 1;
        while (i < lines.length && !isFence(lines[i]!)) body.push(lines[i++]!);
        i += 1;
        html += '<pre class="code"><code>' + esc(dedent(body).join("\n")) + "</code></pre>";
      } else if (isHeading(line)) {
        const match = /^(#{1,6})\s+(.*)$/.exec(line)!;
        const level = Math.min(6, match[1]!.length + 1);
        html += "<h" + level + ">" + inline(match[2]!) + "</h" + level + ">";
        i += 1;
      } else if (isRow(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
        const rows: string[] = [];
        while (i < lines.length && isRow(lines[i]!)) rows.push(lines[i++]!);
        html += table(rows);
      } else if (isList(line)) {
        const list: Item[] = [];
        while (i < lines.length) {
          const current = lines[i]!;
          const match = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(current);
          if (match) {
            list.push({
              indent: match[1]!.length,
              ordered: /\d/.test(match[2]!),
              number: Number.parseInt(match[2]!, 10) || 1,
              lines: [match[3]!],
            });
          } else if (current.trim() && /^\s+/.test(current) && list.length) {
            list[list.length - 1]!.lines.push(current);
          } else if (
            !current.trim() &&
            /^\s+\S|^\s*(?:[-*+]|\d+\.)\s/.test(lines[i + 1] ?? "") &&
            list.length
          ) {
            list[list.length - 1]!.lines.push("");
          } else break;
          i += 1;
        }
        html += items(list, 0, list.length);
      } else {
        const paragraph: string[] = [];
        while (
          i < lines.length &&
          lines[i]!.trim() &&
          !isList(lines[i]!) &&
          !isFence(lines[i]!) &&
          !isHeading(lines[i]!) &&
          !isRow(lines[i]!)
        )
          paragraph.push(lines[i++]!.trim());
        if (!paragraph.length) paragraph.push(lines[i++]!.trim());
        html += "<p>" + inline(paragraph.join(" ")) + "</p>";
      }
    }
    return html;
  }

  // --- pieces ---
  function status(loop: Loop): "ok" | "stale" | "bad" | "none" {
    if (!loop.check) return "none";
    if (loop.check.defects.length) return "bad";
    return loop.check.stale ? "stale" : "ok";
  }
  function statusBadge(loop: Loop): string {
    const state = status(loop);
    return '<span class="badge ' + state + '">' + esc(t("check_" + state)) + "</span>";
  }
  function kindBadge(loop: Loop): string {
    return (
      '<span class="badge kind-' + esc(loop.kind) + '">' + esc(t("kind_" + loop.kind)) + "</span>"
    );
  }
  function sideBadge(side: string): string {
    // The framework's own side is named; a project's sides keep the names its package gives them.
    return (
      '<span class="badge">' + esc(side === "framework" ? t("side_framework") : side) + "</span>"
    );
  }
  function roleChip(name: string, times = 1): string {
    const label = esc(name) + (times > 1 ? ' <span class="times">×' + times + "</span>" : "");
    return roles.has(name)
      ? '<a class="chip role" href="#/role/' + enc(name) + '">' + label + "</a>"
      : '<span class="chip missing" title="not installed">' + label + "</span>";
  }
  function loopChip(name: string): string {
    return loops.has(name)
      ? '<a class="chip loop" href="#/loop/' + enc(name) + '">' + esc(name) + "</a>"
      : '<span class="chip missing">' + esc(name) + "</span>";
  }
  function button(action: string, label: string): string {
    return (
      '<button class="btn" type="button" data-action="' + action + '">' + esc(label) + "</button>"
    );
  }

  function header(): string {
    const project = data!.project;
    const chosen = project.chosen
      ? '<a class="pill" href="#/loop/' +
        enc(project.chosen.loop) +
        '">' +
        esc(t("chosen")) +
        ": " +
        esc(project.chosen.loop) +
        "</a>"
      : '<span class="pill muted">' + esc(t("home_none")) + "</span>";
    return (
      '<header class="top"><a class="brand" href="#/">Contrejour</a><span class="sep"></span>' +
      '<span class="project">' +
      esc(project.name) +
      "</span>" +
      sideBadge(project.side) +
      chosen +
      '<span class="grow"></span><span class="stamp">' +
      esc((project.live ? t("generated") : t("snapshot")) + " " + time(project.generated_at)) +
      "</span>" +
      (project.live ? button("refresh", t("refresh")) : "") +
      button("lang", t("lang")) +
      "</header>"
    );
  }
  function loopItem(loop: Loop, view: View): string {
    const current = view.type === "loop" && view.name === loop.name;
    const state = status(loop);
    return (
      '<li><a class="loop-item' +
      (current ? " current" : "") +
      '" href="#/loop/' +
      enc(loop.name) +
      '"' +
      (current ? ' aria-current="page"' : "") +
      '><span class="dot ' +
      state +
      '" title="' +
      esc(t("check_" + state)) +
      '"></span>' +
      '<span class="name">' +
      esc(loop.name) +
      (loop.chosen ? ' <span class="star" title="' + esc(t("chosen")) + '">★</span>' : "") +
      "</span>" +
      '<span class="desc">' +
      esc(short(loop.description, 96)) +
      "</span></a></li>"
    );
  }
  function sideList(view: View): string {
    const needle = query.trim().toLowerCase();
    const matches = (loop: Loop) =>
      !needle ||
      (loop.name + " " + loop.description + " " + loop.roles.join(" "))
        .toLowerCase()
        .includes(needle);
    const groups: [string, Loop[]][] = KINDS.map((kind) => [
      "kind_" + kind,
      data!.loops.filter((loop) => loop.source === "project" && loop.kind === kind),
    ]);
    groups.push(["library_only", data!.loops.filter((loop) => loop.source === "library")]);
    let html = "";
    for (const [key, list] of groups) {
      const shown = list.filter(matches);
      if (!shown.length) continue;
      html +=
        '<h2 class="group">' +
        esc(t(key)) +
        '<span class="count">' +
        shown.length +
        '</span></h2><ul class="loops">' +
        shown.map((loop) => loopItem(loop, view)).join("") +
        "</ul>";
    }
    if (needle) {
      const found = data!.roles.filter((role) =>
        (role.name + " " + role.description).toLowerCase().includes(needle),
      );
      if (found.length)
        html +=
          '<h2 class="group">' +
          esc(t("roles")) +
          '<span class="count">' +
          found.length +
          '</span></h2><ul class="loops">' +
          found
            .map(
              (role) =>
                '<li><a class="loop-item" href="#/role/' +
                enc(role.name) +
                '"><span class="dot"></span><span class="name">' +
                esc(role.name) +
                '</span><span class="desc">' +
                esc(short(role.description, 96)) +
                "</span></a></li>",
            )
            .join("") +
          "</ul>";
    }
    return html || '<p class="empty">' + esc(t("no_match")) + "</p>";
  }
  function sidebar(view: View): string {
    return (
      '<nav class="side" aria-label="' +
      esc(t("loops")) +
      '"><div class="search"><input id="search" type="search" autocomplete="off" placeholder="' +
      esc(t("search")) +
      '" aria-label="' +
      esc(t("search")) +
      '"></div><div id="loop-list">' +
      sideList(view) +
      "</div></nav>"
    );
  }

  function home(): string {
    const project = data!.project;
    const chosen = project.chosen ? loops.get(project.chosen.loop) : undefined;
    const projectLoops = data!.loops.filter((loop) => loop.source === "project");
    let html =
      '<section class="home"><h1>' +
      esc(t("home_title")) +
      '</h1><div class="summary">' +
      '<div class="stat"><div class="k">' +
      esc(t("home_side")) +
      '</div><div class="v">' +
      esc(t("side_" + project.side)) +
      "</div></div>" +
      '<div class="stat"><div class="k">' +
      esc(t("home_task")) +
      '</div><div class="v">' +
      (chosen ? loopChip(chosen.name) : esc(t("home_none"))) +
      "</div></div>" +
      '<div class="stat"><div class="k">' +
      esc(t("home_counts")) +
      '</div><div class="v">' +
      projectLoops.length +
      "</div></div>" +
      '<div class="stat"><div class="k">' +
      esc(t("home_library")) +
      '</div><div class="v">' +
      esc(project.library ? short(project.library, 48) : t("home_no_library")) +
      "</div></div></div>";
    for (const kind of KINDS) {
      const list = projectLoops.filter((loop) => loop.kind === kind);
      if (!list.length) continue;
      html +=
        "<h2>" +
        esc(t("kind_" + kind)) +
        '</h2><div class="cards">' +
        list.map(loopCard).join("") +
        "</div>";
    }
    const library = data!.loops.filter((loop) => loop.source === "library");
    if (library.length)
      html +=
        "<h2>" +
        esc(t("library_only")) +
        '</h2><div class="cards">' +
        library.map(loopCard).join("") +
        "</div>";
    return html + "</section>";
  }
  function loopCard(loop: Loop): string {
    const steps = loop.steps.filter((step) => step.kind === "step").length;
    return (
      '<a class="loop-card" href="#/loop/' +
      enc(loop.name) +
      '"><div class="name">' +
      esc(loop.name) +
      (loop.chosen ? ' <span class="star">★</span>' : "") +
      '</div><div class="desc">' +
      esc(short(loop.description, 160)) +
      '</div><div class="meta">' +
      kindBadge(loop) +
      statusBadge(loop) +
      '<span class="badge">' +
      esc(t("steps_n", steps)) +
      '</span><span class="badge">' +
      esc(t("roles_n", loop.roles.length)) +
      "</span></div></a>"
    );
  }

  function flow(loop: Loop): string {
    if (!loop.steps.length) return '<p class="empty">' + esc(t("no_steps")) + "</p>";
    let html = '<ol class="flow">';
    let group: string | null = null;
    for (const step of loop.steps) {
      if (step.group && step.group !== group) {
        html += '<li class="flow-group"><span>' + esc(step.group) + "</span></li>";
        group = step.group;
      }
      if (step.kind === "note") {
        html += '<li class="flow-note">' + md(step.text) + "</li>";
        continue;
      }
      const waits = step.roles.includes("owner-review");
      html +=
        '<li class="flow-step' +
        (waits ? " waits" : "") +
        '"><div class="num">' +
        esc(step.number ?? "") +
        '</div><div class="card"><div class="card-head"><h3>' +
        esc(step.title || t("step")) +
        "</h3>" +
        (waits ? '<span class="badge wait">' + esc(t("waits_owner")) + "</span>" : "") +
        "</div>" +
        (step.roles.length || step.loops.length
          ? '<div class="chips">' +
            step.roles.map((name) => roleChip(name)).join("") +
            step.loops.map(loopChip).join("") +
            "</div>"
          : "") +
        '<div class="text">' +
        md(step.text) +
        "</div></div></li>";
    }
    return html + "</ol>";
  }
  function stepsPanel(loop: Loop): string {
    let html = loop.purpose
      ? '<div class="purpose"><div class="label">' +
        esc(t("purpose")) +
        "</div>" +
        md(loop.purpose) +
        "</div>"
      : "";
    html += flow(loop);
    const boxes = loop.sections.map(
      (section) =>
        '<div class="box"><h3>' + esc(section.title) + "</h3>" + md(section.markdown) + "</div>",
    );
    // The definition's own Triggers section explains them; the bare list is for one without it.
    if (loop.triggers.length && !loop.sections.some((section) => section.title === "Triggers"))
      boxes.push(
        '<div class="box"><h3>' +
          esc(t("triggers")) +
          '</h3><div class="chips">' +
          loop.triggers.map((trigger) => "<code>" + esc(trigger) + "</code>").join("") +
          "</div></div>",
      );
    return html + (boxes.length ? '<div class="extra">' + boxes.join("") + "</div>" : "");
  }
  function parametersPanel(loop: Loop): string {
    if (loop.parameter_problem)
      return '<p class="error">' + esc(t("param_problem") + loop.parameter_problem) + "</p>";
    if (!loop.parameters.length) return '<p class="empty">' + esc(t("no_parameters")) + "</p>";
    const head = [t("param_name")].concat(loop.chosen ? [t("param_value")] : [], [
      t("param_default"),
      t("param_range"),
      t("param_meaning"),
    ]);
    const rows = loop.parameters.map((parameter) => {
      const range = parameter.choices
        ? parameter.choices.join(" / ")
        : parameter.min !== undefined || parameter.max !== undefined
          ? String(parameter.min ?? "") + " – " + String(parameter.max ?? "")
          : parameter.type;
      const changed =
        parameter.value !== undefined && show(parameter.value) !== show(parameter.default);
      return (
        '<tr><td class="nw"><code>' +
        esc(parameter.name) +
        "</code></td>" +
        (loop.chosen
          ? '<td class="nw value' +
            (changed ? " changed" : "") +
            '">' +
            esc(parameter.value === undefined ? show(parameter.default) : show(parameter.value)) +
            "</td>"
          : "") +
        '<td class="nw">' +
        esc(show(parameter.default)) +
        '</td><td class="nw">' +
        esc(range) +
        "</td><td>" +
        inline(parameter.description) +
        "</td></tr>"
      );
    });
    return (
      '<div class="table"><table><thead><tr>' +
      head
        .map((cell, i) => (i < head.length - 1 ? '<th class="nw">' : "<th>") + esc(cell) + "</th>")
        .join("") +
      "</tr></thead><tbody>" +
      rows.join("") +
      "</tbody></table></div>"
    );
  }
  function rolesPanel(loop: Loop): string {
    if (!loop.roles.length) return '<p class="empty">' + esc(t("no_roles")) + "</p>";
    return (
      '<div class="cards">' +
      loop.roles
        .map((name) => {
          const role = roles.get(name);
          if (!role)
            return '<div class="role-card"><div class="name">' + esc(name) + "</div></div>";
          return (
            '<a class="role-card" href="#/role/' +
            enc(name) +
            '"><div class="name">' +
            esc(name) +
            '</div><div class="desc">' +
            esc(short(role.description, 180)) +
            '</div><div class="meta">' +
            sideBadge(role.side) +
            '<span class="badge">' +
            esc(t("source_" + role.source)) +
            "</span></div></a>"
          );
        })
        .join("") +
      "</div>"
    );
  }
  // A role that ran several times in one run (the informed ideators) is shown
  // once, with how many times it finished, in the order roles first finished.
  function finishedRoles(run: Run): string {
    const times = new Map<string, number>();
    for (const entry of run.roles) times.set(entry.role, (times.get(entry.role) ?? 0) + 1);
    return [...times].map(([name, count]) => roleChip(name, count)).join("");
  }
  function runsPanel(loop: Loop): string {
    if (!loop.runs.length) return '<p class="empty">' + esc(t("no_runs")) + "</p>";
    return (
      '<div class="table"><table><thead><tr><th class="nw">' +
      esc(t("run")) +
      '</th><th class="nw">' +
      esc(t("run_started")) +
      '</th><th class="nw">' +
      esc(t("run_ended")) +
      "</th><th>" +
      esc(t("run_roles")) +
      '</th><th class="nw">' +
      esc(t("run_submissions")) +
      "</th></tr></thead><tbody>" +
      loop.runs
        .map(
          (run) =>
            '<tr><td class="nw"><code>' +
            esc(run.id) +
            '</code></td><td class="nw">' +
            esc(time(run.started)) +
            '</td><td class="nw">' +
            esc(time(run.ended)) +
            '</td><td><div class="chips">' +
            finishedRoles(run) +
            '</div></td><td class="nw">' +
            esc(run.submissions.join(", ")) +
            "</td></tr>",
        )
        .join("") +
      "</tbody></table></div>"
    );
  }
  function definitionPanel(loop: Loop): string {
    const toolbar =
      '<div class="toolbar">' + button("raw", raw ? t("formatted") : t("raw")) + "</div>";
    const body = loop.definition.replace(/^---\n[\s\S]*?\n---\n?/, "");
    return (
      toolbar +
      (raw ? '<pre class="code"><code>' + esc(loop.definition) + "</code></pre>" : md(body))
    );
  }
  function scriptPanel(loop: Loop): string {
    if (!loop.script) return '<p class="empty">' + esc(t("no_script")) + "</p>";
    return (
      '<pre class="script">' +
      loop.script
        .split("\n")
        .map((line) => "<span>" + esc(line) + "</span>")
        .join("") +
      "</pre>"
    );
  }
  function checkPanel(loop: Loop): string {
    if (!loop.check) return '<p class="empty">' + esc(t("library_unchecked")) + "</p>";
    let html = "<p>" + statusBadge(loop) + "</p>";
    if (loop.check.stale) html += "<p>" + esc(t("stale_note")) + "</p>";
    html +=
      "<h2>" +
      esc(t("defects")) +
      "</h2>" +
      (loop.check.defects.length
        ? '<ul class="defects">' +
          loop.check.defects.map((defect) => "<li>" + esc(defect) + "</li>").join("") +
          "</ul>"
        : "<p>" + esc(t("no_defects")) + "</p>");
    html +=
      "<h2>" +
      esc(t("roles_called")) +
      '</h2><div class="chips">' +
      loop.check.roles_called.map((name) => roleChip(name)).join("") +
      "</div>";
    if (loop.children.length)
      html +=
        "<h2>" +
        esc(t("children")) +
        '</h2><div class="chips">' +
        loop.children.map(loopChip).join("") +
        "</div>";
    return html;
  }
  function tabCount(loop: Loop, tab: string): string {
    const n =
      tab === "steps"
        ? loop.steps.filter((step) => step.kind === "step").length
        : tab === "parameters"
          ? loop.parameters.length
          : tab === "roles"
            ? loop.roles.length
            : tab === "runs"
              ? loop.runs.length
              : 0;
    return n ? '<span class="n">' + n + "</span>" : "";
  }
  function loopView(view: View): string {
    const loop = loops.get(view.name);
    if (!loop) return '<p class="error">' + esc(t("not_found")) + "</p>";
    const tab = TABS.includes(view.tab) ? view.tab : "steps";
    const panels: Record<string, (loop: Loop) => string> = {
      steps: stepsPanel,
      parameters: parametersPanel,
      roles: rolesPanel,
      runs: runsPanel,
      definition: definitionPanel,
      script: scriptPanel,
      check: checkPanel,
    };
    return (
      '<article><div class="title-row"><h1>' +
      esc(loop.name) +
      "</h1>" +
      kindBadge(loop) +
      sideBadge(loop.side) +
      '<span class="badge">' +
      esc(t("source_" + loop.source)) +
      "</span>" +
      (loop.chosen ? '<span class="badge chosen">★ ' + esc(t("chosen")) + "</span>" : "") +
      statusBadge(loop) +
      '</div><p class="lead">' +
      inline(loop.description) +
      '</p><nav class="tabs" aria-label="' +
      esc(loop.name) +
      '">' +
      TABS.map(
        (name) =>
          '<a class="tab' +
          (name === tab ? " active" : "") +
          '" href="#/loop/' +
          enc(loop.name) +
          "/" +
          name +
          '"' +
          (name === tab ? ' aria-current="page"' : "") +
          ">" +
          esc(t("tab_" + name)) +
          tabCount(loop, name) +
          "</a>",
      ).join("") +
      '</nav><section class="panel">' +
      (panels[tab] ?? stepsPanel)(loop) +
      "</section></article>"
    );
  }
  function roleView(view: View): string {
    const role = roles.get(view.name);
    if (!role) return '<p class="error">' + esc(t("not_found")) + "</p>";
    return (
      '<article><div class="title-row"><h1>' +
      esc(role.name) +
      "</h1>" +
      sideBadge(role.side) +
      '<span class="badge">' +
      esc(t("source_" + role.source)) +
      '</span></div><p class="lead">' +
      inline(role.description) +
      '</p><div class="extra"><div class="box"><h3>' +
      esc(t("used_by")) +
      '</h3><div class="chips">' +
      (role.used_by.length ? role.used_by.map(loopChip).join("") : esc(t("not_used"))) +
      '</div></div><div class="box"><h3>' +
      esc(t("tools")) +
      "</h3><p>" +
      (role.tools ? "<code>" + esc(role.tools) + "</code>" : esc(t("all_tools"))) +
      "</p></div>" +
      (role.effort
        ? '<div class="box"><h3>' +
          esc(t("effort")) +
          "</h3><p><code>" +
          esc(role.effort) +
          "</code></p></div>"
        : "") +
      '</div><section class="panel">' +
      md(role.body) +
      "</section></article>"
    );
  }

  // --- navigation and state ---
  function route(): View {
    let parts: string[] = [];
    try {
      parts = location.hash
        .replace(/^#\/?/, "")
        .split("/")
        .map((part) => decodeURIComponent(part));
    } catch {
      parts = [];
    }
    if (parts[0] === "loop" && parts[1])
      return { type: "loop", name: parts[1], tab: parts[2] ?? "steps" };
    if (parts[0] === "role" && parts[1]) return { type: "role", name: parts[1], tab: "" };
    return { type: "home", name: "", tab: "" };
  }
  function render(): void {
    if (!data) return;
    const view = route();
    app.innerHTML =
      header() +
      '<div class="layout">' +
      sidebar(view) +
      '<main class="main" id="main">' +
      (view.type === "loop" ? loopView(view) : view.type === "role" ? roleView(view) : home()) +
      "</main></div>";
    const search = document.getElementById("search") as HTMLInputElement | null;
    if (search) search.value = query;
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    document.title = (view.name ? view.name + " · " : "") + "Contrejour " + t("loops");
  }
  async function load(fresh: boolean): Promise<void> {
    try {
      const text = embedded ? (embedded.textContent ?? "") : "";
      if (!fresh && text.trim() && text.trim() !== "null") data = JSON.parse(text) as Data;
      else {
        const response = await fetch("api/data", { cache: "no-store" });
        if (!response.ok) throw new Error(response.status + " " + (await response.text()));
        data = (await response.json()) as Data;
      }
      loops = new Map(data.loops.map((loop) => [loop.name, loop]));
      roles = new Map(data.roles.map((role) => [role.name, role]));
      let stored: string | null = null;
      try {
        stored = localStorage.getItem("contrejour-loop-view-lang");
      } catch {
        stored = null;
      }
      lang = stored === "zh" || stored === "en" ? stored : data.project.language;
      render();
    } catch (error) {
      app.innerHTML = '<p class="error">' + esc(t("load_failed") + String(error)) + "</p>";
    }
  }

  app.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
    if (!target) return;
    const action = target.dataset.action;
    if (action === "lang") {
      lang = lang === "zh" ? "en" : "zh";
      try {
        localStorage.setItem("contrejour-loop-view-lang", lang);
      } catch {
        // A file opened from disk may not keep it; the page still switches.
      }
      render();
    } else if (action === "refresh") void load(true);
    else if (action === "raw") {
      raw = !raw;
      render();
    }
  });
  app.addEventListener("input", (event) => {
    const input = event.target as HTMLInputElement;
    if (input.id !== "search") return;
    query = input.value;
    const list = document.getElementById("loop-list");
    if (list) list.innerHTML = sideList(route());
  });
  window.addEventListener("hashchange", () => {
    render();
    window.scrollTo(0, 0);
  });
  void load(false);
}
