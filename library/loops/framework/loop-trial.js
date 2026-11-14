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

const check = (back) =>
  agent(JSON.stringify({ action: "check", loop, returned: back }), {
    agentType: "loop-tester",
    schema: sending(CHECKED, ["caller"]),
    phase: "Static check",
  });

for (let round = 1; round <= 4; round += 1) {
  // Step 1
  phase("Static check");
  let checked = await step("loop-tester:check", () => check(null));
  if (checked.sent_back) return { fit: false, loop, sent_back: checked.sent_back };
  if (checked.stale) {
    // A loop loop-authoring cannot regenerate as named is checked again, and regenerated again.
    const regenerated = await child(
      "loop-authoring",
      () => workflow("loop-authoring", { regenerate: loop }),
      async (back) => {
        const again = await step("loop-tester:check", () => check(back));
        if (!again.sent_back) checked = again;
        return again;
      },
    );
    if (regenerated && regenerated.waiting) return regenerated;
    if (regenerated && regenerated.sent_back)
      return { fit: false, loop, sent_back: regenerated.sent_back };
    checked = await step("loop-tester:check", () => check(null));
    if (checked.sent_back) return { fit: false, loop, sent_back: checked.sent_back };
  }
  if (checked.stale || checked.defects.length)
    return { fit: false, loop, reason: "the static check still fails", defects: checked.defects };

  // Step 2: the loop itself, for real, with its trial arguments.
  phase("Trial run");
  const prepare = (back) =>
    agent(JSON.stringify({ action: "prepare", loop, goal, round, returned: back }), {
      agentType: "loop-tester",
      schema: sending(PREPARED, ["caller"]),
      phase: "Trial run",
    });
  let prepared = await step("loop-tester:prepare", () => prepare(null));
  if (prepared.sent_back) return { fit: false, loop, sent_back: prepared.sent_back };
  if (!prepared.runnable) return { fit: false, loop, reason: prepared.why };
  const reprepare = async (back) => {
    const again = await step("loop-tester:prepare", () => prepare(back));
    if (!again.sent_back) prepared = again;
    return again;
  };
  // Arguments the loop sends back are prepared again, and the loop runs again on them; a result
  // Assess sends back to the loop is made again by running it again, with `returned`.
  const trial = (back) =>
    child(
      loop,
      () => workflow(loop, { ...prepared.args, answers, ...(back ? { returned: back } : {}) }),
      reprepare,
    );
  let result = await trial(null);
  if (result && result.waiting) return result;
  if (result && result.sent_back) return { fit: false, loop, sent_back: result.sent_back };

  // Step 3
  phase("Assess");
  const assess = (back) =>
    agent(
      JSON.stringify({
        action: "assess",
        loop,
        goal,
        round,
        since: prepared.since,
        result,
        returned: back,
      }),
      {
        agentType: "loop-tester",
        schema: sending(ASSESSED, ["loop-tester:prepare", loop]),
        phase: "Assess",
      },
    );
  const rerun = async (back) => {
    const again = await trial(back);
    if (again && (again.waiting || again.sent_back)) return again;
    result = again;
    return again;
  };
  const remakeTrial = {
    "loop-tester:prepare": async (back) => {
      const again = await reprepare(back);
      if (again.sent_back) return again;
      return rerun(null);
    },
    [loop]: rerun,
  };
  let assessed = await step("loop-tester:assess", () => assess(null), remakeTrial);
  if (assessed.waiting) return assessed;
  if (assessed.sent_back) return { fit: false, loop, sent_back: assessed.sent_back };
  const reassess = async (back) => {
    const again = await step("loop-tester:assess", () => assess(back), remakeTrial);
    if (!again.sent_back && !again.waiting) assessed = again;
    return again;
  };

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
  const planFix = (back) =>
    agent(
      JSON.stringify({
        action: "plan-fix",
        loop,
        report_file: assessed.report_file,
        notes: decided.notes,
        returned: back,
      }),
      {
        agentType: "loop-tester",
        schema: sending(FIX, ["loop-tester:assess"]),
        phase: "Improve",
      },
    );
  let fix = await step("loop-tester:plan-fix", () => planFix(null), {
    "loop-tester:assess": reassess,
  });
  if (fix.waiting) return fix;
  if (fix.sent_back) return { fit: false, loop, sent_back: fix.sent_back };
  if (fix.loop_change) {
    // A change loop-authoring cannot use as described is planned again, and made from the new plan.
    const authored = await child(
      "loop-authoring",
      () => workflow("loop-authoring", { description: fix.loop_change, answers }),
      async (back) => {
        const again = await step("loop-tester:plan-fix", () => planFix(back), {
          "loop-tester:assess": reassess,
        });
        if (!again.sent_back && !again.waiting) fix = again;
        return again;
      },
    );
    if (authored && authored.waiting) return authored;
    if (authored && authored.sent_back) return { fit: false, loop, sent_back: authored.sent_back };
  }
  if (fix.role_fixes) {
    const optimized = await step(
      "project-memory:trial",
      () =>
        agent(
          JSON.stringify({
            action: "trial",
            loop,
            since: prepared.since,
            report_file: assessed.report_file,
            notes: decided.notes,
          }),
          {
            agentType: "project-memory",
            schema: sending(OPTIMIZED, ["loop-tester:assess"]),
            phase: "Improve",
          },
        ),
      { "loop-tester:assess": reassess },
    );
    if (optimized.waiting) return optimized;
    if (optimized.sent_back) return { fit: false, loop, sent_back: optimized.sent_back };
  }
}
return { fit: false, loop, reason: "the owner did not judge it fit within 4 trial rounds" };

// contrejour-loop-definition-sha256: f902143cf86a5a1d6957627be559bc9abf71aa0aaf1495c3530ac05636bee087
