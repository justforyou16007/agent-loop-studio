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

// Step 1: what the owner wants the project's work to be.
phase("Goal");
let goalNotes = "";
let read = null;
for (let round = 1; round <= 3; round += 1) {
  read = await agent(JSON.stringify({ action: "goal", goal: input.goal ?? "", notes: goalNotes }), {
    agentType: "project-setup",
    schema: GOAL,
    phase: "Goal",
  });
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
const goal = read.goal;

// Step 2
phase("Task loop");
let notes = "";
let chosen = null;
let built = 0;
for (let round = 1; round <= 6 && !chosen; round += 1) {
  const found = await agent(JSON.stringify({ action: "find-task-loop", goal, notes }), {
    agentType: "loop-query",
    schema: FOUND,
    phase: "Task loop",
  });
  const proposal = await agent(
    JSON.stringify({ action: "propose", goal, candidates: found.candidates, notes }),
    { agentType: "project-setup", schema: PROPOSAL, phase: "Task loop" },
  );
  if (proposal.build) {
    if (built >= 2)
      return { done: false, reason: "no task loop was settled after two were built or changed" };
    built += 1;
    const authored = await workflow("loop-authoring", {
      description: proposal.description,
      kind: "task",
      answers,
    });
    if (authored && authored.waiting) return authored;
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
    { agentType: "project-setup", schema: USED, phase: "Task loop" },
  );
  if (used.failed) notes = `Making ${proposal.loop} the task loop failed: ${used.reason}`;
  else chosen = used;
}
if (!chosen) return { done: false, reason: "no task loop was chosen within 6 rounds" };

// Step 3
phase("Check");
let checked = await agent(JSON.stringify({ action: "check" }), {
  agentType: "project-setup",
  schema: CHECKED,
  phase: "Check",
});
if (checked.stale.length) {
  if (checked.stale.length > 4) log(`${checked.stale.length - 4} stale loops were not regenerated`);
  for (const stale of checked.stale.slice(0, 4))
    await workflow("loop-authoring", { regenerate: stale });
  checked = await agent(JSON.stringify({ action: "check" }), {
    agentType: "project-setup",
    schema: CHECKED,
    phase: "Check",
  });
}

// Step 4
phase("Hand off");
const handoff = await agent(
  JSON.stringify({
    action: "handoff",
    goal,
    loop: chosen.loop,
    params: chosen.params,
    check: checked,
  }),
  { agentType: "project-setup", schema: HANDOFF, phase: "Hand off" },
);
return { done: true, loop: chosen.loop, report: handoff.report };

// contrejour-loop-definition-sha256: 220e507a2bfd109ef5060f9f0312b76af7ac53b328cb5afb8d4fd4792e155a0b
