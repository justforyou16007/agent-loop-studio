export const meta = {
  name: "library-contribution",
  description:
    "Send what this project added or changed to the shared library as a pull request, with the owner's review of exactly that plan",
  whenToUse:
    "When the owner asks, once a task has finished. Run with {}, then again with the owner's replies in answers.",
  phases: [{ title: "Plan" }, { title: "Review" }, { title: "Contribute" }],
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
    exclude: STRINGS,
    upstream: { type: "string" },
    reason: { type: "string" },
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
    changes_file: { type: "string" },
    previews: STRINGS,
    library_defects: STRINGS,
  },
  required: [
    "status",
    "digest",
    "exclude",
    "upstream",
    "reason",
    "units",
    "not_selected",
    "changes_file",
    "previews",
    "library_defects",
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
const SENT = {
  type: "object",
  properties: {
    status: { type: "string" },
    pull_request: { type: "string" },
    compare_url: { type: "string" },
    branch: { type: "string" },
    base: { type: "string" },
    files: STRINGS,
    reason: { type: "string" },
  },
  required: ["status", "pull_request", "compare_url", "branch", "base", "files", "reason"],
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

let exclude = [];
let notes = "";
for (let attempt = 1; attempt <= 6; attempt += 1) {
  // Step 1
  phase("Plan");
  const plan = await agent(JSON.stringify({ action: "plan", exclude, notes }), {
    agentType: "library-contributor",
    schema: PLAN,
    phase: "Plan",
  });
  exclude = plan.exclude;
  if (plan.status === "not-eligible" || plan.status === "nothing" || plan.status === "unavailable")
    return { contributed: false, reason: plan.reason };
  if (plan.status === "no-library") {
    // Step 2
    const id = `clone:${plan.upstream}`;
    const decided = await review(id, {
      subject: "a checkout of the library's repository",
      request:
        "This project has no checkout of the library's repository, which a contribution needs. Fetch one from the address below?",
      materials: { upstream: plan.upstream, reason: plan.reason },
      approvable: true,
    });
    if (decided.decision === "ask") return waiting(id, decided);
    if (decided.decision !== "approve")
      return { contributed: false, reason: "the owner did not have a checkout fetched" };
    const cloned = await agent(JSON.stringify({ action: "clone" }), {
      agentType: "library-contributor",
      schema: CLONED,
      phase: "Plan",
    });
    if (cloned.failed) return { contributed: false, reason: cloned.reason };
    notes = "";
    continue;
  }
  // Step 3
  const id = `contribution:${plan.digest}`;
  const approvable = plan.library_defects.length === 0;
  const decided = await review(id, {
    subject: "a contribution to the shared library",
    request:
      "Approve sending exactly these loops and roles to the shared library as a pull request, or say what to leave out or change.",
    materials: {
      units: plan.units,
      not_selected: plan.not_selected,
      changes_file: plan.changes_file,
      previews: plan.previews,
      library_defects: plan.library_defects,
    },
    approvable,
  });
  if (decided.decision === "ask") return waiting(id, decided);
  if (decided.decision === "cancel") return { contributed: false, reason: "the owner cancelled" };
  if (decided.decision === "approve" && approvable) {
    // Step 4
    phase("Contribute");
    const sent = await agent(
      JSON.stringify({ action: "contribute", digest: plan.digest, exclude }),
      {
        agentType: "library-contributor",
        schema: SENT,
        phase: "Contribute",
      },
    );
    return { contributed: sent.status === "pushed", ...sent };
  }
  notes = decided.notes;
}
return { contributed: false, reason: "no plan was approved within 6 rounds" };

// contrejour-loop-definition-sha256: 3ad75bc2f9b3213694b8dd3c9adca4f3253ef9940987748179aaeb1e90c5ec6f
