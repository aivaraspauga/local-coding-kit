---
name: plan-work
description: A short plan with checkable steps in .local-agent/plan.md, worked through step by step. Use for multi-feature work or "build me an app"; not for one page or fix.
---

# Plan the work

Short, concrete and checkable, saved to a file so it survives when the conversation is summarized.

## 0. Is there already a plan?
If `.local-agent/plan.md` exists and matches the user's request (an earlier session may have written it), read it and continue from the first unchecked step. Do not re-plan work that is already planned; only fix the plan if it is wrong.

## 1. Pin down the goal
- Write the goal in one sentence, in the user's terms ("people can tag tasks and filter by a tag").
- List what "done" looks like as 2 to 5 observable checks ("a tag typed when adding a task shows as a chip", "clicking a chip shows only tasks with that tag", "tags survive a reload", "the project's checks pass").
- If a choice changes the result and the user would care (which pages, which data is stored, what happens on error), ask one short question. For small choices, pick a sensible default and say so in one line.

## 2. Scope the smallest complete version
- For a loose request, build the smallest version that does the whole job end to end before adding extras.
- Write down what you are not doing ("no tag colours, no editing tags on existing tasks"). It stops scope from growing.

## 3. Look before you plan
- Find the files involved and one similar finished feature to copy; a plan written without looking is a guess. Look yourself in a small repo; use the `explorer` agent when the repo is large. For a very big task, hand the whole job to the `planner` agent: it explores in its own context and writes `.local-agent/plan.md`.
- **Checkpoint.** If the project uses git, run `git status`. If there are uncommitted changes, tell the user and suggest committing them (or working on a new branch) before a big change, so it is easy to undo. Do not commit or create branches unless the user asks you to.

## 4. Write the plan to `.local-agent/plan.md`
If the project uses git and `.gitignore` does not mention `.local-agent/`, ask the user once whether to add it: the plan is working notes, and most people do not want it committed.

Steps go in dependency order (data, then server, then UI, then tests), 3 to 8 of them, each naming its files and ending with a check you can run:

```markdown
# Plan: tags on tasks
Goal: people can tag tasks and filter the list by a tag.

Done when:
- a tag typed when adding a task shows as a chip on that task
- clicking a chip shows only tasks with that tag; "Clear filter" shows all again
- tags survive a reload; the project's checks pass

Not doing: tag colours, editing tags on existing tasks.
Template: src/server/tasks.ts + src/components/task-list.tsx (how `done` flows end to end).

- [ ] 1. Data: `tags` column (JSON text) in src/server/db.ts, with a migration for existing databases. Check: unit test for createTask with tags.
- [ ] 2. Server: validate `tags` (array of short strings) in newTaskSchema; the POST route passes it through. Check: API test, 400 on bad input.
- [ ] 3. UI: tags input in the add form; chips on each row in task-list.tsx. Check: component test.
- [ ] 4. UI: click a chip to filter; "Clear filter" button. Check: browser test with verify-web-app.
- [ ] 5. Run all "Done when" checks and the project's checks.

Notes:
```

Also mirror the steps in the todo list (todo_write) when you have it.

## 5. Review the plan before you start
Read it once as a critic and fix it:
- Does every "Done when" item have a step that delivers it and a check that proves it?
- Is the riskiest or least certain step early, so a surprise costs little? (A migration, an API you have not used, a layout change.)
- What existing behaviour could break, and which check would notice?
- Is anything in the plan not needed for the goal? Cut it.

## 6. Work the plan
- One step at a time. Finish its check, then tick it (`- [x]`) in the file before starting the next.
- If a step reveals something the plan missed (a migration, an existing bug, a wrong assumption), stop, update the plan file (add a line under Notes), and continue. Do not quietly drift.
- If one step takes more than a few attempts, re-read the goal: is the step needed, or is there a simpler path?

## 7. Close out
- Run every "Done when" check, not only the last step's.
- Ask the `reviewer` agent for a fresh look (give it the request and the plan) and fix what it finds.
- Report against the plan: done, changed, skipped and why. When every step is done, all steps are ticked (the plan then stops being offered to new sessions).
- A step you could not finish stays unticked, with the reason under Notes, and your report names it as not done. Never tick a step whose check you did not run.
