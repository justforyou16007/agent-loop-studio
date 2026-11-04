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

let name = "";
let exclude = [];
let notes = "";
for (let attempt = 1; attempt <= 6; attempt += 1) {
  // Step 1
  phase("Plan");
  const plan = await agent(JSON.stringify({ action: "plan", name, exclude, notes }), {
    agentType: "project-publisher",
    schema: PLAN,
    phase: "Plan",
  });
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
    const cloned = await agent(JSON.stringify({ action: "clone" }), {
      agentType: "project-publisher",
      schema: CLONED,
      phase: "Plan",
    });
    if (cloned.failed) return { published: false, reason: cloned.reason };
    notes = "";
    continue;
  }
  // Step 3: the project's own check, when its rules ask for one, on exactly these files.
  let own = { verdict: "not-needed", findings: [] };
  if (plan.check === "required" || plan.check === "failed") {
    phase("Own check");
    const checked = await workflow("publish-check", {
      digest: plan.digest,
      files: plan.previews,
      answers,
    });
    if (checked && checked.waiting) return checked;
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
      { agentType: "project-publisher", schema: PUBLISHED, phase: "Publish" },
    );
    return { published: sent.status === "pushed", ...sent };
  }
  notes = decided.notes;
}
return { published: false, reason: "no plan was approved within 6 rounds" };

// contrejour-loop-definition-sha256: 9b2c0e1fd5b5073b550865b28330f44a013dfe13a5f6a0d36ea143502e7cf906
