# Running loops from a session

Contrejour has three levels, and each does one kind of work:

- **The session** — the role a Claude Code session runs as: the project's entry role, a task manager — starts loops and carries the owner's answers into them. It never calls a role itself and never decides anything for the owner.
- **A loop** schedules roles: which role does each step, in what order, on what condition, how many times, and where it waits.
- **A role** does one step, as its own file says, using helpers as its tools.

No flow lives outside a loop. Work that takes more than one role, or a decision of the owner's, is a loop; a role never runs another role (no Agent tool for roles), and an owner's decision is an `owner-review` step of a loop.

## Start

Run the loop with the Workflow tool, by its name: a loop is a saved workflow in `.claude/workflows/`, not a skill. Pass the arguments its definition's Inputs section names. Every role of the loop receives the message that started the run, so the message that starts a loop names the loop and nothing else.

## What a loop returns

- `{"waiting": "owner", "review_id", "question", "document"}`: the loop needs the owner (below).
- A waiting point its definition's Waiting section describes, such as a submission waiting for its published result: do what that section says.
- Anything else is the loop's result: report it to the owner as it is.

## Waiting for the owner

A role running inside a loop cannot talk to the owner: Claude Code gives workflow agents no way to ask the person (no AskUserQuestion). So a loop that needs the owner stops at its `owner-review` step, which has written a review note, and returns. The session carries the question to the owner and the answer back:

1. Show the owner the review note at `document` in full, its text as it is rather than a summary of it, then the question, and end your turn. The owner's next message is the answer.
2. Run the same loop again with the same arguments, adding the owner's reply, verbatim, as `answers.<review_id>`, and keeping every earlier answer of this run. Resume the previous run with its run id (`resumeFromRunId`), so the steps that already finished return at once and only the steps after the answer run again.
3. Never answer for the owner, and never shorten, translate, summarize, annotate or interpret the reply: `owner-review` reads it. Never reuse a reply for another review, even a later version of the same thing: that review is shown to the owner. When the owner asks something instead of answering, answer from the review note and ask again; their final reply is the answer.
4. When the loop stops again, at the same `review_id` with a clarifying question or at a new one, relay it the same way.

Contrejour's hook checks every run before it starts: each answer must be, whole and word for word, a message the owner typed in this session after the loop stopped at that review. It blocks the run otherwise, and records the answers it verified, which `owner-review` checks; Claude Code marks everything a loop passes to a role as computed text, so the record is how a role knows a reply is the owner's. A session that did not receive an answer (Claude Code was restarted, or the answer was given in another session) runs the loop without it, and the loop asks again. Review ids name the exact version under review (a digest), so an answer never applies to a version the owner did not see.

## A run that stopped

A run that stopped partway, for example when the session was interrupted, is resumed with its run id rather than started again.
