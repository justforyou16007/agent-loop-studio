export const meta = {
  name: "loop-authoring",
  description:
    "Create or change a loop from the owner's description: find a base, draft on it, add the roles it needs, check, install once the owner approves; or regenerate a stale script",
  whenToUse:
    'Run with {"description": "<the owner\'s words>"}, then again with the owner\'s replies in answers; or with {"regenerate": "<loop>"} for a stale script.',
  phases: [
    { title: "Regenerate" },
    { title: "Find" },
    { title: "Draft" },
    { title: "Roles" },
    { title: "Review" },
    { title: "Install" },
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
const REGENERATED = {
  type: "object",
  properties: { failed: { type: "boolean" }, defects: STRINGS },
  required: ["failed", "defects"],
};
const FOUND = {
  type: "object",
  properties: {
    from_scratch: { type: "boolean" },
    reuse: { type: "boolean" },
    reuse_loop: { type: "string" },
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          loop: { type: "string" },
          source: { type: "string" },
          side: { type: "string" },
          kind: { type: "string" },
          why: { type: "string" },
        },
        required: ["loop", "source", "side", "kind", "why"],
      },
    },
  },
  required: ["from_scratch", "reuse", "reuse_loop", "candidates"],
};
const DRAFTED = {
  type: "object",
  properties: {
    draft: { type: "string" },
    loop: { type: "string" },
    change: { type: "boolean" },
    based_on: { type: "string" },
    summary: { type: "string" },
    missing_roles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          needs: { type: "string" },
          library_role: { type: "string" },
        },
        required: ["name", "needs", "library_role"],
      },
    },
  },
  required: ["draft", "loop", "change", "based_on", "summary", "missing_roles"],
};
const ROLE_DRAFTED = {
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
const FINISHED = {
  type: "object",
  properties: { failed: { type: "boolean" }, digest: { type: "string" }, defects: STRINGS },
  required: ["failed", "digest", "defects"],
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

if (input.regenerate) {
  // Step 1: the definition is unchanged and already approved; only its script is rebuilt.
  phase("Regenerate");
  const regenerated = await agent(
    JSON.stringify({ action: "regenerate", loop: input.regenerate }),
    { agentType: "loop-editor", schema: REGENERATED, phase: "Regenerate" },
  );
  return {
    loop: input.regenerate,
    regenerated: !regenerated.failed,
    defects: regenerated.defects,
  };
}

// Step 2
phase("Find");
const wanted = { description: input.description, side: input.side || "", kind: input.kind || "" };
const found = await agent(JSON.stringify({ action: "find-base", ...wanted }), {
  agentType: "loop-query",
  schema: FOUND,
  phase: "Find",
});

let notes = "";
if (found.reuse) {
  // Step 3
  const id = `reuse-loop:${found.reuse_loop}`;
  const decided = await review(id, {
    subject: "an existing loop that already does this",
    request: `The loop ${found.reuse_loop} already does what you described. Use it as it is, or say what a new loop built on it should do differently.`,
    materials: { loop: found.reuse_loop, candidates: found.candidates },
    approvable: true,
  });
  if (decided.decision === "ask") return waiting(id, decided);
  if (decided.decision === "approve")
    return { loop: found.reuse_loop, reused: true, installed: false };
  if (decided.decision === "cancel")
    return { loop: "", reused: false, installed: false, reason: "the owner cancelled" };
  notes = decided.notes;
}

let drafted = null;
let reason = "no draft was approved within 4 rounds";
for (let round = 1; round <= 4; round += 1) {
  // Step 4
  phase("Draft");
  drafted = await agent(
    JSON.stringify({
      action: "draft",
      ...wanted,
      candidates: found.candidates,
      from_scratch: found.from_scratch,
      draft: drafted ? drafted.draft : null,
      notes,
    }),
    { agentType: "loop-editor", schema: DRAFTED, phase: "Draft" },
  );
  // Step 5
  phase("Roles");
  const missing = drafted.missing_roles.slice(0, 4);
  if (drafted.missing_roles.length > missing.length)
    log(
      `${drafted.missing_roles.length - missing.length} more missing roles were not drafted; the check reports them`,
    );
  for (const role of missing)
    await agent(
      JSON.stringify({
        action: "draft",
        draft: drafted.draft,
        name: role.name,
        description: role.needs,
        base: role.library_role,
        notes,
      }),
      { agentType: "role-creator", schema: ROLE_DRAFTED, phase: "Roles" },
    );
  // Step 6
  phase("Draft");
  const finished = await agent(
    JSON.stringify({ action: "finish", draft: drafted.draft, loop: drafted.loop }),
    { agentType: "loop-editor", schema: FINISHED, phase: "Draft" },
  );
  // Step 7
  const id = `loop:${drafted.loop}:${finished.digest}`;
  const decided = await review(id, {
    subject: drafted.change
      ? `a change to the loop ${drafted.loop}`
      : `a new loop, ${drafted.loop}`,
    request: "Approve installing exactly this draft, or say what to change.",
    materials: {
      draft: `.contrejour/drafts/${drafted.draft}`,
      based_on: drafted.based_on,
      summary: drafted.summary,
      new_roles: missing.map((role) => role.name),
      check: finished,
    },
    approvable: !finished.failed,
  });
  if (decided.decision === "ask") return waiting(id, decided);
  if (decided.decision === "cancel") {
    reason = "the owner cancelled";
    break;
  }
  if (decided.decision === "approve" && !finished.failed) {
    // Step 8
    phase("Install");
    const installed = await agent(
      JSON.stringify({ action: "install", draft: drafted.draft, digest: finished.digest }),
      { agentType: "loop-editor", schema: INSTALLED, phase: "Install" },
    );
    if (!installed.failed)
      return {
        loop: drafted.loop,
        installed: true,
        files: installed.installed,
        based_on: drafted.based_on,
      };
    reason = installed.reason;
    break;
  }
  notes = decided.notes;
}
// Step 9
phase("Install");
await agent(JSON.stringify({ action: "discard", draft: drafted.draft }), {
  agentType: "loop-editor",
  schema: DISCARDED,
  phase: "Install",
});
return { loop: drafted.loop, installed: false, reason };

// contrejour-loop-definition-sha256: b3ca76f0e13f9df263322f41b95a597e03c07835654bd67d32040eda64c1e07d
