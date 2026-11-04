export const meta = {
  name: "loop-trial",
  description:
    "Check a loop the way it will run: static check, a trial run for real, the owner's judgement against their goal, improve, try again",
  whenToUse:
    'When the owner wants to try a loop before its real work, or after changing it. Run it with {"loop": "<loop>", "goal": "<what it should achieve, in their words>"}, then again with the owner\'s replies in answers.',
  phases: [
    { title: "Static check" },
    { title: "Trial run" },
    { title: "Assess" },
    { title: "Goal review" },
    { title: "Improve" },
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
const CHECKED = {
  type: "object",
  properties: { stale: { type: "boolean" }, defects: STRINGS },
  required: ["stale", "defects"],
};
const PREPARED = {
  type: "object",
  properties: {
    runnable: { type: "boolean" },
    args: { type: "object" },
    since: { type: "string" },
    why: { type: "string" },
  },
  required: ["runnable", "args", "since", "why"],
};
const ASSESSED = {
  type: "object",
  properties: {
    report_file: { type: "string" },
    serves_goal: { type: "boolean" },
    summary: { type: "string" },
    divergences: STRINGS,
  },
  required: ["report_file", "serves_goal", "summary", "divergences"],
};
const FIX = {
  type: "object",
  properties: { loop_change: { type: "string" }, role_fixes: { type: "boolean" } },
  required: ["loop_change", "role_fixes"],
};
const OPTIMIZED = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
};

const input = args || {};
const answers = input.answers || {};
const loop = input.loop;
const goal = input.goal || "";

for (let round = 1; round <= 4; round += 1) {
  // Step 1
  phase("Static check");
  let checked = await agent(JSON.stringify({ action: "check", loop }), {
    agentType: "loop-tester",
    schema: CHECKED,
    phase: "Static check",
  });
  if (checked.stale) {
    const regenerated = await workflow("loop-authoring", { regenerate: loop });
    if (regenerated && regenerated.waiting) return regenerated;
    checked = await agent(JSON.stringify({ action: "check", loop }), {
      agentType: "loop-tester",
      schema: CHECKED,
      phase: "Static check",
    });
  }
  if (checked.stale || checked.defects.length)
    return { fit: false, loop, reason: "the static check still fails", defects: checked.defects };

  // Step 2: the loop itself, for real, with its trial arguments.
  phase("Trial run");
  const prepared = await agent(JSON.stringify({ action: "prepare", loop, goal, round }), {
    agentType: "loop-tester",
    schema: PREPARED,
    phase: "Trial run",
  });
  if (!prepared.runnable) return { fit: false, loop, reason: prepared.why };
  const result = await workflow(loop, { ...prepared.args, answers });
  if (result && result.waiting) return result;

  // Step 3
  phase("Assess");
  const assessed = await agent(
    JSON.stringify({ action: "assess", loop, goal, round, since: prepared.since, result }),
    { agentType: "loop-tester", schema: ASSESSED, phase: "Assess" },
  );

  // Step 4
  phase("Goal review");
  const id = `trial:${loop}:${round}`;
  const decided = await agent(
    JSON.stringify({
      review_id: id,
      subject: `what a trial run of ${loop} did, against your goal`,
      request:
        "Does what the loop did serve your goal? Approve it as fit, or say what should be different.",
      materials: {
        goal,
        report_file: assessed.report_file,
        summary: assessed.summary,
        divergences: assessed.divergences,
        serves_goal: assessed.serves_goal,
      },
      approvable: true,
      answer: answers[id] ?? null,
    }),
    { agentType: "owner-review", schema: REVIEW, phase: "Goal review" },
  );
  if (decided.decision === "ask")
    return {
      waiting: "owner",
      review_id: id,
      question: decided.question,
      document: decided.document,
    };
  if (decided.decision === "approve")
    return { fit: true, loop, rounds: round, report: assessed.summary };
  if (decided.decision === "cancel")
    return { fit: false, loop, reason: "the owner stopped the trial" };

  // Step 5
  phase("Improve");
  const fix = await agent(
    JSON.stringify({
      action: "plan-fix",
      loop,
      report_file: assessed.report_file,
      notes: decided.notes,
    }),
    { agentType: "loop-tester", schema: FIX, phase: "Improve" },
  );
  if (fix.loop_change) {
    const authored = await workflow("loop-authoring", { description: fix.loop_change, answers });
    if (authored && authored.waiting) return authored;
  }
  if (fix.role_fixes)
    await agent(
      JSON.stringify({
        action: "trial",
        loop,
        since: prepared.since,
        report_file: assessed.report_file,
        notes: decided.notes,
      }),
      { agentType: "trajectory-optimizer", schema: OPTIMIZED, phase: "Improve" },
    );
}
return { fit: false, loop, reason: "the owner did not judge it fit within 4 trial rounds" };

// contrejour-loop-definition-sha256: 6e40a59f30b1b7e1836cbff8da29cd6884ab8c6c173a0c9936c4e1f1932bab25
