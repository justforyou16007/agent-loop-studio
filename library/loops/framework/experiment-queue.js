export const meta = {
  name: "experiment-queue",
  description:
    "Run a stage's experiments as the owner's settings say: dispatch, have the watchdog follow them on an interval, stop what stalls, fails or runs past its limit, and report",
  whenToUse:
    'Run as a step of a task loop with {"queue": "<name>", "experiments": [{"id", "run": [argv]}], "params": {...}}.',
  phases: [
    { title: "Enqueue" },
    { title: "Dispatch" },
    { title: "Watch" },
    { title: "Stop" },
    { title: "Report" },
  ],
};

const STRINGS = { type: "array", items: { type: "string" } };
const ADDED = {
  type: "object",
  properties: { added: STRINGS },
  required: ["added"],
};
const STARTED = {
  type: "object",
  properties: { started: STRINGS, running: { type: "integer" } },
  required: ["started", "running"],
};
const WATCHED = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          state: {
            type: "string",
            enum: ["running", "finished", "failed", "stalled", "over-limit"],
          },
          evidence: { type: "string" },
          stop: { type: "boolean" },
        },
        required: ["id", "state", "evidence", "stop"],
      },
    },
    all_done: { type: "boolean" },
    summary: { type: "string" },
  },
  required: ["tasks", "all_done", "summary"],
};
const STOPPED = {
  type: "object",
  properties: { stopped: STRINGS },
  required: ["stopped"],
};
const REPORTED = {
  type: "object",
  properties: {
    experiments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          state: { type: "string" },
          exit_code: { type: ["integer", "null"] },
          minutes: { type: "number" },
          output: { type: "string" },
        },
        required: ["id", "state", "exit_code", "minutes", "output"],
      },
    },
    summary: { type: "string" },
  },
  required: ["experiments", "summary"],
};

const input = args || {};
const params = input.params || {};
const queue = input.queue;
const maxParallel = Number.isInteger(params.max_parallel) ? params.max_parallel : 2;
const maxMinutes = Number.isInteger(params.max_minutes) ? params.max_minutes : 120;
const interval = Number.isInteger(params.check_interval_seconds)
  ? params.check_interval_seconds
  : 300;
const stallMinutes = Number.isInteger(params.stall_minutes) ? params.stall_minutes : 30;
const stopRestOn = params.stop_rest_on || "never";
const maxChecks = Number.isInteger(params.max_checks) ? params.max_checks : 200;
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

// Step 5, also on its own when the calling step sent the report back.
const report = (back, redo) =>
  step(
    "experiment-runner:report",
    () =>
      agent(JSON.stringify({ action: "report", queue, returned: back }), {
        agentType: "experiment-runner",
        schema: sending(REPORTED, back ? ["caller"] : ["watchdog:watch"]),
        phase: "Report",
      }),
    redo,
  );
const ended = (reported) =>
  reported.sent_back
    ? { queue, sent_back: reported.sent_back }
    : { queue, experiments: reported.experiments, summary: reported.summary };
if (input.returned) {
  phase("Report");
  return ended(await report(input.returned, {}));
}

// Step 1
phase("Enqueue");
const enqueue = (back) =>
  agent(
    JSON.stringify({ action: "enqueue", queue, experiments: input.experiments, returned: back }),
    { agentType: "experiment-runner", schema: sending(ADDED, ["caller"]), phase: "Enqueue" },
  );
const added = await step("experiment-runner:enqueue", () => enqueue(null));
if (added.sent_back) return { queue, sent_back: added.sent_back };

let watched = null;
let rewatch = null;
for (let check = 1; check <= maxChecks; check += 1) {
  // Step 2
  phase("Dispatch");
  const dispatch = (back) =>
    agent(
      JSON.stringify({ action: "dispatch", queue, max_parallel: maxParallel, returned: back }),
      {
        agentType: "experiment-runner",
        schema: sending(STARTED, ["experiment-runner:enqueue"]),
        phase: "Dispatch",
      },
    );
  const dispatched = await step("experiment-runner:dispatch", () => dispatch(null), {
    "experiment-runner:enqueue": (back) => step("experiment-runner:enqueue", () => enqueue(back)),
  });
  if (dispatched.sent_back) return { queue, sent_back: dispatched.sent_back };
  // Step 3
  phase("Watch");
  const look = (back) =>
    agent(
      JSON.stringify({
        action: "watch",
        queue,
        interval_seconds: interval,
        stall_minutes: stallMinutes,
        max_minutes: maxMinutes,
        round: check,
        returned: back,
      }),
      {
        agentType: "watchdog",
        schema: sending(WATCHED, ["experiment-runner:dispatch"]),
        phase: "Watch",
      },
    );
  const lookRedo = {
    "experiment-runner:dispatch": (back) =>
      step("experiment-runner:dispatch", () => dispatch(back)),
  };
  watched = await step("watchdog:watch", () => look(null), lookRedo);
  if (watched.sent_back) return { queue, sent_back: watched.sent_back };
  rewatch = async (back) => {
    const again = await step("watchdog:watch", () => look(back), lookRedo);
    if (!again.sent_back) watched = again;
    return again;
  };
  // Step 4
  const stop = watched.tasks
    .filter((task) => task.stop)
    .map((task) => ({ id: task.id, reason: task.evidence }));
  if (stop.length || stopRestOn !== "never") {
    phase("Stop");
    const stopped = await step(
      "experiment-runner:stop",
      () =>
        agent(
          JSON.stringify({
            action: "stop",
            queue,
            stop,
            stop_rest_on: stopRestOn,
            tasks: watched.tasks,
          }),
          {
            agentType: "experiment-runner",
            schema: sending(STOPPED, ["watchdog:watch"]),
            phase: "Stop",
          },
        ),
      { "watchdog:watch": rewatch },
    );
    if (stopped.sent_back) return { queue, sent_back: stopped.sent_back };
  }
  if (watched.all_done) break;
}
// Past the bound, what still runs or waits is stopped before the report.
if (watched && !watched.all_done) {
  phase("Stop");
  const left = watched.tasks
    .filter((task) => task.state === "running" || task.state === "stalled")
    .map((task) => ({ id: task.id, reason: `the queue looked ${maxChecks} times` }));
  const stopped = await step(
    "experiment-runner:stop",
    () =>
      agent(
        JSON.stringify({
          action: "stop",
          queue,
          stop: left,
          stop_rest_on: "never",
          tasks: watched.tasks,
        }),
        {
          agentType: "experiment-runner",
          schema: sending(STOPPED, ["watchdog:watch"]),
          phase: "Stop",
        },
      ),
    { "watchdog:watch": rewatch },
  );
  if (stopped.sent_back) return { queue, sent_back: stopped.sent_back };
}
// Step 5
phase("Report");
return ended(await report(null, rewatch ? { "watchdog:watch": rewatch } : {}));

// contrejour-loop-definition-sha256: 4772aa9a66b20160fec951da85c1ed6b434547ce9a2aa2d0c834baf3f85cb91d
