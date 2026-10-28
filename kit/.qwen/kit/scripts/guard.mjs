// PreToolUse hook (shell, edit, write): blocks or asks before risky actions, whichever model is
// driving. Rules cover bash, cmd and PowerShell spellings.
// The user can lift a block from the chat: it names a short code, and "allow <code>" in the user's
// next message (recorded by reminder.mjs) lets that exact command, or changes to that file, through
// for the rest of the conversation. In Qwen Code's YOLO mode an "ask" reaches no one and works as a
// refusal, so without this an approved deletion could not run at all (2026-10-27).
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CHECK_CONFIGS, output, projectRoot, readInput, readState, writeState } from "./lib/project.mjs";

const input = readInput();
const root = projectRoot();
const kitRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tool = input.tool_name;
const params = input.tool_input ?? {};
const state = readState(root, input.session_id);

// Asked, not denied: the user approves a change they asked for. A headless run cannot approve, so
// an unattended model still cannot change its own guardrails.
const GUARDRAIL_MESSAGE =
  "This changes agent settings, hooks, the kit (.qwen/kit) or the kit's records, the guardrails of this project.";
// Agent settings and hooks anywhere, switches that turn hooks off, and the hooks' own records
// (`local-coding-agent` in the temp folder), where a forged "allow" would go.
const GUARDRAILS = /\.(claude|qwen)[\\/](settings(\.local)?\.json|hooks)|disableAllHooks|local-coding-agent/i;
// Commands that can change files (the shell's, and Node's from `node -e`), and output redirected
// into a guardrail file.
const WRITE_COMMANDS =
  /\b(rm|mv|cp|tee|del|erase|sed\s+-i|Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|New-Item|Rename-Item|git\s+(checkout|restore|rm|mv)|(write|append|copy)FileSync|renameSync|rmSync|unlinkSync|cpSync)\b/i;
