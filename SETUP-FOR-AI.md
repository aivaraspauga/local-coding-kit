# Set up this kit in a project (for the AI)

The user asked you to add this kit to their project. The kit is for Qwen Code. Do these steps in order. Use the repo link from the user's message. "The project" is the folder you work in, unless the user named another one. Run every command below in the project folder.

## 1. Download the kit to a temporary folder

```text
git clone --depth 1 <repo link> "<temp>/local-coding-kit"
```

`<temp>` is the system temp folder (`$env:TEMP` in PowerShell, `%TEMP%` in cmd, `/tmp` elsewhere). Never clone into the project. No git? Download `<repo link>/archive/refs/heads/main.zip` and unpack it there. Already downloaded it to read this file? Use that copy and go on.

## 2. Copy the kit into the project

```text
node "<temp>/local-coding-kit/copy-kit.mjs"
```

It copies `.qwen/` (rules, skills, helper agents, hooks) and `QWEN.md`, never overwrites a file the project already has, and prints the files it kept as they were. It records what it added in `.qwen/kit/installed.json`, so the kit can be removed later without touching the project's files.

If the project already had `.qwen/kit/`, this was an update: it replaced the kit's files with the new version, except the ones the user changed, and printed the old and the new version number. Then do only "Merge each file it kept" and "The stack" in step 3, and go on to step 4.

## 3. Adapt it to the project

### Merge each file it kept

Keep everything the project has, and add what the kit has and the file lacks:

- `.qwen/settings.json`: add the kit's `hooks` entries, its `permissions.allow` lines, its `env` keys and its `tools` and `skills` lists. On a conflict, keep the project's value and tell the user.
- `QWEN.md`, `AGENTS.md`: add the kit's lines at the end.

### The stack

If the project has a `package.json`, delete the framework skills it does not use from `.qwen/skills/`: `react-nextjs`, `shadcn-ui` (only with `components.json`), `vue`, `angular`, `vanilla-web`. Keep all others. In an empty folder, keep all of them.

### Git

If the project is a git repository, add the line `.local-agent/` to `.gitignore` (create it if missing). The kit keeps the plan of the current task there.

### The checks

The kit runs the checks it finds in the `package.json` of the project folder. If the app's `package.json` is only in a subfolder (for example `web/`), or the project checks its code another way, set `LOCAL_AGENT_CHECK` under `env` in `.qwen/settings.json` to the command that runs the checks (for example `cd web && npm run lint && npm test`), and tell the user.

### The model

The kit's `env` in `.qwen/settings.json` names the model server for the context warnings: `LOCAL_AGENT_URL` (default `http://127.0.0.1:8080`) and `LOCAL_AGENT_MODEL` (default `qwen3.8-27b`). If the user's Qwen Code model runs on another server, set both to that server (without `/v1`) and that model's id. If the model is not Qwen3.8-27B and you know its training cutoff, also set `LOCAL_AGENT_MODEL_CUTOFF` (`YYYY-MM`): the kit then lists packages newer than the model.

### This PC (once)

`qwen-code/user-settings.json` in the download holds the Qwen Code user settings the kit is tuned for: no follow-up suggestions and no background memory (each extra request pushes the conversation out of the model server's cache), the web search tool, and the local model. If the user's `~/.qwen/settings.json` lacks `ui.enableFollowupSuggestions: false` or `memory.enableManagedAutoMemory: false`, show the user what the file would add and ask before you change it. Keep every setting they have: merge objects key by key, and add a `modelProviders.openai` entry only when there is none with the same `id`.

If you added the web search tool, download it once now. Its first start can take longer than Qwen Code waits:

```text
node -e "require('child_process').spawnSync('npx',['-y','mcp-searxng@2.5.0'],{input:'',shell:true,stdio:['pipe','ignore','ignore'],timeout:180000})"
```

## 4. Clean up

Delete `<temp>/local-coding-kit`. Do not commit unless the user asks.

## 5. Report

Tell the user in a few lines what you copied, merged and deleted. On an update, name the old and the new version. Say that a new conversation loads the kit's hooks. Change nothing else (no app, no `AGENTS.md`, no `git init`) unless the user asks.
