export const meta = {
  name: "loop-authoring",
  description:
    "Create or change a loop from the owner's description: find a base, draft on it, offer a new task loop the base components it lacks, add the roles it needs, check, install once the owner approves; or regenerate a stale script",
  whenToUse:
    'Run with {"description": "<the owner\'s words>"}, then again with the owner\'s replies in answers; or with {"regenerate": "<loop>"} for a stale script.',
  phases: [
    { title: "Regenerate" },
    { title: "Find" },
    { title: "Draft" },
    { title: "Components" },
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
const MISSING_ROLES = {
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
};
const DRAFTED = {
  type: "object",
  properties: {
    draft: { type: "string" },
    loop: { type: "string" },
    change: { type: "boolean" },
    kind: { type: "string", enum: ["task", "on-request"] },
    based_on: { type: "string" },
    summary: { type: "string" },
    missing_roles: MISSING_ROLES,
  },
  required: ["draft", "loop", "change", "kind", "based_on", "summary", "missing_roles"],
};
const OFFERED = {
  type: "object",
  properties: {
    components: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          type: { type: "string", enum: ["role", "loop"] },
          adds: { type: "string" },
        },
        required: ["name", "type", "adds"],
      },
    },
    recommendations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          loop: { type: "string" },
          component: { type: "string" },
          where: { type: "string" },
          why: { type: "string" },
        },
        required: ["id", "loop", "component", "where", "why"],
      },
    },
    digest: { type: "string" },
  },
  required: ["components", "recommendations", "digest"],
};
const ADDED = {
  type: "object",
  properties: { added: STRINGS, summary: { type: "string" }, missing_roles: MISSING_ROLES },
  required: ["added", "summary", "missing_roles"],
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
// The base components the owner accepted into the draft: offered once per run, kept by later drafts.
let offered = false;
let components = { added: [], summary: "" };
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
      components,
    }),
    { agentType: "loop-editor", schema: DRAFTED, phase: "Draft" },
  );
  let missingRoles = drafted.missing_roles;
  // Step 5
  if (!offered && !drafted.change && drafted.kind === "task") {
    offered = true;
    phase("Components");
    const offer = await agent(
      JSON.stringify({ action: "find-components", draft: drafted.draft, loop: drafted.loop }),
      { agentType: "loop-query", schema: OFFERED, phase: "Components" },
    );
    if (offer.recommendations.length) {
      const offerId = `components:${drafted.loop}:${offer.digest}`;
      const confirmed = await review(offerId, {
        subject: `base components for the new task loop ${drafted.loop}`,
        request:
          "Add the recommended base components to the draft (all of them, or the ones you name), or say what to change; cancel to go on without them. You approve the whole loop afterwards.",
        materials: {
          draft: `.contrejour/drafts/${drafted.draft}`,
          components: offer.components,
          recommendations: offer.recommendations,
        },
        approvable: true,
      });
      if (confirmed.decision === "ask") return waiting(offerId, confirmed);
      if (confirmed.decision !== "cancel") {
        const added = await agent(
          JSON.stringify({
            action: "add-components",
            draft: drafted.draft,
            loop: drafted.loop,
            recommendations: offer.recommendations,
            accepted: confirmed.accepted,
            notes: confirmed.notes,
            missing_roles: drafted.missing_roles,
          }),
          { agentType: "loop-editor", schema: ADDED, phase: "Components" },
        );
        components = { added: added.added, summary: added.summary };
        missingRoles = added.missing_roles;
      }
    }
  }
  // Step 6
  phase("Roles");
  const missing = missingRoles.slice(0, 4);
  if (missingRoles.length > missing.length)
    log(
      `${missingRoles.length - missing.length} more missing roles were not drafted; the check reports them`,
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
  // Step 7
  phase("Draft");
  const finished = await agent(
    JSON.stringify({ action: "finish", draft: drafted.draft, loop: drafted.loop }),
    { agentType: "loop-editor", schema: FINISHED, phase: "Draft" },
  );
  // Step 8
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
      components,
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
    // Step 9
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
        components: components.added,
      };
    reason = installed.reason;
    break;
  }
  notes = decided.notes;
}
// Step 10
phase("Install");
await agent(JSON.stringify({ action: "discard", draft: drafted.draft }), {
  agentType: "loop-editor",
  schema: DISCARDED,
  phase: "Install",
});
return { loop: drafted.loop, installed: false, reason };

// contrejour-loop-definition-sha256: 6c82a92a163c9fa3c32ce066925b2ae9d9c3db3b08c14854194358e70ff1ac54
