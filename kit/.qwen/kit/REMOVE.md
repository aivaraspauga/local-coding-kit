# Remove the kit (for the AI)

Do this only when the user asked to remove the coding kit from the project. Run the commands in the project folder.

1. **Take the kit's parts out of the shared files.** `.qwen/kit/installed.json` holds, under `kit`, the kit's own version of `QWEN.md` and `.qwen/settings.json`. For each of the two files the project has:
   - The same as the kit's version: delete it.
   - Different: take out what the kit's version has (its lines; its `hooks` entries, `permissions.allow` lines, `env` keys and `tools`, `skills` and `model` entries) and keep the rest. If nothing is left, delete the file.
2. **Delete the kit's files.** Run `node .qwen/kit/scripts/remove.mjs`. It deletes the files the setup added that nobody changed since, `.qwen/kit` and the folders left empty. It names the files it left because they changed: ask the user what to do with them.
3. **Delete the kit's notes.** Delete the folder `.local-agent/` (the plan of the current task) and the line `.local-agent/` in `.gitignore`. If `.gitignore` is then empty, delete it.
4. **Report.** Tell the user what you removed and what you left. The kit's hooks stop in the next conversation; hook errors until then are normal. `~/.qwen/settings.json` stays as it is: its settings are for all projects on this PC.

No `.qwen/kit/installed.json`? The kit was set up before it kept a record. Tell the user to update the kit first (the same request as the setup), then to ask again.
