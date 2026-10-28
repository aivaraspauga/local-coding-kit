# Remove the kit (for the AI)

Do this only when the user asked to remove the coding kit from the project. Run the command in the project folder.

1. **Run the removal script:** `node .qwen/kit/scripts/remove.mjs`, exactly like this. It does the whole removal:
   - It takes the kit's parts out of `QWEN.md` and `.qwen/settings.json`, keeps the user's own parts, and deletes a file when nothing of the user's is left.
   - It deletes the files the setup added that nobody changed since, `.qwen/kit` and the folders left empty.
   - It deletes the plan folder `.local-agent/` and the kit's lines in `.gitignore` and `.prettierignore`.
   - It names the files it left because they changed: ask the user what to do with them. Do not edit the kit's files by hand.
2. **Report.** Tell the user what the script removed and what it left. The kit's hooks stop in the next conversation; hook errors until then are normal. `~/.qwen/settings.json` stays as it is: its settings are for all projects on this PC.

No `.qwen/kit/installed.json`? The kit was set up before it kept a record. Tell the user to update the kit first (the same request as the setup), then to ask again.
