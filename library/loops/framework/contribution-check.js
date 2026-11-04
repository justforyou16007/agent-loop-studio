export const meta = {
  name: "contribution-check",
  description:
    "The project's own check of exactly what would leave, when its rules ask for one: here, the owner reads the files",
  whenToUse:
    "As a step of library-contribution, when the plan says the project's own check is required. Run it with the plan's digest and files, then again with the owner's replies in answers.",
  phases: [{ title: "Check" }, { title: "Record" }],
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
const RECORDED = {
  type: "object",
  properties: { failed: { type: "boolean" }, reason: { type: "string" } },
  required: ["failed", "reason"],
};

const input = args || {};
const answers = input.answers || {};

// Step 1
phase("Check");
const id = `check:${input.digest}`;
const decided = await agent(
  JSON.stringify({
    review_id: id,
    subject: "exactly the files that would leave this project",
    request:
      "This project checks what leaves before it does. Read these files for anything its rules say must stay here, and approve them, or say what must not leave.",
    materials: { files: input.files || [] },
    approvable: true,
    answer: answers[id] ?? null,
  }),
  { agentType: "owner-review", schema: REVIEW, phase: "Check" },
);
if (decided.decision === "ask")
  return {
    waiting: "owner",
    review_id: id,
    question: decided.question,
    document: decided.document,
  };
const verdict = decided.decision === "approve" ? "pass" : "fail";
const findings =
  verdict === "pass" ? [] : [decided.notes || "the owner did not let these files leave"];

// Step 2
phase("Record");
const recorded = await agent(
  JSON.stringify({ action: "record-check", digest: input.digest, verdict, findings }),
  { agentType: "library-contributor", schema: RECORDED, phase: "Record" },
);
if (recorded.failed) return { verdict: "fail", findings: [recorded.reason] };
return { verdict, findings };

// contrejour-loop-definition-sha256: 2b47f59bacb7e7dedc9862fd1c252be3d7a0500cf993ba0d96814388a55d3e2f
