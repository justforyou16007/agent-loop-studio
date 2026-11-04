export const meta = {
  name: "iterate-and-check",
  description:
    "Work on the task in rounds: plan from the task and the memory, build, check, record; the owner reviews the result",
  whenToUse:
    "The project's task loop. Run it with {params}, then again with the owner's replies in answers.",
  phases: [
    { title: "Plan" },
    { title: "Build" },
    { title: "Check" },
    { title: "Record" },
    { title: "Review" },
  ],
};

const STRINGS = { type: "array", items: { type: "string" } };
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
const PLAN = {
  type: "object",
  properties: { plan: { type: "string" }, criteria: STRINGS },
  required: ["plan", "criteria"],
};
const BUILT = {
  type: "object",
  properties: { built: { type: "string" }, files: STRINGS, failed: { type: "boolean" } },
  required: ["built", "files", "failed"],
};
const CHECKED = {
  type: "object",
  properties: { passed: { type: "boolean" }, findings: STRINGS, digest: { type: "string" } },
  required: ["passed", "findings", "digest"],
};
const RECORDED = {
  type: "object",
  properties: {
    recorded: { type: "boolean" },
    file: { type: "string" },
    summary: { type: "string" },
  },
  required: ["recorded", "file", "summary"],
};

const input = args || {};
const answers = input.answers || {};
const params = input.params || {};
const maxRounds = Number.isInteger(params.max_rounds) ? params.max_rounds : 3;

let findings = [];
let last = null;
for (let reviews = 1; reviews <= 3; reviews += 1) {
  for (let round = 1; round <= maxRounds; round += 1) {
    // Step 1
    phase("Plan");
    const planned = await agent(JSON.stringify({ action: "plan", round, findings }), {
      agentType: "planner",
      schema: PLAN,
      phase: "Plan",
    });
    // Step 2
    phase("Build");
    const built = await agent(JSON.stringify({ action: "build", plan: planned.plan }), {
      agentType: "builder",
      schema: BUILT,
      phase: "Build",
    });
    // Step 3
    phase("Check");
    const checked = await agent(
      JSON.stringify({
        action: "check",
        plan: planned.plan,
        criteria: planned.criteria,
        built: built.built,
        files: built.files,
      }),
      { agentType: "checker", schema: CHECKED, phase: "Check" },
    );
    // Step 4
    phase("Record");
    await agent(
      JSON.stringify({
        action: "record",
        what: planned.plan,
        outcome: checked.passed ? "worked" : "failed",
        evidence: checked.findings,
      }),
      { agentType: "project-memory", schema: RECORDED, phase: "Record" },
    );
    last = {
      round,
      plan: planned.plan,
      built: built.built,
      passed: checked.passed,
      findings: checked.findings,
      digest: checked.digest,
    };
    findings = checked.findings;
    if (checked.passed) break;
  }
  // Step 5
  phase("Review");
  // The review names the version it is of, so a later run never takes an answer meant for this one.
  const id = `result:${last.digest}`;
  const decided = await agent(
    JSON.stringify({
      review_id: id,
      subject: "the result of this run",
      request: "Approve this result, say what to change, or cancel.",
      materials: last,
      approvable: true,
      answer: answers[id] ?? null,
    }),
    { agentType: "owner-review", schema: REVIEW, phase: "Review" },
  );
  if (decided.decision === "ask")
    return {
      waiting: "owner",
      review_id: id,
      question: decided.question,
      document: decided.document,
    };
  if (decided.decision === "approve") return { done: true, ...last };
  if (decided.decision === "cancel") return { done: false, reason: "the owner cancelled", ...last };
  findings = [decided.notes];
}
return { done: false, reason: "no result was approved within 3 reviews", ...last };

// contrejour-loop-definition-sha256: f92f571eb35821f611c1115934ebb66b1f4fbd4905221e104fe476a1dae373a3
