# local-coding-kit

Rules, checks and recipes that make a coding AI in **Qwen Code** (the VS Code extension or the `qwen` command) more careful. Built for a local model, and it works with any model you run in Qwen Code.

Made for web projects: React / Next.js, Vue / Nuxt, Angular, plain HTML and TypeScript.

**The kit needs only Qwen Code and Node.js.** The rest of this repo is my own setup and how I test the kit. You can ignore it.

Tested only on Windows 11. The model and server settings below are tuned for one 16 GB NVIDIA card. On a card with more or less memory, change the context size or the model file ([backends/llama-cpp.md](backends/llama-cpp.md)).

## What it does

- **No "done" until the checks pass:** type check, lint, tests and (for Next.js) the build.
- **A second look:** a reviewer helper reads the change and finds bugs.
- **Recipes** for common jobs: pages, forms, full-stack features, tests, debugging.
- **Up-to-date facts:** it tells the model which installed packages are newer than its training.
- **Safety:** it blocks force-push, recursive deletes and edits to its own rules. To allow one, reply `allow <code>`.
- **Keeps it on track** when the model reads or searches too much.
- **Cleans every edit** (format and lint fixes).

The cost: the model takes longer to finish.

## Use it in a project

1. Open the project folder in VS Code: a project you already have, or a new, empty folder.
2. In the Qwen Code chat, write:

   > Download https://github.com/aivaraspauga/local-coding-kit into a temporary folder and follow its SETUP-FOR-AI.md to set it up in this project.

3. Start a new chat (it loads the kit) and give it your task.

The kit never overwrites your files and does not change your code. It adds `.qwen/` and `QWEN.md`, and adds its lines to the `.qwen/settings.json`, `QWEN.md` or `AGENTS.md` you already have.

To update the kit later, ask the same thing again.

## My setup

None of this is needed for the kit.

| | |
| --- | --- |
| PC | AMD Ryzen 7 9800X3D, 32 GB RAM, NVIDIA RTX 5080 16 GB, Windows 11 |
| Harness | Qwen Code 0.26.1 in VS Code ("Qwen Code Companion" extension) |
| Model | [Qwen3.8-27B IQ4_XS](https://huggingface.co/jrell/Qwen3.8-27B-i1-IQ4_XS-GGUF-Smaller), 13.5 GB |
| Model server | [llama.cpp](https://github.com/ggml-org/llama.cpp) `llama-server`, build 11461, started by my Windows scripts in `launcher/` |
| Web search | My own [SearXNG](https://docs.searxng.org/) in Docker, through [mcp-searxng](https://github.com/ihor-sokoliuk/mcp-searxng) |
| Speed | About 45-50 tokens per second |

**Server settings:** context 100K, temperature 0.7, top-k 20, top-p 0.95, min-p 0, thinking limit 8192 tokens, reasoning effort medium, KV cache q4_0, cache-ram 0, ctx-checkpoints 4, parallel 1, n-gram guessing on, MTP off. Why each one: [backends/llama-cpp.md](backends/llama-cpp.md).

**Qwen Code settings** ([qwen-code/user-settings.json](qwen-code/user-settings.json)): context 102400, answer limit 24000 tokens, approval `auto-edit`, follow-up suggestions and managed memory off (each extra request slows the next answer), usage statistics off.

**The same setup on your PC** (Windows, NVIDIA card with 16 GB, about one hour): [docs/setup-guide.md](docs/setup-guide.md).

## License

MIT
