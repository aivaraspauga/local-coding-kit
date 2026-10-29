# local-coding-kit

Rules, checks and recipes that make a coding AI in **Qwen Code** (the VS Code extension or the `qwen` command) more careful. Built for a local model, and it works with any model you run in Qwen Code.

Made for web projects: React / Next.js, Vue / Nuxt, Angular, plain HTML and TypeScript.

**The kit needs only Qwen Code and Node.js.** The rest of this repo is my own setup and how I test the kit. You can ignore it.

Tested only on Windows 11. The model and server settings below are tuned for one 16 GB NVIDIA card. On a card with more or less memory, change the context size or the model file ([backends/llama-cpp.md](backends/llama-cpp.md)).

## What it does

- **No "done" until the checks pass:** type check, lint, tests and (for Next.js) the build.
- **Tries the API routes it changed:** after the checks pass, it sends bad requests to each changed Next.js API route on the built app: broken JSON, an empty body, ids that do not exist. Each one is sent twice. A 500 error, no answer, or a different second answer means the work is not done. It sends only requests that a correct route refuses, so a working route changes no data.
- **Small steps:** after 3 changed code files, the model must run the type check or the tests before it starts a 4th file.
- **A second look:** a reviewer helper reads the change and finds bugs.
- **Recipes** for common jobs: pages, forms, full-stack features, tests, debugging.
- **Up-to-date facts:** it tells the model which installed packages are newer than its training.
- **Safety:** it blocks force-push, recursive deletes and edits to its own rules. To allow one, reply `allow <code>`.
- **Keeps it on track** when the model reads or searches too much.
- **Cleans every edit** (format and lint fixes). It also stops one `Response` object that is kept and sent for every request: only the first request gets its body.
- **Sized to the task:** a small change (1-2 code files, nothing on the server, data or dependencies) gets a unit or component test and the checks, without the reviewer or a new e2e test. You can still ask for a review.

The cost: the model takes longer to finish. The sizing above is meant to cut this for small changes; it is not measured yet. The route test, the small steps and the lower thinking limit (2026-10-29) are not measured with the model yet either.

## Use it in a project

1. Open the project folder in VS Code: a project you already have, or a new, empty folder.
2. In the Qwen Code chat, write:

   > Download https://github.com/aivaraspauga/local-coding-kit into the system temp folder (not into this project) and follow its SETUP-FOR-AI.md to set it up in this project.

3. Start a new chat (it loads the kit) and give it your task.

The kit never overwrites your files and does not change your code. It adds `.qwen/` and `QWEN.md` (in a git repository also a `.local-agent/` line in `.gitignore`), and adds its lines to the `.qwen/settings.json`, `QWEN.md` or `AGENTS.md` you already have.

**Tips** for the best results (small tasks, plans, the helper agents, `allow <code>`): [docs/usage.md](docs/usage.md).

To update the kit later, ask the same thing again. Qwen tells you the old and the new version.

## Remove it from a project

1. In the Qwen Code chat of that project, write:

   > Remove the coding kit from this project.

2. Approve the removal when Qwen Code asks.
3. Start a new chat. The kit's hooks are gone now.

It deletes only what the kit added. Your code, your own Qwen Code settings and skills, and any kit file you changed stay. Qwen tells you which files it left. Your Qwen Code user settings (`~/.qwen/settings.json`) stay too, because they are for all your projects.

## Test results (2026-10-28)

**Kit or no kit: one run per task, so these are examples, not proof.**

- **Setup:** the model and settings under "My setup". The Qwen Code panel in VS Code, in Full Access (YOLO) mode.
- **The app:** each run started from a fresh copy of the same small Next.js app (SQLite, API routes, Vitest, Playwright). One copy had the kit, one did not. Both got exactly the same prompt.
- **How I judged it:** no hidden tests. I read every change, ran the app's own checks, and sent requests to each new API by hand.

