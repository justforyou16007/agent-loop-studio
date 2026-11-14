export const meta = {
  name: "publish",
  description:
    "Publish this whole project to the community library as an example: a plan, the project's own check when it has one, the owner's review of exactly what leaves, then one pull request",
  whenToUse:
    "When the owner asks, once a task has finished. Run with {}, then again with the owner's replies in answers.",
  phases: [{ title: "Plan" }, { title: "Own check" }, { title: "Review" }, { title: "Publish" }],
};

const STRINGS = { type: "array", items: { type: "string" } };
const PLAN = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["ready", "no-library", "not-eligible", "nothing", "unavailable"],
    },
    digest: { type: "string" },
    name: { type: "string" },
    exclude: STRINGS,
    upstream: { type: "string" },
    reason: { type: "string" },
    description: { type: "string" },
    units: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string" },
          name: { type: "string" },
          side: { type: "string" },
          state: { type: "string" },
          description: { type: "string" },
          judgement: { type: "string" },
          warnings: STRINGS,
        },
        required: ["kind", "name", "side", "state", "description", "judgement", "warnings"],
      },
    },
    not_selected: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string" },
          name: { type: "string" },
          state: { type: "string" },
          reason: { type: "string" },
        },
        required: ["kind", "name", "state", "reason"],
      },
    },
    removed: STRINGS,
    changes_file: { type: "string" },
    previews: STRINGS,
    library_defects: STRINGS,
    check: { type: "string", enum: ["not-needed", "required", "passed", "failed"] },
  },
  required: [
    "status",
    "digest",
    "name",
    "exclude",
    "upstream",
    "reason",
    "description",
    "units",
    "not_selected",
    "removed",
    "changes_file",
    "previews",
    "library_defects",
    "check",
  ],
};
const REVIEW = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["approve", "revise", "cancel", "ask"] },
    question: { type: "string" },
    document: { type: "string" },
    notes: { type: "string" },
    accepted: STRINGS,
  },
  required: ["decision", "question", "document", "notes", "accepted"],
};
const CLONED = {
  type: "object",
  properties: { failed: { type: "boolean" }, reason: { type: "string" } },
  required: ["failed", "reason"],
};
const PUBLISHED = {
  type: "object",
  properties: {
    status: { type: "string" },
    name: { type: "string" },
    pull_request: { type: "string" },
    compare_url: { type: "string" },
    branch: { type: "string" },
    base: { type: "string" },
    files: STRINGS,
    removed: STRINGS,
    reason: { type: "string" },
  },
  required: [
    "status",
    "name",
    "pull_request",
    "compare_url",
    "branch",
    "base",
    "files",
    "removed",
    "reason",
  ],
};

const answers = (args && args.answers) || {};
// The owner decides at owner-review steps; the loop stops there until the session brings the reply.
const review = (id, request) =>
  agent(JSON.stringify({ review_id: id, ...request, answer: answers[id] ?? null }), {
    agentType: "owner-review",
    schema: REVIEW,
    phase: "Review",
  });
const waiting = (id, decided) => ({
  waiting: "owner",
  review_id: id,
  question: decided.question,
  document: decided.document,
});
// Send back (the definition's Send back section): a step that cannot use an input names the step that
// made it (`send_back.to`); that step runs again with `returned`, then the step runs again on what it
// makes. At most SEND_BACKS times in a row; past that, or for the loop's own input (`caller`), the loop
// ends with `sent_back`.
const SEND_BACKS = 2;
const sending = (schema, to) => ({
  ...schema,
  properties: {
    ...schema.properties,
    send_back: {
      type: "object",
      properties: {
        needed: { type: "boolean" },
        to: { type: "string", enum: to },
        problems: { type: "array", items: { type: "string" } },
      },
      required: ["needed", "to", "problems"],
    },
  },
  required: [...schema.required, "send_back"],
});
const step = async (name, run, redo = {}) => {
  for (let returns = 0; ; returns += 1) {
    const out = await run();
    const back = out && out.send_back;
    if (!back || !back.needed) return out;
    const again = redo[back.to];
    if (!again || returns >= SEND_BACKS)
      return { sent_back: { by: name, to: back.to, problems: back.problems } };
    const remade = await again({ by: name, problems: back.problems });
    if (remade && (remade.sent_back || remade.waiting)) return remade;
  }
};
// A child loop is a step too: when it sends back what it was given (`sent_back.to` is `caller`), `redo`
// makes it again and the child loop runs again, at most SEND_BACKS times; what it sent back past that,
// or about its own steps, ends this loop with `sent_back` too.
const child = async (name, run, redo) => {
  for (let returns = 0; ; returns += 1) {
    const out = await run();
    const back = out && out.sent_back;
    if (!back) return out;
    if (!redo || back.to !== "caller" || returns >= SEND_BACKS)
      return { sent_back: { by: `${name}/${back.by}`, to: back.to, problems: back.problems } };
    const remade = await redo({ by: name, problems: back.problems });
    if (remade && (remade.sent_back || remade.waiting)) return remade;
  }
};

