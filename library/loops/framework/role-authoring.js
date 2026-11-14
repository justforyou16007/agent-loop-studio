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
phase("Find");
const find = (returned) =>
  agent(JSON.stringify({ action: "find", description: input.description, returned }), {
    agentType: "role-creator",
    schema: sending(FOUND, ["caller"]),
    phase: "Find",
  });
let found = await step("role-creator:find", () => find(null));
if (found.sent_back) return found;
// Step 6, also when a draft step sends back the owner's own words.
const discard = (draft) =>
  step("role-creator:discard", () =>
    agent(JSON.stringify({ action: "discard", draft }), {
      agentType: "role-creator",
      schema: sending(DISCARDED, ["caller"]),
      phase: "Install",
    }),
  );

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
// What Install sent back: the next draft redoes it, and goes to the owner again.
let returned = null;
let installReturns = 0;
let sent = null;
for (let round = 1; round <= 4; round += 1) {
  // Step 3
  phase("Draft");
  const previous = drafted;
  drafted = await step(
    "role-creator:draft",
    () =>
      agent(
        JSON.stringify({
          action: "draft",
          description: input.description,
          candidates: found.candidates,
          from_scratch: found.from_scratch,
          draft: previous ? previous.draft : null,
          notes,
          returned,
        }),
        {
          agentType: "role-creator",
          schema: sending(DRAFTED, ["role-creator:find", "caller"]),
          phase: "Draft",
        },
      ),
    {
      "role-creator:find": async (back) => {
        phase("Find");
        found = await step("role-creator:find", () => find(back));
        return found;
      },
    },
  );
  if (drafted.sent_back) {
    if (previous) await discard(previous.draft);
    return { role: previous ? previous.role : "", installed: false, sent_back: drafted.sent_back };
  }
  returned = null;
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
      {
        agentType: "role-creator",
        schema: sending(INSTALLED, ["role-creator:draft"]),
        phase: "Install",
      },
    );
    // A draft Install cannot use is drafted again, then put to the owner again: the owner approves
    // exactly what is installed.
    if (installed.send_back.needed) {
      if (installReturns >= SEND_BACKS) {
        sent = {
          by: "role-creator:install",
          to: "role-creator:draft",
          problems: installed.send_back.problems,
        };
        reason = "Install could not use the approved draft";
        break;
      }
      installReturns += 1;
      returned = { by: "role-creator:install", problems: installed.send_back.problems };
      continue;
    }
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
const discarded = await discard(drafted.draft);
const cleanup = discarded.sent_back ? { sent_back: discarded.sent_back } : {};
return {
  role: drafted.role,
  installed: false,
  reason,
  ...cleanup,
  ...(sent ? { sent_back: sent } : {}),
};

// contrejour-loop-definition-sha256: eb2fc2ae3025eac8b383bad1a6bf281e2833d2089e28bad1295c3ef2dd35b81d