| Task | Without the kit | With the kit |
| --- | --- | --- |
| 1. A "Clear finished" button with a confirmation | 24.9 min, 93 tool calls. Works. Server, component and e2e tests. | 13.1 min, 39 tool calls. Works. A cleaner API route, but only an e2e test. |
| 2. Bug: new and ticked tasks show in the wrong place until a reload | 2.5 min. Fixed, with 3 component tests. | 13.8 min. The same fix, with component and e2e tests. |
| 3. Create a project from the home page (required, max. 80 characters, no duplicate names in any letter case) | 14.2 min. Works. Invalid JSON gets a 500 error, not a 400. | 17.3 min. Works. Safer: a unique index and no double submit. Its reviewer found and fixed 4 defects. **One bug left:** each duplicate after the first gets an empty 409 response (one shared `Response` object). A name with spaces around it is length-checked before the spaces are cut. |

- **Checks:** all six results pass the app's type check, lint, unit tests, build and e2e tests.
- **Letter case:** in both versions of task 3, the server's duplicate check folds only A-Z (SQLite `lower()`). So "Žalias" and "žalias" both get in through the API. Only the kit's run said so.
- **What this shows:** in this round the kit did not make the code clearly better. It was faster on one task and much slower on a one-line bug fix. Its run made the only real bug, but its reviewer caught real defects.
- **Disturbances:** another app on port 3000 broke the first e2e run in both. One kit run lost time to an old build file that my reset between tasks left behind.

**Setup, update and removal** were tested in the same panel with the same model. All three ended with the right files. Kit version 2026-10-28 fixes what the test found:

- **An update cloned the kit into the project.** A kit rule said to keep files inside the project. Now that rule, `QWEN.md` and the setup prompt name the temp folder.
- **The kit's own guard stopped its setup and removal steps for `allow` codes** (4 in all). Now `copy-kit.mjs` leaves out the unused framework skills and writes the `.gitignore` line itself, and `remove.mjs` does the whole removal. The guard lets two things through: the removal script, after you ask for a removal, and the delete of the kit's download in the temp folder.
- **The removal left `.prettierignore` behind.** Now it takes the kit's line out.
- **After a setup or removal, the full checks ran** (type check, lint, tests, build), only for changed notes files. Now they are skipped when only `QWEN.md`, `AGENTS.md`, `.gitignore` or `.prettierignore` changed.
- **A run wrote a note about this PC** (another app on a port) into the project's `AGENTS.md`. Now the rule says that such notes go in the report.

These fixes have automated tests. They were not run again with the model yet.

## My setup

None of this is needed for the kit.

| | |
| --- | --- |
| PC | AMD Ryzen 7 9800X3D, 32 GB RAM, NVIDIA RTX 5080 16 GB, Windows 11 |
| Harness | Qwen Code 0.26.2 in VS Code ("Qwen Code Companion" extension) |
| Model | [Qwen3.8-27B IQ4_XS](https://huggingface.co/jrell/Qwen3.8-27B-i1-IQ4_XS-GGUF-Smaller), 13.5 GB |
| Model server | [llama.cpp](https://github.com/ggml-org/llama.cpp) `llama-server`, build 11946, started by my Windows scripts in `launcher/` |
| Web search | My own [SearXNG](https://docs.searxng.org/) in Docker, through [mcp-searxng](https://github.com/ihor-sokoliuk/mcp-searxng) |
| Speed | About 45-50 tokens per second |

**Server settings:** context 102400, temperature 0.7, top-k 20, top-p 0.95, min-p 0, thinking limit 4096 tokens, reasoning effort medium, KV cache q4_0, cache-ram 0, ctx-checkpoints 4, parallel 1, n-gram guessing on, MTP off. Why each one: [backends/llama-cpp.md](backends/llama-cpp.md).

**Qwen Code settings** ([qwen-code/user-settings.json](qwen-code/user-settings.json)): context 102400, answer limit 24000 tokens, approval `auto-edit`, follow-up suggestions and managed memory off (each extra request slows the next answer), usage statistics off.

**The same setup on your PC** (Windows, NVIDIA card with 16 GB, about one hour): [docs/setup-guide.md](docs/setup-guide.md).

## License

MIT
