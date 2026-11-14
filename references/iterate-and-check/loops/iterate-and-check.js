export const meta = {
  name: "iterate-and-check",
  description:
    "Work on the task in rounds: plan from the task and the planner's memory, build, check, record; the owner reviews the result",
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

let findings = [];
let last = null;
// The check of the round before, made again when the next plan cannot use its findings.
let recheckLast = null;
const ending = (sent) => ({
  done: false,
  reason: "a step could not use what it was given",
  ...last,
  sent_back: sent,
});
for (let reviews = 1; reviews <= 3; reviews += 1) {
  for (let round = 1; round <= maxRounds; round += 1) {
    // Step 1: the findings are the last check's within a review, the owner's after one.
    phase("Plan");
    const fromCheck = round > 1 && recheckLast;
    const plan = (back) =>
      agent(JSON.stringify({ action: "plan", round, findings, returned: back }), {
        agentType: "planner",
        schema: sending(PLAN, fromCheck ? ["checker:check", "caller"] : ["caller"]),
        phase: "Plan",
      });
    const planRedo = fromCheck ? { "checker:check": recheckLast } : {};
    let planned = await step("planner:plan", () => plan(null), planRedo);
    if (planned.sent_back) return ending(planned.sent_back);
    const replan = async (back) => {
      const again = await step("planner:plan", () => plan(back), planRedo);
      if (!again.sent_back) planned = again;
      return again;
    };
    // Step 2
    phase("Build");
    const build = (back) =>
      agent(JSON.stringify({ action: "build", plan: planned.plan, returned: back }), {
        agentType: "builder",
        schema: sending(BUILT, ["planner:plan"]),
        phase: "Build",
      });
    let built = await step("builder:build", () => build(null), { "planner:plan": replan });
    if (built.sent_back) return ending(built.sent_back);
    const rebuild = async (back) => {
      const again = await step("builder:build", () => build(back), { "planner:plan": replan });
      if (!again.sent_back) built = again;
      return again;
    };
    // Step 3
    phase("Check");
    const check = (back) =>
      agent(
        JSON.stringify({
          action: "check",
          plan: planned.plan,
          criteria: planned.criteria,
          built: built.built,
          files: built.files,
          returned: back,
        }),
        {
          agentType: "checker",
          schema: sending(CHECKED, ["planner:plan", "builder:build"]),
          phase: "Check",
        },
      );
    const checkRedo = {
      // A plan made again is built again before it is checked.
      "planner:plan": async (back) => {
        const again = await replan(back);
        if (again.sent_back) return again;
        return rebuild(null);
      },
      "builder:build": rebuild,
    };
    let checked = await step("checker:check", () => check(null), checkRedo);
    if (checked.sent_back) return ending(checked.sent_back);
    const recheck = async (back) => {
      const again = await step("checker:check", () => check(back), checkRedo);
      if (!again.sent_back) {
        checked = again;
        findings = again.findings;
      }
      return again;
    };
    // Step 4
    phase("Record");
    const recorded = await step(
      "project-memory:record",
      () =>
        agent(
          JSON.stringify({
            action: "record",
            what: planned.plan,
            outcome: checked.passed ? "worked" : "failed",
            evidence: checked.findings,
            role: "planner",
          }),
          {
            agentType: "project-memory",
            schema: sending(RECORDED, ["checker:check"]),
            phase: "Record",
          },
        ),
      { "checker:check": recheck },
    );
    if (recorded.sent_back) return ending(recorded.sent_back);
    last = {
      round,
      plan: planned.plan,
      built: built.built,
      passed: checked.passed,
      findings: checked.findings,
      digest: checked.digest,
    };
    findings = checked.findings;
    recheckLast = recheck;
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

// contrejour-loop-definition-sha256: cd0645b5b5d692ed0562feb7a4b008a1dd9a7cd343b82a6fdf7ea284147e19f7
