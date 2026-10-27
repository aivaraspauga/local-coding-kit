# How to get the best results

The kit makes the model obey the basic rules. These habits give the most help in addition to the kit.

## Start each project correctly
- **Onboard one time:** Type *"Use the onboard-repo skill."* The model writes `AGENTS.md` with the commands, the layout and examples for the project. Qwen Code loads it in every conversation, so later conversations do not start from zero.
- **Keep the lessons:** When the model solves a difficult problem, it adds a line to `AGENTS.md`. Read these lines from time to time.

## Where the kit keeps information
- **The kit rules:** The model always has them.
- **`AGENTS.md`:** facts about the project that stay true.
- **Skills:** procedures. The model loads a skill when a task needs it.
- **`.local-agent/plan.md`:** the plan and the progress of the current task.
- **The conversation:** only what the model examines now.

## Keep tasks small
- **One task in each conversation:** Long conversations become slow. To start again, start a new chat.
- **A plan for big jobs:** The model keeps the plan in `.local-agent/plan.md`. The plan stays when Qwen Code makes the conversation shorter, and a new conversation can continue it.
- **Approve big plans first:** Switch the chat to plan mode before you type your request. The model shows a plan and does not change a file.
- **Helpers:** Write the name of the helper in your request: `explorer` (finds things), `planner`, `tester` or `reviewer`. Each helper works separately and gives a short report.

## Big tasks: plan, build and review separately
1. Type *"Use the planner agent to plan <feature>."* Read the plan and correct it. If you use git, commit your work first.
2. Start a new chat. Then type *"Carry out the plan in .local-agent/plan.md."*
3. Type *"Use the reviewer agent on these changes."* A helper that did not write the code finds more problems.

## When the kit blocks something you want
The guard blocks risky actions, for example a recursive delete, `git reset --hard`, a force-push or a change to a config that decides what the checks enforce. In YOLO mode nobody sees the question, so the model gets a refusal with a short code. If you want the action done, reply `allow <code>` (for example `allow 3f9a`). That exact command, or changes to that file, can then run until the conversation ends.

If your message names a config file ("create vitest.config.ts with ..."), the model may change that file without asking.

## Useful Qwen Code commands
| Function | Command |
| --- | --- |
| Show how full the model memory is | `/context` |
| Make the conversation shorter | `/compress` |
| Change the model | `/model` |
| Refer to a file | `@path/to/file` |

## When the model cannot continue
- **It tries the same failed fix again:** Stop it and tell it what you think is wrong. Or tell it to use the `debug` skill.
- **It reads library code for a long time:** Tell it to use the README or the type files of the package.
- **It cannot solve the problem:** Change to a stronger model with `/model` and let it finish in the same chat.
- **The checks fail for a different reason:** Tell the model. It stops after three attempts.
