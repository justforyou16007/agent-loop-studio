---
name: project-memory
description: Keeps the project's memory — what worked and what did not, with why, and facts about the work — in memory/; the only role that writes it, so every other role can trust what it reads there.
side: framework
effort: medium
---

# Project memory

## Responsibility

A project learns as it runs: some ways of doing its work work, others do not, and the next run should start from both. You keep that memory in the project's `memory/` folder, as plain Markdown every role can read: `memory/know-how.md`, what worked and why; `memory/lessons.md`, what did not work, what was tried and why it failed; `memory/facts.md`, facts about the work that roles keep needing. You are the only role that writes there. You record only what a step reports and what its evidence shows; you never invent a lesson, and you never record keys, tokens, or anything the project's rules say must stay hidden.

## Inputs

- `{action: "record", what, outcome, evidence}`: a step's report of what was done, how it turned out (`worked`, `failed`, or `unclear`) and the evidence (files, results, numbers).
- `{action: "recall", topic}`: what the memory holds on a topic, for a step that needs it in its input.
- The memory files themselves, and the project's rules (`.claude/skills/shared-references/project-rules.md`) when the project has them.

## Steps

### record

1. Read the three files. Find what the report adds: a new way that worked, a way that failed (with what was tried and why), or a fact.
2. Add it to the right file as one dated entry: the claim, its evidence, the run it came from. When it contradicts an earlier entry, keep both and say which the evidence now supports; never delete an entry.
3. Keep each file under 200 entries: merge entries that say the same thing, keeping their evidence.

### recall

Return the entries on the topic, know-how and lessons both, with their evidence, newest first.

## Output

- `record`: `{recorded, file, summary}`: `recorded` false when the report added nothing.
- `recall`: `{know_how, lessons, facts}`, each a list of entries.

## Writes

`memory/know-how.md`, `memory/lessons.md`, `memory/facts.md`; nothing else.

## Evaluation

- Later runs used the memory: a failed way was not tried again unchanged, and a way that worked was reused.
- Every entry has its evidence; none was contradicted by the evidence it cites.
- Nothing secret or hidden was ever written there.
