export const meta = {
  name: "setup",
  description:
    "Set up this project's workflow: the owner's goal, the task loop with its parameter values, a check of the loops, the hand-off",
  whenToUse:
    'When the project is not set up yet, or the owner wants its workflow set up again. Run it with {"goal": "<the owner\'s words, or start>"}, then again with the owner\'s replies in answers.',
  phases: [{ title: "Goal" }, { title: "Task loop" }, { title: "Check" }, { title: "Hand off" }],
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
const GOAL = {
  type: "object",
  properties: {
    needs_owner: { type: "boolean" },
    goal: { type: "string" },
    request: { type: "string" },
  },
  required: ["needs_owner", "goal", "request"],
};
const FOUND = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          loop: { type: "string" },
          source: { type: "string" },
          current: { type: "boolean" },
          why: { type: "string" },
        },
        required: ["loop", "source", "current", "why"],
      },
    },
  },
  required: ["candidates"],
};
const PROPOSAL = {
  type: "object",
  properties: {
    build: { type: "boolean" },
    description: { type: "string" },
    loop: { type: "string" },
    params: { type: "object" },
    summary: { type: "string" },
  },
  required: ["build", "description", "loop", "params", "summary"],
};
const USED = {
  type: "object",
  properties: {
    failed: { type: "boolean" },
    reason: { type: "string" },
    loop: { type: "string" },
    params: { type: "object" },
  },
  required: ["failed", "reason", "loop", "params"],
};
const CHECKED = {
  type: "object",
  properties: { stale: STRINGS, defects: STRINGS },
  required: ["stale", "defects"],
};
const HANDOFF = {
  type: "object",
  properties: { report: { type: "string" } },
  required: ["report"],
};

const input = args || {};
const answers = input.answers || {};
// The owner decides at owner-review steps; the loop stops there until the session brings the reply.
const review = (id, request, at) =>
  agent(JSON.stringify({ review_id: id, ...request, answer: answers[id] ?? null }), {
    agentType: "owner-review",
    schema: REVIEW,
    phase: at,
  });
const waiting = (id, decided) => ({
  waiting: "owner",
  review_id: id,
  question: decided.question,
  document: decided.document,
});
const stopped = { done: false, reason: "the owner stopped the setup" };
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

// Step 1: what the owner wants the project's work to be.
phase("Goal");
const readGoal = (notes, returned) =>
  agent(JSON.stringify({ action: "goal", goal: input.goal ?? "", notes, returned }), {
    agentType: "project-setup",
    schema: sending(GOAL, ["caller"]),
    phase: "Goal",
  });
let goalNotes = "";
let read = null;
for (let round = 1; round <= 3; round += 1) {
  read = await step("project-setup:goal", () => readGoal(goalNotes, null));
  if (read.sent_back) return { done: false, sent_back: read.sent_back };
  if (!read.needs_owner) break;
  const id = `goal:${round}`;
  const decided = await review(
    id,
    {
      subject: "what this project's workflow should do",
      request: read.request,
      materials: { goal: input.goal ?? "", earlier_answers: goalNotes },
      approvable: false,
    },
    "Goal",
  );
  if (decided.decision === "ask") return waiting(id, decided);
  if (decided.decision === "cancel") return stopped;
  goalNotes = [goalNotes, decided.notes].filter(Boolean).join("\n");
}
if (read.needs_owner)
  return {
    done: false,
    reason: "what the workflow should do is still not clear enough to choose one",
  };
let goal = read.goal;
// A later step that cannot use the goal has it restated; when only the owner can say more, the setup
// ends with what was sent back.
const regoal = async (back) => {
  const again = await step("project-setup:goal", () => readGoal(goalNotes, back));
  if (again.sent_back) return again;
  if (again.needs_owner)
    return { sent_back: { by: back.by, to: "caller", problems: back.problems } };
  goal = again.goal;
  return again;
};

