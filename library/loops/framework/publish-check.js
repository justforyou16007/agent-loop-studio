export const meta = {
  name: "publish-check",
  description:
    "The project's own check of exactly what would leave, when its rules ask for one: here, the owner reads the files",
  whenToUse:
    "As a step of publish, when the plan says the project's own check is required. Run it with the plan's digest and files, then again with the owner's replies in answers.",
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
const recorded = await step("project-publisher:record-check", () =>
  agent(JSON.stringify({ action: "record-check", digest: input.digest, verdict, findings }), {
    agentType: "project-publisher",
    schema: sending(RECORDED, ["caller"]),
    phase: "Record",
  }),
);
// The digest and the files are the caller's: what Record cannot use goes back to it.
if (recorded.sent_back)
  return { verdict: "fail", findings: recorded.sent_back.problems, sent_back: recorded.sent_back };
if (recorded.failed) return { verdict: "fail", findings: [recorded.reason] };
return { verdict, findings };

// contrejour-loop-definition-sha256: 7e1046986f2d051af502bcb775d010fddc0a4f527feba5b4fdf3b13c459b203b
