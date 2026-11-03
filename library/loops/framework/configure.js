export const meta = {
  name: "configure",
  description:
    "What is particular to this project, as setup's first step: what it is for and its task.md",
  whenToUse:
    'As the first step of setup, or when the owner asks to configure the project again. Run it with {"requirement": "<the owner\'s words, or start>"}, then again with the owner\'s replies in answers.',
  phases: [{ title: "Requirement" }, { title: "Task" }],
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
const REQUIREMENT = {
  type: "object",
  properties: {
    needs_owner: { type: "boolean" },
    requirement: { type: "string" },
    request: { type: "string" },
  },
  required: ["needs_owner", "requirement", "request"],
};
const TASK = {
  type: "object",
  properties: {
    needs_owner: { type: "boolean" },
    task_file: { type: "string" },
    digest: { type: "string" },
    summary: { type: "string" },
  },
  required: ["needs_owner", "task_file", "digest", "summary"],
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
const stopped = { done: false, reason: "the owner stopped the configuration" };

// Step 1
phase("Requirement");
let notes = "";
let read = null;
for (let round = 1; round <= 3; round += 1) {
  read = await agent(
    JSON.stringify({ action: "requirement", requirement: input.requirement ?? "", notes }),
    { agentType: "project-setup", schema: REQUIREMENT, phase: "Requirement" },
  );
  if (!read.needs_owner) break;
  const id = `requirement:${round}`;
  const decided = await review(
    id,
    {
      subject: "what this project is for",
      request: read.request,
      materials: { requirement: input.requirement ?? "", earlier_answers: notes },
      approvable: false,
    },
    "Requirement",
  );
  if (decided.decision === "ask") return waiting(id, decided);
  if (decided.decision === "cancel") return stopped;
  notes = [notes, decided.notes].filter(Boolean).join("\n");
}
if (read.needs_owner)
  return {
    done: false,
    reason: "what the project is for is still not clear enough to write the task",
  };
const requirement = read.requirement;

// Step 2: a task.md the owner wrote needs no review.
phase("Task");
let taskNotes = "";
let task = null;
let settled = false;
for (let round = 1; round <= 6 && !settled; round += 1) {
  task = await agent(JSON.stringify({ action: "task", requirement, notes: taskNotes }), {
    agentType: "project-setup",
    schema: TASK,
    phase: "Task",
  });
  if (!task.needs_owner) {
    settled = true;
    break;
  }
  const id = `task:${task.digest}`;
  const decided = await review(
    id,
    {
      subject: "task.md, the task this project works on",
      request: "Approve this task.md, or say what to change.",
      materials: { task_file: task.task_file, summary: task.summary },
      approvable: true,
    },
    "Task",
  );
  if (decided.decision === "ask") return waiting(id, decided);
  if (decided.decision === "cancel") return stopped;
  if (decided.decision === "approve") settled = true;
  else taskNotes = decided.notes;
}
if (!settled) return { done: false, reason: "task.md was not approved within 6 rounds" };
return { done: true, requirement, report: `task.md: ${task.summary}` };

// contrejour-loop-definition-sha256: 22e851523a10344e42d70fe2f11321d7c6a5c5ef25126c6d5841ea956b9dac8b