let name = "";
let exclude = [];
let notes = "";
// What Publish sent back to the plan: the next plan redoes it, and goes to the owner again.
let returned = null;
let publishReturns = 0;
for (let attempt = 1; attempt <= 6; attempt += 1) {
  // Step 1
  phase("Plan");
  const makePlan = (back) =>
    agent(JSON.stringify({ action: "plan", name, exclude, notes, returned: back }), {
      agentType: "project-publisher",
      schema: sending(PLAN, ["caller"]),
      phase: "Plan",
    });
  let plan = await step("project-publisher:plan", () => makePlan(returned));
  if (plan.sent_back) return { published: false, sent_back: plan.sent_back };
  returned = null;
  // A later step that cannot use the plan has it made again.
  const replan = async (back) => {
    const again = await step("project-publisher:plan", () => makePlan(back));
    if (!again.sent_back) plan = again;
    return again;
  };
  name = plan.name;
  exclude = plan.exclude;
  if (plan.status === "not-eligible" || plan.status === "nothing" || plan.status === "unavailable")
    return { published: false, reason: plan.reason };
  if (plan.status === "no-library") {
    // Step 2
    const id = `clone:${plan.upstream}`;
    const decided = await review(id, {
      subject: "a checkout of the community library",
      request:
        "This project has no checkout of the community library, which publishing needs. Fetch one from the address below?",
      materials: { upstream: plan.upstream, reason: plan.reason },
      approvable: true,
    });
    if (decided.decision === "ask") return waiting(id, decided);
    if (decided.decision !== "approve")
      return { published: false, reason: "the owner did not have a checkout fetched" };
    const cloned = await step(
      "project-publisher:clone",
      () =>
        agent(JSON.stringify({ action: "clone", upstream: plan.upstream }), {
          agentType: "project-publisher",
          schema: sending(CLONED, ["project-publisher:plan"]),
          phase: "Plan",
        }),
      { "project-publisher:plan": replan },
    );
    if (cloned.sent_back) return { published: false, sent_back: cloned.sent_back };
    if (cloned.failed) return { published: false, reason: cloned.reason };
    notes = "";
    continue;
  }
  // Step 3: the project's own check, when its rules ask for one, on exactly these files.
  let own = { verdict: "not-needed", findings: [] };
  if (plan.check === "required" || plan.check === "failed") {
    phase("Own check");
    // Files the check cannot use are planned again, and checked again.
    const checked = await child(
      "publish-check",
      () => workflow("publish-check", { digest: plan.digest, files: plan.previews, answers }),
      replan,
    );
    if (checked && checked.waiting) return checked;
    if (checked && checked.sent_back) return { published: false, sent_back: checked.sent_back };
    own = checked || { verdict: "fail", findings: ["the check did not finish"] };
  } else if (plan.check === "passed") own = { verdict: "pass", findings: [] };
  // Step 4
  phase("Review");
  const id = `publish:${plan.digest}`;
  const approvable =
    plan.library_defects.length === 0 && (own.verdict === "pass" || own.verdict === "not-needed");
  const decided = await review(id, {
    subject: `the project, published to the community library as ${plan.name}`,
    request:
      "Approve publishing exactly this as a pull request to the community library, or say what to leave out or put back, or change its name, title or description.",
    materials: {
      name: plan.name,
      description: plan.description,
      units: plan.units,
      not_selected: plan.not_selected,
      removed: plan.removed,
      changes_file: plan.changes_file,
      previews: plan.previews,
      library_defects: plan.library_defects,
      own_check: own,
    },
    approvable,
  });
  if (decided.decision === "ask") return waiting(id, decided);
  if (decided.decision === "cancel") return { published: false, reason: "the owner cancelled" };
  if (decided.decision === "approve" && approvable) {
    // Step 5
    phase("Publish");
    const sent = await agent(
      JSON.stringify({ action: "publish", name: plan.name, digest: plan.digest, exclude }),
      {
        agentType: "project-publisher",
        schema: sending(PUBLISHED, ["project-publisher:plan"]),
        phase: "Publish",
      },
    );
    // A plan Publish cannot use is made again, then put to the owner again: the owner approves
    // exactly what leaves.
    if (sent.send_back.needed) {
      if (publishReturns >= SEND_BACKS)
        return {
          published: false,
          sent_back: {
            by: "project-publisher:publish",
            to: "project-publisher:plan",
            problems: sent.send_back.problems,
          },
        };
      publishReturns += 1;
      returned = { by: "project-publisher:publish", problems: sent.send_back.problems };
      continue;
    }
    return { published: sent.status === "pushed", ...sent };
  }
  notes = decided.notes;
}
return { published: false, reason: "no plan was approved within 6 rounds" };

// contrejour-loop-definition-sha256: 3ffb2c7009869cee8cbb8216d47e3fa028c406c932d1b81d2189d973142683ac