const REDIRECT_INTO_GUARDRAIL = />>?\s*["']?[^\s"'|;&]*\.(claude|qwen)[\\/](settings|hooks)/i;
// Writing ignore lines that name a settings file (`.claude/settings.local.json` in .gitignore)
// changes no guardrail: such a write, with its quoted text, is left out of the guardrail test.
// Both Opus kit runs were asked about it (2026-10-24).
const GITIGNORE_WRITE =
  /\b(Add-Content|Set-Content|Out-File)((\s+-(Path|FilePath|Encoding|NoNewline|Force)\b(\s+(utf8|ascii|unicode|utf8NoBOM))?)*)\s+["']?\.gitignore["']?(\s+-Value)?\s+("[^"]*"|'[^']*')|\|\s*tee(\s+-a)?\s+["']?\.gitignore["']?/gi;
// The tool a config belongs to. A new config is free to create (the testing-setup skill writes
// vitest.config.ts and playwright.config.ts) unless the project already has one for that tool,
// because a second file could override the first (vitest.config.ts beats vite.config.ts).
const configFamily = (name) =>
  /^(package|tsconfig|eslint|\.eslintrc|vitest|vite|jest|playwright|\.prettierrc|prettier|\.prettierignore|biome)/
    .exec(name)?.[1]
    .replace(/^\./, "")
    .replace(/^eslintrc$/, "eslint")
    .replace(/^(prettierrc|prettierignore)$/, "prettier")
    .replace(/^vitest$/, "vite");
function hasConfigFor(dir, family) {
  try {
    return readdirSync(dir).some((name) => CHECK_CONFIGS.test(name) && configFamily(name) === family);
  } catch {
    return false;
  }
}

// [pattern, reason, the user can allow it]. A bare sleep and the `@` space are always mistakes with
// a right way named in the message, so no code lifts them.
const DENY = [
  [
    /\bgit\s+push\b.*(\s--force\b|\s--force-with-lease\b|\s-f\b)/,
    "Force-pushing rewrites shared history.",
    true,
  ],
  [/--no-verify\b/, "Skipping git hooks is not allowed.", true],
  [/\b(npm|pnpm|yarn)\s+publish\b/, "Publishing packages is not allowed.", true],
  // A command that only waits. Polling a server (`sleep 5 && curl ...`) is still allowed.
  [
    /^\s*(sleep|Start-Sleep(\s+-(s|Seconds|Milliseconds))?)\s+\d+(\.\d+)?[smh]?\s*;?\s*$/i,
    "A bare sleep only burns time. You are told when a background agent or command finishes. If you need an agent's answer before you can go on, start it in the foreground (run_in_background: false). To wait for a server, poll its URL or output for the ready message.",
  ],
  // Qwen Code puts a space before an `@` joined to a word in the user's message, and the model copies it:
  // `create-next-app @latest`, `--import-alias " @/*"`, `demo @example.com`. A scoped package after a
  // space (`npm i a @scope/b`) is fine and not matched.
  [
    /[\w)\]]\s+@(latest|next|canary|beta|rc|\d[\w.^~-]*)(?![\w/-])|["']\s+@\/|[\w.+-]\s+@[\w-]+\.(com|org|net|io|dev|test|local)\b/i,
    "This command has a space before '@' (Qwen Code adds one to an '@' in the user's message). Write it without the space, for example `create-next-app@latest`, `\"@/*\"`, `demo@example.com`, and run it again.",
  ],
];
// Commands that start a server and never exit on their own.
const DEV_SERVER =
  /(^|&&|\|\||;|\(|\s)((npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start)|(npx\s+)?next\s+(dev|start))(?=\s|$|;|&|\||\))/i;
const ASK = [
  [/\brm\s+(-\w*[rR]\w*|--recursive)\b/, "Recursive delete."],
  [/\bRemove-Item\b.*-Recurse\b/i, "Recursive delete."],
  [/\b(rd|rmdir)\s+\/s\b/i, "Recursive delete."],
  // The same from a script: refused `rmdir /S .claude`, the 27B ran `node -e "fs.rmSync('.claude',{recursive:true})"`.
  [/\b(rmSync|rmdirSync|rm|rmdir)\s*\([^)]*recursive\s*:\s*true|\bshutil\.rmtree\b/, "Recursive delete."],
  [/kit[\\/]scripts[\\/]remove\.mjs\b/i, "Removes the coding kit from this project."],
  [/\bgit\s+reset\s+--hard\b/, "Discards uncommitted work."],
  [/\bgit\s+clean\b.*\s-\w*f/, "Deletes untracked files."],
  [/\bgit\s+(checkout|restore)\b.*\s(--\s+)?\.(\s|$)/, "Discards uncommitted work."],
  [/\bgit\s+branch\s+-D\b/, "Deletes a branch."],
  [/\bgit\s+(push|rebase)\b/, "Changes git history or a remote."],
  [/\b(prisma\s+migrate\s+reset|drizzle-kit\s+drop|DROP\s+(TABLE|DATABASE))\b/i, "Deletes data."],
];

// The kit's own steps, which the asks above would stop for an allow code (an update and a removal
// each needed two, 2026-10-28): the removal script once the user asked to remove the kit
// (reminder.mjs notes it), and deleting the kit's download in the temp folder at the end of a setup
// or update (SETUP-FOR-AI.md step 4), with nothing else in the command.
const REMOVE_KIT = /^\s*node\s+["']?(\.\/)?\.qwen[\\/]kit[\\/]scripts[\\/]remove\.mjs["']?\s*$/i;
const TEMP_VARS = /^(%TEMP%|%TMP%|\$env:TEMP|\$env:TMP|\$TEMP|\$TMPDIR)(?=[\\/])/i;
function deletesOnlyKitDownload(command) {
  const words = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const [verb, ...rest] = words;
  if (!/^(rm|rmdir|rd|Remove-Item)$/i.test(verb ?? "")) return false;
  const paths = rest.filter((word) => !/^(-[\w-]+|\/[a-z])$/i.test(word));
  const download = resolve(tmpdir(), "local-coding-kit").replaceAll("\\", "/").toLowerCase();
  return (
    paths.length > 0 &&
    paths.every((word) => {
      const path = word.replace(/^(["'])(.*)\1$/, "$2");
      // Any other shell syntax (`;`, `&&`, a `$(...)`, a wildcard) makes it something else.
      if (/[;&|<>`*?]|\$(?!env:te?mp|temp|tmpdir)/i.test(path)) return false;
      const full = path.replace(TEMP_VARS, tmpdir()).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
      return full === download || full === "/tmp/local-coding-kit";
    })
  );
}

function decide(decision, reason) {
  output({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  });
  process.exit(0);
}

// A block the user can lift: `key` is the normalized command or `file <path>`. The same key gets
// the same code for the whole conversation, so a retry does not make a new one.
function block(decision, reason, key) {
  if ((state.allowed ?? []).includes(key)) process.exit(0);
  const code = createHash("sha1").update(`${input.session_id ?? "default"}\n${key}`).digest("hex").slice(0, 4);
  writeState(root, input.session_id, { ...state, pending: { ...state.pending, [code]: key } });
  decide(
    decision,
    `${reason} If the user wants this done, ask them to reply "allow ${code}" (it lets this exact ${key.startsWith("file ") ? "file change" : "command"} run in this conversation), then run it again unchanged. Otherwise, do it another way or leave it.`,
  );
}

const insidePlugin = (path) => {
  const rel = relative(kitRoot, path);
  return rel === "" || (!rel.startsWith("..") && !/^[a-z]:/i.test(rel));
};

if (tool === "Bash") {
  const command = String(params.command ?? "");
  const key = command.trim().replace(/\s+/g, " ");
  const pluginPath = kitRoot.replaceAll("\\", "/").toLowerCase();
  const checked = command.replace(GITIGNORE_WRITE, " ");
  const touchesGuardrail =
    GUARDRAILS.test(checked) || checked.replaceAll("\\", "/").toLowerCase().includes(pluginPath);
  if ((touchesGuardrail && WRITE_COMMANDS.test(checked)) || REDIRECT_INTO_GUARDRAIL.test(command)) {
    block("ask", GUARDRAIL_MESSAGE, key);
  }
  for (const [pattern, reason, liftable] of DENY) {
    if (!pattern.test(command)) continue;
    if (liftable) block("deny", reason, key);
    else decide("deny", reason);
  }
  if (DEV_SERVER.test(command) && params.run_in_background !== true) {
    decide(
      "deny",
      "A dev server never exits, so in the foreground it blocks until the command times out. Run it again with is_background: true; its output is kept for you to read. Next.js allows one dev server per project: if one is already running, use it instead of starting another, and stop it when you are done.",
    );
  }
  if ((state.removeKit && REMOVE_KIT.test(command)) || deletesOnlyKitDownload(command)) process.exit(0);
  for (const [pattern, reason] of ASK) if (pattern.test(command)) block("ask", reason, key);
} else if (tool === "Edit" || tool === "Write") {
  const target = resolve(root, String(params.file_path ?? ""));
  const rel = relative(root, target).replaceAll("\\", "/");
  const key = `file ${rel}`;
  if (GUARDRAILS.test(target.replaceAll("\\", "/")) || insidePlugin(target)) {
    block("ask", GUARDRAIL_MESSAGE, key);
  }
  const isNewConfig =
    tool === "Write" && !existsSync(target) && !hasConfigFor(dirname(target), configFamily(rel.split("/").pop()));
  // A config this session made (not there when it started) is the model's own work in progress:
  // the prompt that asked for it often asks for changes to it too. 6 of the 9 asks in the Opus kit
  // runs (2026-10-24) were edits to a playwright.config.ts made minutes before; one run stopped on it.
  const madeThisSession = Boolean(state.startFiles) && !(rel in state.startFiles);
  // A config the user's own message names ("Create vitest.config.ts: React plugin ...") is part of
  // the task. Asked about a vitest.config.ts the prompt described, a run skipped the step (2026-10-27).
  const named = (state.named ?? []).includes(basename(rel).toLowerCase());
  if (CHECK_CONFIGS.test(rel) && !isNewConfig && !madeThisSession && !named) {
    block("ask", `${rel} controls what the project's checks enforce; the user should approve this change.`, key);
  }
}
