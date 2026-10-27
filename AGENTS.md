# local-coding-kit: notes for contributors and agents

The kit an AI copies into a project (`SETUP-FOR-AI.md`), and a launcher for the local model server. See README.md for what it does. The kit is for Qwen Code only (2026-10-27).

## Layout

- `kit/`: everything a project gets, and the only copy of the kit. `.qwen/settings.json` wires the hook scripts to Qwen Code events (`node .qwen/kit/scripts/<name>.mjs`: Qwen Code starts hooks in the project folder and runs Windows hooks through cmd, where quotes break), pre-approves routine commands, and turns off Qwen Code skills and tools that fight the kit. `QWEN.md` tells the AI that `.qwen/` is not part of its task. The setup only installs the kit: no starter app, no questions.
- `kit/.qwen/kit/scripts/`: the hook scripts (plain Node ESM, no dependencies). `readInput()` maps Qwen Code's tool ids to the short names the scripts use (`run_shell_command` -> `Bash`, `edit` -> `Edit`, ...). Shared helpers in `lib/project.mjs`: project root (true-case path), check-command detection, per-conversation state (keyed by `session_id`; helper agents send their parent's), fingerprinting. `lib/deps.mjs`: dependency release facts from deps.dev (cached a day, silent when offline), used by session start and `deps-check.mjs` (after installs). Tests point it at a stand-in server with `LOCAL_AGENT_DEPS_API`. `guard.mjs` treats `.qwen/kit` as its own guardrail; `reminder.mjs` records what only the user's message can say (an `allow <code>`, config files it names, a question).
- `kit/.qwen/kit/prompt/working-style.md`: the rules `session-start.mjs` injects. Keep it short; every line costs context on every session.
- `kit/.qwen/skills/<name>/SKILL.md`: skills. Concrete steps and copyable examples beat general advice. Name Qwen Code's tools (`read_file`, `grep_search`, `run_shell_command`, `edit`, `write_file`). `.qwen/agents/<name>.md`: helper agents (explorer, planner, tester, reviewer), each with `background: false`.
- `qwen-code/user-settings.json`: the Qwen Code user settings the kit is tuned for (local model provider, web search, no follow-up suggestions or background memory). `SETUP-FOR-AI.md` merges it with the user's OK.
- `SETUP-FOR-AI.md`: the steps an AI follows to install or update the kit from a temporary clone (`copy-kit.mjs` copies it, never overwrites a project file, and records what it added, with hashes, in `.qwen/kit/installed.json`), merge kept files, drop unused framework skills, then stop. Keep it in step with `kit/`.
- `kit/.qwen/kit/VERSION`: the kit's version, the date of the last change. Set it to today's date when you change anything in `kit/`. `.qwen/kit/REMOVE.md` with `scripts/remove.mjs`: the removal, from that record (`QWEN.md` points to it; the guard asks before `remove.mjs` runs).
- `launcher/`: `start-server.cmd` (starts llama-server with the target model and `qwen3.8-chat-template.jinja`), `start-all.cmd` (starts what is not running, then shows the status), `coding.cmd` (the "Coding Server" desktop shortcut: closes `LOCAL_AGENT_CLOSE_FOR_CODING` programs, then `start-all coding`), `start-extra.cmd`, `server-extra.cmd` and `status-extra.mjs` (git-ignored, machine-specific additions that `start-all`, `start-server` and `status` use when present), `status.mjs` / `status.cmd` (one line per service with what to do; tested in `tests/hooks.test.mjs`) and the config examples. `config.cmd` is machine-specific and git-ignored. `.cmd` files must keep CRLF line endings (`.gitattributes`).
- `backends/llama-cpp.md`: the one supported server and model, its flags and the first-start checklist.
- `docs/setup-guide.md`: the step-by-step setup (llama.cpp, model, SearXNG, VS Code). Keep its commands working when you change paths, flags or file names.
- The model server runs in router mode, and every client must request the model by its preset name (`qwen3.8-27b`); `qwen-code/user-settings.json` uses it.
- `tests/hooks.test.mjs`: tests for the hook scripts, the project files, `copy-kit.mjs` and `remove.mjs`. Hooks get Qwen Code's input (JSON on stdin, `QWEN_PROJECT_DIR`). The format-file tests need a project with ESLint and Prettier installed (`LCA_TEST_PROJECT`: any project that has both).

## Commands

- `node --test tests/`: hook script, project-file and setup tests. Run after any change in `kit/`, `qwen-code/`, `SETUP-FOR-AI.md` or `launcher/`.

## Rules

- Hook scripts must never crash a session: read input defensively and exit 0 when a project lacks what a hook needs (no `package.json`, no ESLint, no Prettier).
- Hooks run on every tool call in every project. Keep them fast and dependency-free; use the project's own tools from its `node_modules`.
- Don't claim improvements in the README without a measurement; say how many runs it was.
- Version-specific advice (a session start fact, a "this API changed" line in a skill) must be proved on a real install of that version before it goes in.
- Don't put machine-specific paths or personal details in committed files.
- Write documents for people (`README.md`, `docs/`, `backends/`) in plain, simple English: short sentences, everyday words, numbered steps for procedures. Say what to do and why, briefly. Keep commands, paths, numbers and heading anchors exact. Text for the model (`working-style.md`, skills, agents, `QWEN.md`) and code comments keep their own style.
