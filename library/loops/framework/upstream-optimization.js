export const meta = {
  name: "upstream-optimization",
  description:
    "Send this project's improvements to loops and roles a library gave it back to that library: a plan, the project's own check when it has one, the owner's review of exactly that plan, then one pull request per library",
  whenToUse:
    "When the owner asks, once a task has finished. Run with {}, then again with the owner's replies in answers.",
  phases: [{ title: "Plan" }, { title: "Own check" }, { title: "Review" }, { title: "Send" }],
};

const PURPOSE = "upstream";
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
          library: { type: "string" },
          state: { type: "string" },
          description: { type: "string" },
          judgement: { type: "string" },
          warnings: STRINGS,
        },
        required: [
          "kind",
          "name",
          "side",
          "library",
          "state",
          "description",
          "judgement",
          "warnings",
        ],
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
    check: { type: "string", enum: ["not-needed", "required", "passed", "failed"] },
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
const SENT = {
  type: "object",
  properties: {
    status: { type: "string" },
    reason: { type: "string" },
    pull_requests: {
      type: "array",
      items: {
        type: "object",
        properties: {
          library: { type: "string" },
          status: { type: "string" },
          pull_request: { type: "string" },
          compare_url: { type: "string" },
          branch: { type: "string" },
          base: { type: "string" },
          files: STRINGS,
          reason: { type: "string" },
        },
        required: [
          "library",
          "status",
          "pull_request",
          "compare_url",
          "branch",
          "base",
          "files",
          "reason",
        ],
      },
    },
  },
  required: ["status", "reason", "pull_requests"],
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
  const plan = await agent(JSON.stringify({ action: "plan", purpose: PURPOSE, exclude, notes }), {
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
      subject: "a checkout of the repository this project came from",
      request:
        "This project has no checkout of the repository it was installed from, which sending improvements back needs. Fetch one from the address below?",
      materials: { upstream: plan.upstream, reason: plan.reason },
      approvable: true,
    });
    if (decided.decision === "ask") return waiting(id, decided);
    if (decided.decision !== "approve")
      return { contributed: false, reason: "the owner did not have a checkout fetched" };
    const cloned = await agent(JSON.stringify({ action: "clone", purpose: PURPOSE }), {
      agentType: "library-contributor",
      schema: CLONED,
      phase: "Plan",
    });
    if (cloned.failed) return { contributed: false, reason: cloned.reason };
    notes = "";
    continue;
  }
  // Step 3: the project's own check, when its rules ask for one, on exactly these files.
  let own = { verdict: "not-needed", findings: [] };
  if (plan.check === "required" || plan.check === "failed") {
    phase("Own check");
    const checked = await workflow("contribution-check", {
      digest: plan.digest,
      files: plan.previews,
      answers,
    });
    if (checked && checked.waiting) return checked;
    own = checked || { verdict: "fail", findings: ["the check did not finish"] };
  } else if (plan.check === "passed") own = { verdict: "pass", findings: [] };
  // Step 4
  phase("Review");
  const id = `upstream:${plan.digest}`;
  const approvable =
    plan.library_defects.length === 0 && (own.verdict === "pass" || own.verdict === "not-needed");
  const decided = await review(id, {
    subject: "improvements going back to the libraries they came from",
    request:
      "Approve sending exactly these improvements back to the libraries named for each, one pull request per library, or say what to leave out or change.",
    materials: {
      units: plan.units,
      not_selected: plan.not_selected,
      changes_file: plan.changes_file,
      previews: plan.previews,
      library_defects: plan.library_defects,
      own_check: own,
    },
    approvable,
  });
  if (decided.decision === "ask") return waiting(id, decided);
  if (decided.decision === "cancel") return { contributed: false, reason: "the owner cancelled" };
  if (decided.decision === "approve" && approvable) {
    // Step 5
    phase("Send");
    const sent = await agent(
      JSON.stringify({ action: "contribute", purpose: PURPOSE, digest: plan.digest, exclude }),
      {
        agentType: "library-contributor",
        schema: SENT,
        phase: "Send",
      },
    );
    return { contributed: sent.status === "pushed", ...sent };
  }
  notes = decided.notes;
}
return { contributed: false, reason: "no plan was approved within 6 rounds" };

// contrejour-loop-definition-sha256: 96b719a41dd8cd05c25b84895cf50eef8c00df333de146caf5c48b1d3dd620a3
