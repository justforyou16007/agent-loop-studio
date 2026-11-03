export const meta = {
  name: "role-authoring",
  description:
    "Create or change a role from the owner's description: find the roles that do the work, draft on the closest, check, install once the owner approves",
  whenToUse:
    'Run with {"description": "<the owner\'s words>"}, then again with the owner\'s replies in answers.',
  phases: [{ title: "Find" }, { title: "Draft" }, { title: "Review" }, { title: "Install" }],
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
const FOUND = {
  type: "object",
  properties: {
    from_scratch: { type: "boolean" },
    reuse: { type: "boolean" },
    reuse_role: { type: "string" },
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          role: { type: "string" },
          source: { type: "string" },
          side: { type: "string" },
          why: { type: "string" },
        },
        required: ["role", "source", "side", "why"],
      },
    },
  },
  required: ["from_scratch", "reuse", "reuse_role", "candidates"],
};
const DRAFTED = {
  type: "object",
  properties: {
    draft: { type: "string" },
    role: { type: "string" },
    based_on: { type: "string" },
    summary: { type: "string" },
    failed: { type: "boolean" },
    defects: STRINGS,
    digest: { type: "string" },
  },
  required: ["draft", "role", "based_on", "summary", "failed", "defects", "digest"],
};
const INSTALLED = {
  type: "object",
  properties: { failed: { type: "boolean" }, installed: STRINGS, reason: { type: "string" } },
  required: ["failed", "installed", "reason"],
};
const DISCARDED = {
  type: "object",
  properties: { discarded: { type: "boolean" } },
  required: ["discarded"],
};

const input = args || {};
const answers = input.answers || {};
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

// Step 1
phase("Find");
const found = await agent(JSON.stringify({ action: "find", description: input.description }), {
  agentType: "role-creator",
  schema: FOUND,
  phase: "Find",
});

let notes = "";
if (found.reuse) {
  // Step 2
  const id = `reuse-role:${found.reuse_role}`;
  const decided = await review(id, {
    subject: "an existing role that already does this",
    request: `The role ${found.reuse_role} already does what you described. Use it as it is, or say what a new role built on it should do differently.`,
    materials: { role: found.reuse_role, candidates: found.candidates },
    approvable: true,
  });
  if (decided.decision === "ask") return waiting(id, decided);
  if (decided.decision === "approve")
    return { role: found.reuse_role, reused: true, installed: false };
  if (decided.decision === "cancel")
    return { role: "", reused: false, installed: false, reason: "the owner cancelled" };
  notes = decided.notes;
}

let drafted = null;
let reason = "no draft was approved within 4 rounds";
for (let round = 1; round <= 4; round += 1) {
  // Step 3
  phase("Draft");
  drafted = await agent(
    JSON.stringify({
      action: "draft",
      description: input.description,
      candidates: found.candidates,
      from_scratch: found.from_scratch,
      draft: drafted ? drafted.draft : null,
      notes,
    }),
    { agentType: "role-creator", schema: DRAFTED, phase: "Draft" },
  );
  // Step 4
  const id = `role:${drafted.role}:${drafted.digest}`;
  const decided = await review(id, {
    subject: `the role ${drafted.role}`,
    request: "Approve installing exactly this draft, or say what to change.",
    materials: {
      draft: `.contrejour/drafts/${drafted.draft}`,
      based_on: drafted.based_on,
      summary: drafted.summary,
      check: { failed: drafted.failed, defects: drafted.defects },
    },
    approvable: !drafted.failed,
  });
  if (decided.decision === "ask") return waiting(id, decided);
  if (decided.decision === "cancel") {
    reason = "the owner cancelled";
    break;
  }
  if (decided.decision === "approve" && !drafted.failed) {
    // Step 5
    phase("Install");
    const installed = await agent(
      JSON.stringify({ action: "install", draft: drafted.draft, digest: drafted.digest }),
      { agentType: "role-creator", schema: INSTALLED, phase: "Install" },
    );
    if (!installed.failed)
      return {
        role: drafted.role,
        installed: true,
        files: installed.installed,
        based_on: drafted.based_on,
      };
    reason = installed.reason;
    break;
  }
  notes = decided.notes;
}
// Step 6
phase("Install");
await agent(JSON.stringify({ action: "discard", draft: drafted.draft }), {
  agentType: "role-creator",
  schema: DISCARDED,
  phase: "Install",
});
return { role: drafted.role, installed: false, reason };

// contrejour-loop-definition-sha256: 0adddce9c4b68bb4f44477ea1dd6365b7b9528782cf6a692fbffd87c052224c8