// Step 2
phase("Task loop");
let notes = "";
let chosen = null;
let built = 0;
// What Use sent back: the next proposal redoes it, and goes to the owner again.
let returned = null;
let useReturns = 0;
for (let round = 1; round <= 6 && !chosen; round += 1) {
  const findLoops = (back) =>
    agent(JSON.stringify({ action: "find-task-loop", goal, notes, returned: back }), {
      agentType: "loop-query",
      schema: sending(FOUND, ["project-setup:goal", "caller"]),
      phase: "Task loop",
    });
  let found = await step("loop-query:find-task-loop", () => findLoops(null), {
    "project-setup:goal": regoal,
  });
  if (found.sent_back) return { done: false, sent_back: found.sent_back };
  const propose = (back) =>
    agent(
      JSON.stringify({
        action: "propose",
        goal,
        candidates: found.candidates,
        notes,
        returned: back,
      }),
      {
        agentType: "project-setup",
        schema: sending(PROPOSAL, ["loop-query:find-task-loop", "project-setup:goal"]),
        phase: "Task loop",
      },
    );
  const remake = {
    "loop-query:find-task-loop": async (back) => {
      const again = await step("loop-query:find-task-loop", () => findLoops(back), {
        "project-setup:goal": regoal,
      });
      if (!again.sent_back) found = again;
      return again;
    },
    "project-setup:goal": regoal,
  };
  let proposal = await step("project-setup:propose", () => propose(returned), remake);
  if (proposal.sent_back) return { done: false, sent_back: proposal.sent_back };
  returned = null;
  if (proposal.build) {
    if (built >= 2)
      return { done: false, reason: "no task loop was settled after two were built or changed" };
    built += 1;
    // A description loop-authoring cannot use is proposed again, and the loop built from the new one.
    const authored = await child(
      "loop-authoring",
      () =>
        workflow("loop-authoring", {
          description: proposal.description,
          kind: "task",
          answers,
        }),
      async (back) => {
        const again = await step("project-setup:propose", () => propose(back), remake);
        if (!again.sent_back) proposal = again;
        return again;
      },
    );
    if (authored && authored.waiting) return authored;
    if (authored && authored.sent_back) return { done: false, sent_back: authored.sent_back };
    notes = [
      notes,
      authored && authored.loop ? `The owner had ${authored.loop} built for this.` : "",
    ]
      .filter(Boolean)
      .join("\n");
    continue;
  }
  const id = `task-loop:${round}:${proposal.loop}`;
  const decided = await review(
    id,
    {
      subject: "the loop this project runs, and its parameter values",
      request:
        "Make this the project's task loop with these values, or say which loop or values you want instead.",
      materials: { proposal, candidates: found.candidates },
      approvable: true,
    },
    "Task loop",
  );
  if (decided.decision === "ask") return waiting(id, decided);
  if (decided.decision === "cancel") return stopped;
  if (decided.decision !== "approve") {
    notes = decided.notes;
    continue;
  }
  const used = await agent(
    JSON.stringify({ action: "use", loop: proposal.loop, params: proposal.params }),
    {
      agentType: "project-setup",
      schema: sending(USED, ["project-setup:propose"]),
      phase: "Task loop",
    },
  );
  // A proposal Use cannot use is proposed again, then put to the owner again: the owner approves the
  // task loop and its values.
  if (used.send_back.needed) {
    if (useReturns >= SEND_BACKS)
      return {
        done: false,
        sent_back: {
          by: "project-setup:use",
          to: "project-setup:propose",
          problems: used.send_back.problems,
        },
      };
    useReturns += 1;
    returned = { by: "project-setup:use", problems: used.send_back.problems };
    continue;
  }
  if (used.failed) notes = `Making ${proposal.loop} the task loop failed: ${used.reason}`;
  else chosen = used;
}
if (!chosen) return { done: false, reason: "no task loop was chosen within 6 rounds" };

// Step 3
phase("Check");
const check = (back) =>
  agent(JSON.stringify({ action: "check", returned: back }), {
    agentType: "project-setup",
    schema: sending(CHECKED, ["caller"]),
    phase: "Check",
  });
const recheck = async (back) => {
  const again = await step("project-setup:check", () => check(back));
  if (!again.sent_back) checked = again;
  return again;
};
let checked = await step("project-setup:check", () => check(null));
if (checked.sent_back) return { done: false, sent_back: checked.sent_back };
if (checked.stale.length) {
  if (checked.stale.length > 4) log(`${checked.stale.length - 4} stale loops were not regenerated`);
  for (const stale of checked.stale.slice(0, 4)) {
    // A stale loop loop-authoring cannot regenerate as named is checked again, and regenerated again.
    const regenerated = await child(
      "loop-authoring",
      () => workflow("loop-authoring", { regenerate: stale }),
      recheck,
    );
    if (regenerated && regenerated.sent_back)
      log(`${stale} was not regenerated: ${regenerated.sent_back.problems.join("; ")}`);
  }
  checked = await step("project-setup:check", () => check(null));
  if (checked.sent_back) return { done: false, sent_back: checked.sent_back };
}

// Step 4
phase("Hand off");
const handoff = await step(
  "project-setup:handoff",
  () =>
    agent(
      JSON.stringify({
        action: "handoff",
        goal,
        loop: chosen.loop,
        params: chosen.params,
        check: checked,
      }),
      {
        agentType: "project-setup",
        schema: sending(HANDOFF, [
          "project-setup:goal",
          "project-setup:use",
          "project-setup:check",
        ]),
        phase: "Hand off",
      },
    ),
  {
    "project-setup:goal": regoal,
    "project-setup:use": async (back) => {
      const again = await step("project-setup:use", () =>
        agent(
          JSON.stringify({
            action: "use",
            loop: chosen.loop,
            params: chosen.params,
            returned: back,
          }),
          {
            agentType: "project-setup",
            schema: sending(USED, ["project-setup:propose"]),
            phase: "Hand off",
          },
        ),
      );
      if (!again.sent_back && !again.failed) chosen = again;
      return again;
    },
    "project-setup:check": recheck,
  },
);
if (handoff.sent_back) return { done: false, sent_back: handoff.sent_back };
return { done: true, loop: chosen.loop, report: handoff.report };

// contrejour-loop-definition-sha256: e81a82c2741dda73729b490f19cf8dd16ba32b7f252a28b3d650e2d0088584f6
