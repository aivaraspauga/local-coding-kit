// Tests for the hook scripts, run with `node --test tests/`. They feed each script the JSON a
// hook receives and check what it prints and its exit code. No model is involved.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkCommand, fileSignatures, readState } from "../kit/.qwen/kit/scripts/lib/project.mjs";
import { findRisks } from "../kit/.qwen/kit/scripts/lib/risks.mjs";

const kit = dirname(dirname(fileURLToPath(import.meta.url)));
// The kit as a project gets it: hook scripts and the working style under .qwen/kit.
const kitDir = join(kit, "kit", ".qwen", "kit");
const script = (name) => join(kitDir, "scripts", name);

// Runs a hook as Qwen Code does: JSON on stdin, QWEN_PROJECT_DIR set to the project.
function hook(name, input, { project, env = {} } = {}) {
  const run = spawnSync(process.execPath, [script(name)], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, QWEN_PROJECT_DIR: project ?? tmpdir(), ...env },
  });
  let json = null;
  try {
    json = run.stdout.trim() ? JSON.parse(run.stdout.trim().split("\n").at(-1)) : null;
  } catch {
    // not JSON
  }
  return { code: run.status, json, stdout: run.stdout, stderr: run.stderr };
}

function tempProject(pkg, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lca-test-"));
  if (pkg) writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe("checkCommand", () => {
  test("prefers a check script", () => {
    const dir = tempProject({ scripts: { check: "x", lint: "eslint", test: "vitest" } });
    assert.equal(checkCommand(dir), "npm run check");
  });
  test("chains typecheck, lint and test scripts with the right package manager", () => {
    const dir = tempProject(
      { scripts: { typecheck: "tsc", lint: "eslint", test: "vitest" } },
      { "pnpm-lock.yaml": "" },
    );
    assert.equal(checkCommand(dir), "pnpm run typecheck && pnpm run lint && pnpm run test");
  });
  test("adds tsc (with next typegen for Next.js) when there is no typecheck script", () => {
    const next = tempProject({ scripts: { lint: "eslint" }, dependencies: { next: "16" } }, { "tsconfig.json": "{}" });
    assert.equal(checkCommand(next), "npx next typegen && npx tsc --noEmit && npm run lint");
    // Only the build catches server code in a client component, or a page that cannot prerender.
    const built = tempProject({ scripts: { lint: "eslint", test: "vitest run", build: "next build" }, dependencies: { next: "16" } }, { "tsconfig.json": "{}" });
    assert.equal(checkCommand(built), "npx next typegen && npx tsc --noEmit && npm run lint && npm run test && npm run build");
    const plain = tempProject({ scripts: {} }, { "tsconfig.json": "{}" });
    assert.equal(checkCommand(plain), "npx tsc --noEmit");
  });
  test("builds Angular projects and runs create-vue's test:unit once", () => {
    const angular = tempProject({ scripts: { test: "ng test" } }, { "angular.json": "{}", "tsconfig.json": "{}" });
    assert.equal(checkCommand(angular), "npx ng build --configuration development && npm run test");
    const vue = tempProject({ scripts: { "type-check": "vue-tsc --build", lint: "eslint .", "test:unit": "vitest" } });
    assert.equal(checkCommand(vue), "npm run type-check && npm run lint && npm run test:unit -- --run");
    const jest = tempProject({ scripts: { "test:unit": "jest" } });
    assert.equal(checkCommand(jest), "npm run test:unit");
    const nuxt = tempProject({ scripts: { build: "nuxt build" }, dependencies: { nuxt: "4.5.2" } }, { "tsconfig.json": "{}" });
    assert.equal(checkCommand(nuxt), "npx nuxi typecheck");
  });
  test("ignores npm's placeholder test script and projects without a manifest", () => {
    const dir = tempProject({ scripts: { test: 'echo "Error: no test specified" && exit 1' } });
    assert.equal(checkCommand(dir), null);
    assert.equal(checkCommand(tempProject(null)), null);
  });
});

describe("fileSignatures", () => {
  test("skips build caches, so the Stop hook doesn't call them the model's leftovers", () => {
    const files = {};
    for (const dir of [".next", ".angular", ".nuxt", ".output", "node_modules", "test-results"]) files[`${dir}/cache/x.js`] = "x";
    const signatures = fileSignatures(tempProject({ name: "app" }, { ...files, "src/app.ts": "x" }));
    assert.deepEqual(Object.keys(signatures).sort(), ["package.json", "src/app.ts"]);
  });
});

describe("guard", () => {
  const project = tempProject({ scripts: {} });
  // "rewrite": the call runs with corrected input (updatedInput) instead of being refused.
  const decide = (tool_name, tool_input) => {
    const out = hook("guard.mjs", { tool_name, tool_input }, { project }).json?.hookSpecificOutput;
    return out?.permissionDecision ?? (out?.updatedInput ? "rewrite" : "allow");
  };
  const cases = [
    ["Bash", { command: "git push --force origin main" }, "deny"],
    ["Bash", { command: "git commit -m x --no-verify" }, "deny"],
    ["Bash", { command: "pnpm publish" }, "deny"],
    // Guardrails ask the user (a prompt in a session; refused in a headless run).
    ["Bash", { command: "echo '{}' > .claude/settings.json" }, "ask"],
    ["Bash", { command: `echo '{"disableAllHooks":true}' > ~/.claude/settings.json` }, "ask"],
    ["run_shell_command", { command: "Set-Content .claude\\hooks\\x.mjs 'x'" }, "ask"],
    ["Bash", { command: `rm ${kitDir.replaceAll("\\", "/")}/scripts/guard.mjs` }, "ask"],
    ["Edit", { file_path: join(project, ".claude", "settings.local.json") }, "ask"],
    ["Edit", { file_path: join(kitDir, "scripts", "stop-check.mjs") }, "ask"],
    ["Bash", { command: "sleep 30" }, "deny"],
    ["run_shell_command", { command: "Start-Sleep -Seconds 60" }, "deny"],
    ["Bash", { command: "npm run dev" }, "rewrite"],
    ["Bash", { command: 'cd "C:/app" && npm run dev > /tmp/dev.log 2>&1 &' }, "rewrite"],
    ["run_shell_command", { command: "npx next dev --port 3123" }, "rewrite"],
    ["Bash", { command: "pnpm start" }, "rewrite"],
    ["Bash", { command: "rm -rf node_modules" }, "ask"],
    ["run_shell_command", { command: "Remove-Item dist -Recurse -Force" }, "ask"],
    ["run_shell_command", { command: `node -e "fs=require('fs');fs.rmSync('.claude',{recursive:true,force:true})"` }, "ask"],
    ["Bash", { command: `python -c "import shutil; shutil.rmtree('data')"` }, "ask"],
    ["Bash", { command: `node -e "require('fs').rmSync('data/demo.db',{force:true})"` }, "allow"],
    ["run_shell_command", { command: "node .qwen/kit/scripts/remove.mjs" }, "ask"],
    ["Bash", { command: "git reset --hard HEAD~1" }, "ask"],
    ["Bash", { command: "npx prisma migrate reset" }, "ask"],
    ["Edit", { file_path: join(project, "package.json") }, "ask"],
    ["Edit", { file_path: join(project, "vitest.config.ts") }, "ask"],
    ["Edit", { file_path: join(project, "tsconfig.app.json") }, "ask"],
    ["Bash", { command: "cat .claude/settings.json 2>&1 | head" }, "allow"],
    ["Bash", { command: `node -e 'console.log("->")' .claude/settings.json` }, "allow"],
    ["Bash", { command: "npm run build > build.log 2>&1" }, "allow"],
    ["Bash", { command: "rm src/old.ts" }, "allow"],
    ["Bash", { command: "sleep 5 && curl -s http://localhost:3000" }, "allow"],
    ["Bash", { command: "PORT=3123 npm run dev", run_in_background: true }, "allow"],
    ["Bash", { command: "npm run dev:db && npm run build" }, "allow"],
    ["Bash", { command: "npm run test:e2e" }, "allow"],
    ["Bash", { command: "npm run start-docs-index" }, "allow"],
    ["Edit", { file_path: join(project, "src", "app", "page.tsx") }, "allow"],
    ["Edit", { file_path: join(project, "src", "package.json") }, "allow"],
    // Qwen Code's tool ids and its shell's is_background.
    ["run_shell_command", { command: "git push --force origin main" }, "deny"],
    ["run_shell_command", { command: "npm run dev" }, "rewrite"],
    ["run_shell_command", { command: "npm run dev", is_background: true }, "allow"],
    ["run_shell_command", { command: "echo '{}' > .qwen/settings.json" }, "ask"],
    ["write_file", { file_path: join(project, ".qwen", "settings.json") }, "ask"],
    ["edit", { file_path: join(project, "package.json") }, "ask"],
    ["edit", { file_path: join(project, "src", "app", "page.tsx") }, "allow"],
    // The space Qwen Code puts before '@' in the user's message, copied into a command.
    ["run_shell_command", { command: 'npx create-next-app @latest . --ts --import-alias "@/*" --yes' }, "rewrite"],
    ["run_shell_command", { command: 'npx create-next-app@latest . --ts --import-alias " @/*" --yes' }, "rewrite"],
    ["run_shell_command", { command: "npm install better-auth @1.7.12" }, "rewrite"],
    ["Bash", { command: "curl -d 'email=demo @example.com' localhost:3000/login" }, "rewrite"],
    ["run_shell_command", { command: 'npx create-next-app@latest . --ts --import-alias "@/*" --yes' }, "allow"],
    ["run_shell_command", { command: "npm install better-auth @better-auth/libsql @libsql/client" }, "allow"],
    ["run_shell_command", { command: "npm i -D @types/node@latest @next/env" }, "allow"],
    ["Bash", { command: "git log --author=demo@example.com" }, "allow"],
    // Ignore lines naming a settings file are not a guardrail change.
    ["run_shell_command", { command: 'Add-Content -Encoding utf8 .gitignore "`n# kit`n.claude/settings.local.json`n.local-agent/"' }, "allow"],
    ["run_shell_command", { command: 'npm pkg set "scripts.test=vitest run"; Add-Content -Path .gitignore -Value ".claude/settings.local.json"; npm test' }, "allow"],
    ["Bash", { command: "printf '.claude/settings.local.json\\n.local-agent/\\n' | tee -a .gitignore" }, "allow"],
    ["run_shell_command", { command: 'Add-Content .gitignore "x"; Set-Content .claude/settings.json "{}"' }, "ask"],
    ["run_shell_command", { command: '$f = ".claude/settings.json"; Set-Content $f "{}"' }, "ask"],
    // Node's own file writes count too, and the hooks' records (where a forged "allow" would go) are a guardrail.
    ["run_shell_command", { command: `node -e "require('fs').writeFileSync('.qwen/settings.json','{}')"` }, "ask"],
    ["run_shell_command", { command: `node -e "require('fs').writeFileSync(require('os').tmpdir()+'/local-coding-agent/x.json','{}')"` }, "ask"],
    ["run_shell_command", { command: `node -e "require('fs').writeFileSync('notes.txt','x')"` }, "allow"],
    // The kit's download in the temp folder, deleted at the end of a setup or update, and nothing more.
    ["run_shell_command", { command: 'Remove-Item -Recurse -Force "$env:TEMP\\local-coding-kit"' }, "allow"],
    ["run_shell_command", { command: "rmdir /s /q %TEMP%\\local-coding-kit" }, "allow"],
    ["run_shell_command", { command: `rd /s /q "${join(tmpdir(), "local-coding-kit")}\\"` }, "allow"],
    ["Bash", { command: "rm -rf /tmp/local-coding-kit" }, "allow"],
    ["Bash", { command: "rm -rf /tmp/local-coding-kit src" }, "ask"],
    ["Bash", { command: "rm -rf /tmp/local-coding-kit && rm -rf src" }, "ask"],
    ["Bash", { command: "rm -rf /tmp/local-coding-kit/../.." }, "ask"],
    ["Bash", { command: "rm -rf /tmp/local-coding-kit*" }, "ask"],
    ["Bash", { command: "rm -rf local-coding-kit" }, "ask"],
  ];
  for (const [tool, params, want] of cases) {
    test(`${want}: ${tool} ${params.command ?? params.file_path}`, () => {
      assert.equal(decide(tool, params), want);
    });
  }
  test("a rewritten call keeps Qwen's own parameter names and gets the corrected command", () => {
    const rewritten = (tool_input) =>
      hook("guard.mjs", { tool_name: "run_shell_command", tool_input }, { project }).json?.hookSpecificOutput;
    const dev = rewritten({ command: "npm run dev", description: "Start the app" });
    assert.deepEqual(dev.updatedInput, { command: "npm run dev", description: "Start the app", is_background: true });
    assert.match(dev.additionalContext, /in the background/);
    const at = rewritten({ command: 'npx create-next-app @latest . --import-alias " @/*" --yes', is_background: false });
    assert.deepEqual(at.updatedInput, { command: 'npx create-next-app@latest . --import-alias "@/*" --yes', is_background: false });
    assert.match(at.additionalContext, /took out the space before '@'/);
    assert.equal(rewritten({ command: "npm install better-auth @1.7.12" }).updatedInput.command, "npm install better-auth@1.7.12");
    assert.equal(rewritten({ command: "curl -d 'email=demo @example.com' x" }).updatedInput.command, "curl -d 'email=demo@example.com' x");
    // A corrected command still meets every other rule: a recursive delete in it still asks.
    assert.equal(rewritten({ command: "rm -rf build && npx create-next-app @latest ." }).permissionDecision, "ask");
  });
  test("a package.json change that leaves the check scripts alone goes through; one that changes them asks", () => {
    const pkg = { name: "app", scripts: { dev: "next dev", lint: "eslint", test: "vitest run" }, dependencies: { next: "16.0.0" } };
    const dir = tempProject(null, { "package.json": `${JSON.stringify(pkg, null, 2)}\n` });
    const text = readFileSync(join(dir, "package.json"), "utf8");
    const decideIn = (tool_name, tool_input) =>
      hook("guard.mjs", { tool_name, tool_input: { file_path: join(dir, "package.json"), ...tool_input } }, { project: dir }).json
        ?.hookSpecificOutput?.permissionDecision ?? "allow";
    const edit = (from, to) => decideIn("edit", { old_string: from, new_string: to });
    assert.equal(edit('"next": "16.0.0"', '"next": "16.0.0",\n    "zod": "4.1.0"'), "allow", "a dependency");
    assert.equal(edit('"dev": "next dev"', '"dev": "next dev --turbopack"'), "allow", "a script that is not a check");
    assert.equal(edit('"dev": "next dev"', '"dev": "next dev",\n    "test:e2e": "playwright test"'), "allow", "a script the checks don't run");
    assert.equal(edit('"dev": "next dev"', '"dev": "next dev",\n    "check": "echo ok"'), "ask", "a new check script");
    assert.equal(edit('"test": "vitest run"', '"test": "vitest run --passWithNoTests"'), "ask", "a weaker test script");
    assert.equal(edit('"lint": "eslint",', ""), "ask", "a check script removed");
    assert.equal(decideIn("edit", {}), "ask", "unsure what it changes");
    const rewrite = (change) => decideIn("write_file", { content: JSON.stringify({ ...pkg, ...change }, null, 2) });
    assert.equal(rewrite({ version: "1.0.0" }), "allow");
    assert.equal(rewrite({ scripts: { ...pkg.scripts, lint: "echo ok" } }), "ask");
    assert.equal(decideIn("write_file", { content: "not json" }), "ask");
    assert.equal(text, readFileSync(join(dir, "package.json"), "utf8"), "the guard only reads");
  });
  test("a new check config is free to create, unless one for the same tool exists", () => {
    const fresh = tempProject({ scripts: {} });
    const decideIn = (dir, tool_name, file) =>
      hook("guard.mjs", { tool_name, tool_input: { file_path: join(dir, file) } }, { project: dir }).json?.hookSpecificOutput
        ?.permissionDecision ?? "allow";
    assert.equal(decideIn(fresh, "Write", "vitest.config.ts"), "allow");
    assert.equal(decideIn(fresh, "write_file", "playwright.config.ts"), "allow");
    assert.equal(decideIn(fresh, "Write", "package.json"), "ask", "overwriting an existing config");
    const withVite = tempProject({ scripts: {} }, { "vite.config.ts": "export default {};\n" });
    assert.equal(decideIn(withVite, "Write", "vitest.config.ts"), "ask", "it would override vite.config.ts");
  });
  test("a check config made in this session is free to change; one from before still asks", () => {
    const dir = tempProject({ scripts: {} }, { "vitest.config.ts": "export default {};\n" });
    hook("session-start.mjs", { source: "startup" }, { project: dir });
    writeFileSync(join(dir, "playwright.config.ts"), "export default {};\n");
    const decideIn = (tool_name, file) =>
      hook("guard.mjs", { tool_name, tool_input: { file_path: join(dir, file) } }, { project: dir }).json?.hookSpecificOutput
        ?.permissionDecision ?? "allow";
    assert.equal(decideIn("Edit", "playwright.config.ts"), "allow", "made after the session started");
    assert.equal(decideIn("Edit", "vitest.config.ts"), "ask", "there when the session started");
    assert.equal(decideIn("Edit", "package.json"), "ask", "there when the session started");
  });
  test("a check config the user's message names is free to change; others still ask", () => {
    const dir = tempProject({ scripts: {} }, { "vitest.config.ts": "export default {};\n" });
    const session = `named-${process.pid}-${Date.now()}`;
    hook("session-start.mjs", { session_id: session, source: "startup" }, { project: dir });
    const decideIn = (file) =>
      hook("guard.mjs", { session_id: session, tool_name: "edit", tool_input: { file_path: join(dir, file) } }, { project: dir }).json
        ?.hookSpecificOutput?.permissionDecision ?? "allow";
    assert.equal(decideIn("vitest.config.ts"), "ask");
    hook("reminder.mjs", { session_id: session, prompt: 'Create vitest.config.ts: React plugin, environment "jsdom".' }, { project: dir });
    assert.equal(decideIn("vitest.config.ts"), "allow", "the user's message names it");
    assert.equal(decideIn("package.json"), "ask", "not named");
  });
  test("the user lifts a block with its code: that command only, in that conversation only", () => {
    const dir = tempProject({ scripts: {} });
    const session = `allow-${process.pid}-${Date.now()}`;
    const guard = (command, id = session) =>
      hook("guard.mjs", { session_id: id, tool_name: "run_shell_command", tool_input: { command } }, { project: dir }).json?.hookSpecificOutput;
    const blocked = guard("rmdir /s /q build");
    assert.equal(blocked.permissionDecision, "ask");
    const code = /reply "allow ([0-9a-f]{4})"/.exec(blocked.permissionDecisionReason)?.[1];
    assert.ok(code, blocked.permissionDecisionReason);
    assert.ok(guard("rmdir /s /q build").permissionDecisionReason.includes(code), "a retry gets the same code");
    const reminder = hook("reminder.mjs", { session_id: session, prompt: `yes, allow ${code}` }, { project: dir });
    assert.match(reminder.json.hookSpecificOutput.additionalContext, /The user allowed this .*`rmdir \/s \/q build`\. Run it again unchanged/);
    assert.equal(guard("rmdir /s /q build"), undefined, "allowed now");
    assert.equal(guard("rmdir  /s /q   build"), undefined, "spacing does not matter");
    assert.equal(guard("rmdir /s /q src").permissionDecision, "ask", "another command still asks");
    assert.equal(guard("rmdir /s /q build", `${session}-other`).permissionDecision, "ask", "another conversation still asks");
    // A code the guard never gave allows nothing.
    hook("reminder.mjs", { session_id: session, prompt: "allow 0000" }, { project: dir });
    assert.equal(guard("git reset --hard").permissionDecision, "ask");
    // Force-pushing can be allowed; a bare sleep has a right way and no code.
    assert.match(guard("git push --force origin main").permissionDecisionReason, /reply "allow [0-9a-f]{4}"/);
    assert.doesNotMatch(guard("sleep 30").permissionDecisionReason, /allow/);
    // Files: a config edit, lifted the same way.
    writeFileSync(join(dir, "tsconfig.json"), "{}\n");
    const edit = () =>
      hook("guard.mjs", { session_id: session, tool_name: "edit", tool_input: { file_path: join(dir, "tsconfig.json") } }, { project: dir }).json?.hookSpecificOutput;
    const fileCode = /allow ([0-9a-f]{4})/.exec(edit().permissionDecisionReason)[1];
    hook("reminder.mjs", { session_id: session, prompt: `allow ${fileCode}` }, { project: dir });
    assert.equal(edit(), undefined);
  });
  test("the kit's removal script runs without a code once the user asked to remove the kit", () => {
    // A removal stopped twice for allow codes: the settings edit and remove.mjs (2026-10-28).
    const dir = tempProject({ scripts: {} });
    const session = `remove-${process.pid}-${Date.now()}`;
    const guard = (command, id = session) =>
      hook("guard.mjs", { session_id: id, tool_name: "run_shell_command", tool_input: { command } }, { project: dir }).json
        ?.hookSpecificOutput?.permissionDecision ?? "allow";
    assert.equal(guard("node .qwen/kit/scripts/remove.mjs"), "ask", "nobody asked yet");
    hook("reminder.mjs", { session_id: session, prompt: "Fix the delete button on the task page." }, { project: dir });
    assert.equal(guard("node .qwen/kit/scripts/remove.mjs"), "ask", "a message about something else");
    hook("reminder.mjs", { session_id: session, prompt: "Remove the coding kit from this project." }, { project: dir });
    assert.equal(guard("node .qwen/kit/scripts/remove.mjs"), "allow");
    hook("reminder.mjs", { session_id: session, prompt: "Keep it" }, { project: dir });
    assert.equal(guard("node .qwen/kit/scripts/remove.mjs"), "allow", "for the rest of the conversation");
    assert.equal(guard("node .qwen/kit/scripts/remove.mjs && rm -rf src"), "ask", "nothing more in the command");
    assert.equal(guard("node .qwen/kit/scripts/remove.mjs", `${session}-other`), "ask", "another conversation");
  });
  test("turns the reviewer away on a small change, not on a bigger or risky one", () => {
    // The file sets of the 2026-10-28 kit runs: the list-order fix (reviewer 5.9 min, nothing found),
    // the clear-finished button (new route) and the create-project form (reviewer found 4 defects).
    const files = {
      "src/components/task-list.tsx": "a\n",
      "src/server/tasks.ts": "a\n",
      "src/server/projects.ts": "a\n",
      "src/app/page.tsx": "a\n",
      "tests/components/task-list.test.tsx": "a\n",
    };
    const run = (change, { prompt, agent = "reviewer", start = true } = {}) => {
      const dir = tempProject({ scripts: {} }, files);
      const session = `size-${process.pid}-${Math.random()}`;
      if (start) hook("session-start.mjs", { session_id: session, source: "startup" }, { project: dir, env: { LOCAL_AGENT_OFFLINE: "1" } });
      if (prompt) hook("reminder.mjs", { session_id: session, prompt }, { project: dir });
      for (const [path, text] of Object.entries(change)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
      }
      const out = hook("guard.mjs", { session_id: session, tool_name: "agent", tool_input: { subagent_type: agent, description: "Review", prompt: "Review it" } }, { project: dir });
      return out.json?.hookSpecificOutput ?? { permissionDecision: "allow" };
    };
    const listOrder = { "src/components/task-list.tsx": "b\n", "src/lib/task-order.ts": "b\n", "tests/components/task-list.test.tsx": "b\n", "e2e/projects.spec.ts": "b\n" };
    const denied = run(listOrder);
    assert.equal(denied.permissionDecision, "deny");
    assert.match(denied.permissionDecisionReason, /small \(src\/components\/task-list\.tsx, src\/lib\/task-order\.ts\)/);
    assert.equal(run({ "src/app/page.tsx": "b\n" }).permissionDecision, "deny", "one UI file");
    const clearFinished = { "src/app/api/projects/[id]/tasks/finished/route.ts": "b\n", "src/components/task-list.tsx": "b\n" };
    assert.equal(run(clearFinished).permissionDecision, "allow", "a new API route");
    assert.equal(run({ "src/server/tasks.ts": "b\n" }).permissionDecision, "allow", "server code");
    assert.equal(run({ "package.json": "{}" }).permissionDecision, "allow", "a dependency change");
    const createProject = { "src/app/page.tsx": "b\n", "src/components/project-list.tsx": "b\n", "src/lib/names.ts": "b\n" };
    assert.equal(run(createProject).permissionDecision, "allow", "3 code files");
    assert.equal(run(listOrder, { prompt: "Fix the order, then have the reviewer look at it." }).permissionDecision, "allow", "the user asked for a review");
    assert.equal(run(listOrder, { agent: "explorer" }).permissionDecision, "allow", "other helpers");
    assert.equal(run(listOrder, { start: false }).permissionDecision, "allow", "no session start: size unknown");
  });
  test("a refused call in a parallel batch is said again on the next result, or by the Stop hook", () => {
    const project = tempProject({ scripts: { check: "node -e process.exit(0)" } });
    const session_id = `refused-${process.pid}-${Date.now()}`;
    const guard = (tool_name, tool_input) => hook("guard.mjs", { session_id, tool_name, tool_input }, { project }).json?.hookSpecificOutput;
    const after = (command) =>
      hook("focus.mjs", { session_id, hook_event_name: "PostToolUse", tool_name: "run_shell_command", tool_input: { command }, tool_response: { stdout: "", stderr: "" } }, { project })
        .json?.hookSpecificOutput?.additionalContext ?? "";
    // One batch: a write, a bare sleep (refused), then a check that passes.
    assert.equal(guard("write_file", { file_path: join(project, "src/a.ts") }), undefined);
    assert.equal(guard("run_shell_command", { command: "sleep 30" }).permissionDecision, "deny");
    const note = after("npm run check");
    assert.match(note, /^NOT DONE: the kit refused this call/);
    assert.match(note, /- run_shell_command `sleep 30`: A bare sleep only burns time/);
    assert.doesNotMatch(after("npm run check"), /NOT DONE/, "said once");
    // The last call of a turn refused: nothing comes after it but the Stop hook.
    assert.equal(guard("run_shell_command", { command: "sleep 30" }).permissionDecision, "deny");
    const stop = hook("stop-check.mjs", { session_id }, { project });
    assert.equal(stop.code, 2);
    assert.match(stop.stderr, /NOT DONE: the kit refused this call/);
    assert.notEqual(hook("stop-check.mjs", { session_id }, { project }).stderr.includes("NOT DONE"), true, "said once");
    // A helper agent's refusals stay with the helper.
    guard("run_shell_command", { command: "sleep 30" });
    const helper = hook("focus.mjs", { session_id, agent_id: "tester-1", hook_event_name: "PostToolUse", tool_name: "run_shell_command", tool_input: { command: "ls" }, tool_response: { stdout: "" } }, { project });
    assert.doesNotMatch(helper.json?.hookSpecificOutput?.additionalContext ?? "", /NOT DONE/);
    assert.match(after("ls"), /NOT DONE/);
  });
  test("never holds a write, and reminds once after a 4th code file with no check run (small steps)", () => {
    const project = tempProject({ scripts: { typecheck: "tsc --noEmit", test: "vitest run" } }, { "tsconfig.json": "{}" });
    const session_id = `steps-${process.pid}-${Date.now()}`;
    const edited = (path, root = project) =>
      hook("focus.mjs", { session_id, hook_event_name: "PostToolUse", tool_name: "edit", tool_input: { file_path: join(root, path) } }, { project: root }).json
        ?.hookSpecificOutput?.additionalContext ?? "";
    const ran = (command, event = "PostToolUse") =>
      hook("focus.mjs", { session_id, hook_event_name: event, tool_name: "run_shell_command", tool_input: { command }, tool_response: { stdout: "", stderr: "" } }, { project });
    const decide = (path) =>
      hook("guard.mjs", { session_id, tool_name: "write_file", tool_input: { file_path: join(project, path) } }, { project }).json
        ?.hookSpecificOutput ?? { permissionDecision: "allow" };
    for (const path of ["src/a.ts", "src/b.tsx", "src/app/api/x/route.ts"]) {
      assert.equal(decide(path).permissionDecision, "allow", path);
      assert.doesNotMatch(edited(path), /small steps/i, path);
    }
    assert.equal(decide("src/d.ts").permissionDecision, "allow", "a 4th file is written, not held");
    const note = edited("src/d.ts");
    assert.match(note, /src\/a\.ts, src\/b\.tsx, src\/app\/api\/x\/route\.ts, src\/d\.ts and run no check/);
    assert.match(note, /npm run typecheck/);
    assert.doesNotMatch(edited("src/e.ts"), /small steps/i, "once per list, not after every file");
    assert.doesNotMatch(edited("tests/a.test.ts"), /small steps/i, "a test");
    ran("git status");
    assert.doesNotMatch(edited("src/f.ts"), /small steps/i, "still the same list: git status is not a check");
    ran("npm run typecheck", "PostToolUseFailure");
    for (const path of ["src/a.ts", "src/b.ts", "src/c.ts"]) assert.doesNotMatch(edited(path), /small steps/i, path);
    assert.match(edited("src/d.ts"), /small steps/i, "a check run (failing too) starts a new list");
    const bare = tempProject(null);
    for (const path of ["a.js", "b.js", "c.js", "d.js"]) {
      assert.doesNotMatch(edited(path, bare), /small steps/i, "a project with nothing to run");
    }
  });
});

describe("focus", () => {
  const session = `test-${process.pid}-${Date.now()}`;
  const call = (tool_name, tool_input) =>
    hook("focus.mjs", { session_id: session, tool_name, tool_input }).json?.hookSpecificOutput?.additionalContext ?? "";

  test("nudges after 12 look-ups in a row, and an edit resets the count", () => {
    for (let i = 1; i < 12; i++) assert.equal(call("Read", { file_path: `src/f${i}.ts` }), "");
    assert.match(call("Grep", { pattern: "foo" }), /12 look-ups in a row/);
    assert.equal(call("Edit", { file_path: "src/a.ts" }), "");
    assert.equal(call("Read", { file_path: "src/b.ts" }), "");
  });
  test("nudges on compiled dependency code but not on docs or types", () => {
    const s = `${session}-dep`;
    const dep = (tool_name, tool_input) =>
      hook("focus.mjs", { session_id: s, tool_name, tool_input }).json?.hookSpecificOutput?.additionalContext ?? "";
    assert.equal(dep("Read", { file_path: "node_modules/next/dist/docs/01-app/forms.md" }), "");
    assert.equal(dep("Read", { file_path: "node_modules/@base-ui/react/button/Button.d.ts" }), "");
    assert.equal(dep("Read", { file_path: "node_modules/react-dom/cjs/react-dom-client.development.js" }), "");
    assert.equal(dep("Bash", { command: "grep -n onClick node_modules/@base-ui/react/button/Button.mjs" }), "");
    assert.match(dep("Grep", { pattern: "x", path: "node_modules/tailwindcss/dist/lib.js" }), /compiled dependency code 3 times/);
  });
  test("nudges after 5 web searches or page reads in a row, and acting resets the count", () => {
    const s = `${session}-web`;
    const web = (tool_name, tool_input) =>
      hook("focus.mjs", { session_id: s, tool_name, tool_input }).json?.hookSpecificOutput?.additionalContext ?? "";
    for (let i = 1; i < 5; i++) assert.equal(web("mcp__searxng__searxng_web_search", { query: `next.js params ${i}` }), "");
    assert.match(web("mcp__searxng__web_url_read", { url: "https://nextjs.org/docs" }), /searched or read the web 5 times/);
    assert.equal(web("Bash", { command: "npm test" }), "");
    assert.equal(web("WebFetch", { url: "https://example.com" }), "");
  });
  test("inside a subagent: no look-up nudges, but dependency-code nudges still apply", () => {
    const s = `${session}-agent`;
    const sub = (tool_name, tool_input) =>
      hook("focus.mjs", { session_id: s, agent_id: "explorer-1", tool_name, tool_input }).json?.hookSpecificOutput?.additionalContext ?? "";
    for (let i = 0; i < 25; i++) assert.equal(sub("Read", { file_path: `src/f${i}.ts` }), "");
    sub("Read", { file_path: "node_modules/a/dist/x.js" });
    sub("Read", { file_path: "node_modules/a/dist/y.js" });
    assert.match(sub("Read", { file_path: "node_modules/a/dist/z.js" }), /compiled dependency code 3 times/);
  });
  test("names the fix for a known error once, from a failed call or a piped run's output", () => {
    const s = `${session}-known`;
    const run = (event, command, result, tool_name = "Bash") =>
      hook("focus.mjs", {
        session_id: s,
        hook_event_name: event,
        tool_name,
        tool_input: { command },
        ...(event === "PostToolUseFailure" ? { error: result, is_interrupt: false } : { tool_response: { stdout: result, stderr: "" } }),
      }).json?.hookSpecificOutput?.additionalContext ?? "";
    const eresolve = "Exit code 1\nnpm error code ERESOLVE\nnpm error While resolving: vitest@5.0.5\nnpm error Found: @types/node@20.19.43";
    assert.match(run("PostToolUseFailure", "npm install -D vitest jsdom", eresolve, "run_shell_command"), /@types\/node@<your Node major>/);
    assert.doesNotMatch(run("PostToolUseFailure", "npm install -D vitest jsdom", eresolve, "run_shell_command"), /ERESOLVE/, "once per session");
    assert.match(
      run("PostToolUseFailure", "npx create-next-app@latest . --yes", "The directory app contains files that could conflict: .qwen/ CLAUDE.md"),
      /new subfolder name NAME instead of `\.`/,
    );
    const strict = "Error: strict mode violation: getByLabel('Workshop') resolved to 2 elements:\n  1) <section aria-labelledby=\"workshops-heading\">";
    assert.match(run("PostToolUse", "npm run test:e2e 2>&1 | Select-String -NotMatch NO_COLOR", strict), /\{ exact: true \}/);
    assert.match(run("PostToolUseFailure", "npx playwright test", "Error: strict mode violation: getByRole('alert') resolved to 2 elements"), /filter\(\{ hasText/);
    assert.match(
      run("PostToolUseFailure", "npx tsc --noEmit", `src/app/demo-admin/layout.tsx(8,67): error TS2344: Type '"/demo-admin"' does not satisfy the constraint '"/"'.`),
      /npx next typegen/,
    );
    assert.equal(run("PostToolUseFailure", "npx tsc --noEmit", "error TS2344: Type 'Foo' does not satisfy the constraint 'Bar'."), "", "only route types");
    // A generated validator left pointing at a deleted route (seen 2026-10-28 after a branch switch).
    assert.match(
      run("PostToolUseFailure", "npm run typecheck", `.next/dev/types/validator.ts(3,39): error TS2307: Cannot find module '../../../src/app/api/projects/[id]/tasks/finished/route.js' or its corresponding type declarations.`),
      /Delete that one file/,
    );
    assert.equal(run("PostToolUseFailure", "npx tsc --noEmit", "src/a.ts(1,1): error TS2307: Cannot find module 'left-pad'."), "", "only generated files");
    assert.match(run("PostToolUseFailure", "npm run dev", "Error: listen EADDRINUSE: address already in use :::3000"), /free port/);
    assert.match(
      run("PostToolUseFailure", "npm install recharts", "npm error code ERESOLVE\nnpm error Could not resolve dependency:\nnpm error peer react@\"^16.8.0 || ^17 || ^18\" from some-chart@1.2.0"),
      /npm view <package> peerDependencies/,
    );
    assert.match(run("PostToolUseFailure", "npm install bcrypt", "gyp ERR! find VS could not find a version of Visual Studio 2017 or newer to use"), /bcryptjs/);
  });
  test("tells a new project with only the kit's files to generate the app in a subfolder", () => {
    const empty = tempProject(null, { "QWEN.md": "kit\n", ".qwen/settings.json": "{}", ".gitignore": ".local-agent/\n" });
    const start = (dir) => hook("session-start.mjs", { source: "startup" }, { project: dir, env: { LOCAL_AGENT_OFFLINE: "1" } }).json?.hookSpecificOutput?.additionalContext ?? "";
    assert.match(start(empty), /no app yet[\s\S]*create-next-app@latest NAME[\s\S]*renameSync/);
    assert.doesNotMatch(start(tempProject({ scripts: {} })), /no app yet/);
    assert.doesNotMatch(start(tempProject(null, { "QWEN.md": "kit\n", "index.html": "<p>x</p>" })), /no app yet/, "the user's own files");
  });
  test("nudges after 4 failing test runs, counting piped runs by their output; a full pass resets", () => {
    const s = `${session}-fail`;
    const run = (event, command, result) =>
      hook("focus.mjs", {
        session_id: s,
        hook_event_name: event,
        tool_name: "Bash",
        tool_input: { command },
        ...(event === "PostToolUseFailure" ? { error: result, is_interrupt: false } : { tool_response: { stdout: result, stderr: "" } }),
      }).json?.hookSpecificOutput ?? {};
    assert.equal(run("PostToolUse", "npm run check 2>&1 | tail -5", "Tests  9 passed").additionalContext, undefined, "a passing piped run is fine");
    assert.equal(run("PostToolUseFailure", "npm run test", "Exit code 1\n 1 failed").additionalContext, undefined);
    assert.match(run("PostToolUse", "npx playwright test 2>&1 | tail -25", "1 failed, 1 passed").additionalContext, /pipe .* made it exit 0/);
    // A run limited to one test passing does not mean the suite passes.
    assert.equal(run("PostToolUse", "npx playwright test debug", "1 passed").additionalContext, undefined);
    assert.equal(run("PostToolUse", "npx playwright test 2>&1 | tail -25", "1 failed").additionalContext, undefined);
    const fourth = run("PostToolUseFailure", "npm run typecheck", "Exit code 2\nerror TS2339: Property 'getByLabel' does not exist");
    assert.equal(fourth.hookEventName, "PostToolUseFailure");
    assert.match(fourth.additionalContext, /failed 4 times since they last passed in full/);
    assert.equal(run("PostToolUse", "npm run test", "Tests  9 passed").additionalContext, undefined);
    for (let i = 0; i < 3; i++) assert.equal(run("PostToolUseFailure", "npm test", "Exit code 1").additionalContext, undefined);
  });
  test("nudges once on a long thought, and names drafted code", () => {
    const s = `${session}-think`;
    const transcript = join(tempProject(null), "session.jsonl");
    // Qwen Code's transcript: Gemini-style parts, thinking marked `thought`.
    const step = (id, thinking) =>
      writeFileSync(transcript, JSON.stringify({ type: "assistant", uuid: id, message: { role: "model", parts: [{ text: thinking, thought: true }, { functionCall: { name: "read_file" } }] } }) + "\n", { flag: "a" });
    const read = () => hook("focus.mjs", { session_id: s, tool_name: "Read", tool_input: { file_path: "a" }, transcript_path: transcript }).json?.hookSpecificOutput?.additionalContext ?? "";
    step("m1", "short");
    assert.equal(read(), "");
    step("m2", "Should the row type be string or a union? ".repeat(250));
    assert.match(read(), /about 2600 tokens of thinking\. .*copying what nearby code does/);
    assert.equal(read(), "", "once per message");
    step("m3", "Let me write it:\n" + "const a = 1;\nreturn a;\n".repeat(400));
    assert.match(read(), /lines of it code/);
    assert.equal(hook("focus.mjs", { session_id: `${s}-none`, tool_name: "Read", tool_input: { file_path: "a" }, transcript_path: join(tmpdir(), "missing.jsonl") }).code, 0);
  });
  test("running the project counts as acting", () => {
    const s = `${session}-run`;
    for (let i = 0; i < 19; i++) hook("focus.mjs", { session_id: s, tool_name: "Read", tool_input: { file_path: "a" } });
    hook("focus.mjs", { session_id: s, tool_name: "Bash", tool_input: { command: "npm run test" } });
    const out = hook("focus.mjs", { session_id: s, tool_name: "Read", tool_input: { file_path: "b" } });
    assert.equal(out.json, null);
  });
  test("no look-up nudge while the user only asks a question or for a review", () => {
    const dir = tempProject(null);
    const s = `${session}-question`;
    const ask = (prompt) => {
      hook("reminder.mjs", { session_id: s, prompt }, { project: dir });
      return readState(dir, s).question;
    };
    assert.equal(ask("how does the reviewer work?"), true);
    assert.equal(ask("Review my kit and rate it"), true);
    assert.equal(ask("Can you add a button for it?"), false, "a change asked as a question");
    assert.equal(ask("fix the login page"), false);
    ask("what does the guard block?");
    let last;
    for (let i = 0; i < 13; i++) last = hook("focus.mjs", { session_id: s, tool_name: "read_file", tool_input: { file_path: `f${i}` } }, { project: dir });
    assert.equal(last.json, null);
  });
});

describe("context monitor", () => {
  const dir = mkdtempSync(join(tmpdir(), "lca-ctx-"));
  const transcript = join(dir, "transcript.jsonl");
  const session = `ctx-${process.pid}-${Date.now()}`;
  // Qwen Code's transcript: usageMetadata on each assistant record.
  const turn = (tokens) =>
    JSON.stringify({
      type: "assistant",
      message: { role: "model", parts: [{ text: "ok" }] },
      usageMetadata: { promptTokenCount: tokens - 500, candidatesTokenCount: 500, totalTokenCount: tokens },
    });
  // No server to ask (LOCAL_AGENT_URL empty): the budget is LOCAL_AGENT_CONTEXT.
  const env = { LOCAL_AGENT_URL: "", LOCAL_AGENT_CONTEXT: "100000" };
  const note = (tokens, input = {}) => {
    writeFileSync(transcript, `${JSON.stringify({ type: "user" })}\n${turn(tokens)}\n`);
    return (
      hook("context.mjs", { session_id: session, transcript_path: transcript, tool_name: "read_file", ...input }, { env }).json
        ?.hookSpecificOutput?.additionalContext ?? ""
    );
  };

  test("warns once near compaction, and again after a compaction frees space", () => {
    assert.equal(note(50_000), "");
    // A 60% note made the 27B believe in an earlier session (2026-10-24): no note there now.
    assert.equal(note(65_000), "");
    // Qwen Code compresses on its own; stopping to ask the user ended an unattended run.
    assert.match(note(85_000), /about 85% full \(85,000 of 100,000 tokens\).*only ones you ran and saw pass.*Do not stop/);
    assert.equal(note(90_000), "");
    assert.equal(note(20_000), "", "after compaction");
    assert.match(note(82_000), /about 82% full/);
  });
  test("ignores helper agents (they write their own transcripts)", () => {
    assert.equal(note(95_000, { agent_id: "abc" }), "");
  });
});

describe("session-start and reminder", () => {
  test("session start gives the working style and the detected check command", () => {
    const project = tempProject({ scripts: { lint: "eslint", test: "vitest run" } });
    const context = hook("session-start.mjs", { source: "startup" }, { project }).json.hookSpecificOutput.additionalContext;
    assert.match(context, /# How to work/);
    assert.match(context, /`npm run lint && npm run test`/);
    assert.match(context, /onboard-repo/);
    for (const skill of ["security", "architecture", "performance", "errors-and-logging", "accessibility", "ui-design", "testing-setup", "deployment"]) {
      assert.match(context, new RegExp(`\`${skill}\``), `working style names the ${skill} skill`);
      assert.ok(existsSync(join(kit, "kit", ".qwen", "skills", skill, "SKILL.md")), `${skill} skill exists`);
    }
  });
  test("session start asks for Simplified Technical English unless LOCAL_AGENT_STE is 0", () => {
    const project = tempProject({ scripts: {} });
    const on = hook("session-start.mjs", { source: "startup" }, { project }).json.hookSpecificOutput.additionalContext;
    assert.match(on, /## Messages to the user\nWrite them in ASD-STE100/);
    const off = hook("session-start.mjs", { source: "startup" }, { project, env: { LOCAL_AGENT_STE: "0" } }).json.hookSpecificOutput.additionalContext;
    assert.doesNotMatch(off, /ASD-STE100|Messages to the user/);
    assert.match(off, /## 6\. Report[\s\S]*\n\n## Helpers and memory/);
  });
  test("the working style loads skills on demand, keeps stack details in skills, and scopes the review", () => {
    // From the 2026-10-24 runs: the 27B loaded 4 skills (28K characters) up front, and spent ~12 min on
    // the reviewer's 10 findings and a second full check round.
    const style = readFileSync(join(kitDir, "prompt", "working-style.md"), "utf8");
    assert.doesNotMatch(style, /Load them all in your first message/);
    assert.match(style, /when you reach that kind of work, not before/);
    assert.doesNotMatch(style, /node_modules\/next|npx ng test|<!-- -->/, "stack details live in the framework skills");
    assert.match(style, /at most 5 real defects/);
    const reviewer = readFileSync(join(kit, "kit", ".qwen", "agents", "reviewer.md"), "utf8");
    assert.match(reviewer, /at most 5 findings[\s\S]*only real defects/);
  });
  test("session start warns about Next.js 16 and shadcn on Base UI only when the project uses them", () => {
    const context = (pkg, files) =>
      hook("session-start.mjs", { source: "startup" }, { project: tempProject(pkg, files) })
        .json.hookSpecificOutput.additionalContext.split("## This project")[1];
    const modern = context(
      { dependencies: { next: "16.3.8", "@base-ui/react": "^1.8.0" } },
      { "components.json": JSON.stringify({ style: "base-nova" }) },
    );
    assert.match(modern, /Next\.js 16: `params`/);
    assert.match(modern, /proxy\.ts/);
    assert.match(modern, /Base UI, not Radix/);
    const older = context({ dependencies: { next: "^15.2.0" } }, { "components.json": JSON.stringify({ style: "new-york" }) });
    assert.match(older, /Next\.js 15: `params`/);
    assert.doesNotMatch(older, /proxy\.ts|Base UI/);
    assert.doesNotMatch(context({ dependencies: { react: "19" } }), /Next\.js|Base UI|Zod|Vitest/);
    const taskboard = context(
      { dependencies: { zod: "^4.6.5" } },
      { "vitest.config.mts": 'export default { test: { environment: "node" } };' },
    );
    assert.match(taskboard, /Zod 4/);
    assert.match(taskboard, /@vitest-environment jsdom/);
    const zod3 = context({ dependencies: { zod: "^3.23.0" } }, { "vitest.config.ts": 'test: { environment: "jsdom" }' });
    assert.doesNotMatch(zod3, /Zod 4|@vitest-environment/);
  });
  test("session start names the framework skill to load first", () => {
    const context = (pkg) =>
      hook("session-start.mjs", { source: "startup" }, { project: tempProject(pkg), env: { LOCAL_AGENT_OFFLINE: "1" } })
        .json.hookSpecificOutput.additionalContext.split("## This project")[1];
    assert.match(context({ dependencies: { next: "16.3.8", react: "19" } }), /Load the `react-nextjs` skill in your first message/);
    assert.match(context({ dependencies: { vue: "^3.5.0" } }), /Load the `vue` skill/);
    assert.match(context({ dependencies: { "@angular/core": "^22.2.0" } }), /Load the `angular` skill/);
    assert.doesNotMatch(context({ dependencies: { zod: "^4.0.0" } }), /Load the `/);
  });
  test("session start names what changed in Angular, Vue and TypeScript for the installed versions", () => {
    const context = (pkg, files) =>
      hook("session-start.mjs", { source: "startup" }, { project: tempProject(pkg, files), env: { LOCAL_AGENT_OFFLINE: "1" } })
        .json.hookSpecificOutput.additionalContext.split("## This project")[1];
    const ng22 = context({ dependencies: { "@angular/core": "^22.2.0" }, devDependencies: { vitest: "^5.0.0" } }, { "angular.json": '{"polyfills": []}' });
    assert.match(ng22, /Angular 22: zoneless with OnPush by default.*signals/);
    assert.match(ng22, /vi\.fn\(\)/);
    const ngZone = context({ dependencies: { "@angular/core": "^21.0.0", "zone.js": "~0.15.0" } }, { "angular.json": "{}" });
    assert.doesNotMatch(ngZone, /zoneless/);
    assert.match(ngZone, /Angular 21: check the version table/);
    assert.match(context({ dependencies: { "@angular/core": "^16.2.0" } }), /Angular 16 has no `@if`.*CommonModule/);

    assert.match(context({ dependencies: { vue: "^2.7.7" } }), /Vue 2: Options API.*\$set/);
    const vue = context({ dependencies: { vue: "^3.5.13", pinia: "^4.0.0", "vue-router": "^5.0.0" } });
    assert.match(vue, /Vue 3\.5: watch a destructured prop with a getter .*storeToRefs.*watch the param/);
    assert.doesNotMatch(context({ dependencies: { vue: "^3.4.0" } }), /Vue 3/);

    const ts = context(
      { devDependencies: { typescript: "~6.0.2" } },
      { "tsconfig.json": '{ "compilerOptions": { "verbatimModuleSyntax": true, "erasableSyntaxOnly": true } }' },
    );
    assert.match(ts, /TypeScript 6: `strict` is on.*`import type`.*no `enum`/);
    assert.doesNotMatch(context({ devDependencies: { typescript: "^5.8.0" } }, { "tsconfig.json": "{}" }), /TypeScript/);
    assert.doesNotMatch(context({ dependencies: { react: "19" } }), /Angular|Vue|TypeScript/);
  });
  test("an unfinished plan is mentioned at startup and restored in full after a compaction", () => {
    const project = tempProject(
      { scripts: {} },
      { ".local-agent/plan.md": "# Plan: tags\n- [x] 1. Data\n- [ ] 2. Server\n- [ ] 3. UI\n" },
    );
    const startup = hook("session-start.mjs", { source: "startup" }, { project }).json.hookSpecificOutput.additionalContext;
    assert.match(startup, /unfinished plan in `\.local-agent\/plan\.md` \(1 of 3 steps done\)/);
    assert.doesNotMatch(startup, /2\. Server/);
    const compacted = hook("session-start.mjs", { source: "compact" }, { project }).json.hookSpecificOutput.additionalContext;
    assert.match(compacted, /Your current plan/);
    assert.match(compacted, /- \[ \] 2\. Server/);
    writeFileSync(join(project, ".local-agent", "plan.md"), "- [x] 1. Data\n- [x] 2. Server\n");
    const finished = hook("session-start.mjs", { source: "startup" }, { project }).json.hookSpecificOutput.additionalContext;
    assert.doesNotMatch(finished, /unfinished plan/);
  });
  test("reminder adds a checklist, and asks for a plan only on big or vague requests", () => {
    const context = (prompt) => hook("reminder.mjs", { prompt }).json.hookSpecificOutput.additionalContext;
    assert.match(context("hi"), /Checklist/);
    assert.doesNotMatch(context("fix the typo in the footer"), /plan-work/);
    assert.doesNotMatch(context("why does the build fail?"), /plan-work/);
    assert.match(context("make me a todo app with tags"), /plan-work/);
    assert.doesNotMatch(
      context(
        "add a contact page at /contact with a form - name, email and message (all required) and a Send button. if something's empty or the email looks wrong show an error next to that field. when everything is ok replace the form with \"Thanks, we'll be in touch!\". no backend needed",
      ),
      /plan-work/,
    );
    assert.match(context("add tags to tasks, show them as chips, let me filter by tag, and keep them after reload"), /plan-work/);
    assert.match(context("x".repeat(900)), /plan-work/);
    // One fix, and one function with a detailed spec, are not plan-sized (both used to be).
    assert.doesNotMatch(
      context("Every project page shows the tasks of all projects, not just its own. Find and fix the bug, and add a test so it can't come back."),
      /plan-work/,
    );
    assert.doesNotMatch(
      context(
        'Add `parseDuration(input: string): number` in a new file src/lib/duration.ts. It turns human durations like "1h 30m", "45s", "1h5m10s" or "500ms" into milliseconds. Units: ms, s, m, h, d (case-insensitive); spaces between parts are optional and surrounding whitespace is ignored. It must throw an Error for anything invalid: an empty string, a number without a unit, an unknown unit, the same unit twice ("1h 2h"), negative numbers, or leftover junk. Add thorough unit tests.',
      ),
      /plan-work/,
    );
    // A request with its own numbered steps is the plan already (the friend prompts, 2026-10-24).
    const stepByStep =
      "You are working in an empty folder. Do every step below in order.\n\nSTEP 1 - Create the app\nRun: npx create-next-app@latest .\n\nSTEP 2 - Set up the tests\n1. Run: npm install -D vitest\n2. Create vitest.config.ts\n\nSTEP 3 - Build the booking page\nBuild a booking page.";
    assert.doesNotMatch(context(stepByStep), /plan-work/);
    assert.match(context(stepByStep), /Effort: normal/);
    // "If ..." states a rule of the feature; a reported failure stays hard.
    assert.match(context('Add a form. If something is wrong, show the error next to the field. Install x (if x fails to install, use y).'), /Effort: normal/);
    assert.match(context("Show a clear error when something is wrong (for example the password is wrong)."), /Effort: normal/);
    assert.match(context("The signup form fails if the email has a plus sign."), /Effort: high/);
  });
  test("reminder asks for careful thought on bugs, failures and design, short thoughts otherwise", () => {
    const context = (prompt) => hook("reminder.mjs", { prompt }).json.hookSpecificOutput.additionalContext;
    for (const hard of [
      'toSlug("Crème Brûlée") returns "cre-me-bru-le-e" instead of "creme-brulee". Find and fix the bug.',
      "Adding a task with an empty title gives a 500 error, and the page doesn't tell the user what went wrong.",
      "why does the build fail?",
      "the projects page is slow with 1000 tasks",
      "refactor the task list into smaller components",
      "make me a todo app with tags",
    ]) {
      assert.match(context(hard), /Effort: high/, hard);
    }
    for (const normal of [
      "fix the typo in the footer",
      "rename the Projects tab to Boards",
      // A feature with errors in it is not a bug: "error" and "looks wrong" describe what to build.
      "add a contact page at /contact with a form - name, email and message (all required) and a Send button. if something's empty or the email looks wrong show an error next to that field. when everything is ok replace the form with \"Thanks, we'll be in touch!\". no backend needed",
      'Add a QuoteCard component in src/app/quote-card/quote-card.ts. Show it on the home page instead of the placeholder content.',
    ]) {
      assert.match(context(normal), /Effort: normal/, normal);
    }
  });
  test("reminder names the security skill for accounts, log-in, permissions and uploads", () => {
    // An "add accounts" run loaded only the framework skill and wrote its own password hashing (2026-10-28).
    const context = (prompt) => hook("reminder.mjs", { prompt }).json.hookSpecificOutput.additionalContext;
    for (const prompt of [
      "Add accounts to the app: sign up with email and password, log in, and log out.",
      "Only admins can delete projects",
      "Let me attach one image to each task",
    ]) {
      assert.match(context(prompt), /load the `security` skill/, prompt);
    }
    assert.doesNotMatch(context("Add a dark mode toggle to the header"), /security/);
  });
});

describe("stop-check", () => {
  test("passes, then skips when nothing changed, then blocks on a failing check", () => {
    const project = tempProject({ scripts: { check: "node check.js" } }, { "check.js": "process.exit(0)" });
    const first = hook("stop-check.mjs", {}, { project });
    assert.equal(first.code, 0);
    assert.match(first.json.systemMessage, /Checks passed/);
    const again = hook("stop-check.mjs", {}, { project });
    assert.equal(again.code, 0);
    assert.equal(again.json, null);

    writeFileSync(join(project, "check.js"), 'console.error("boom: type error in x.ts"); process.exit(1)');
    const failed = hook("stop-check.mjs", {}, { project });
    assert.equal(failed.code, 2);
    assert.match(failed.stderr, /attempt 1 of 3/);
    assert.match(failed.stderr, /boom: type error in x.ts/);
    assert.match(failed.stderr, /give your full report again/);
  });
  test("runs a type, lint or build failure once, and a failing test twice in case it is flaky", () => {
    const runs = (output) => {
      const check = `require("fs").appendFileSync("runs.txt", "x"); console.log(${JSON.stringify(output)}); process.exit(1);`;
      const project = tempProject({ scripts: { check: "node check.js" } }, { "check.js": check });
      assert.equal(hook("stop-check.mjs", {}, { project }).code, 2);
      return readFileSync(join(project, "runs.txt"), "utf8").length;
    };
    assert.equal(runs("src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'."), 1);
    assert.equal(runs("✖ 2 problems (2 errors, 0 warnings)"), 1);
    assert.equal(runs("Failed to compile.\n./src/app/page.tsx"), 1);
    assert.equal(runs(" Tests  1 failed | 4 passed (5)"), 2);
  });
  test("skips the checks when only notes changed (a kit setup or removal, an AGENTS.md lesson)", () => {
    // A removal ran typecheck, lint, tests and the build for QWEN.md and .gitignore (2026-10-28).
    const project = tempProject(
      { scripts: { check: 'node -e "require(\'fs\').appendFileSync(\'runs.txt\',\'x\');process.exit(1)"' } },
      { "QWEN.md": "kit\n", ".gitignore": "node_modules\n", "src/a.ts": "export const a = 1;\n" },
    );
    const session = `notes-${process.pid}-${Date.now()}`;
    hook("session-start.mjs", { session_id: session, source: "startup" }, { project, env: { LOCAL_AGENT_OFFLINE: "1" } });
    rmSync(join(project, "QWEN.md"));
    writeFileSync(join(project, ".gitignore"), "node_modules\n.local-agent/\n");
    assert.equal(hook("stop-check.mjs", { session_id: session }, { project }).code, 0);
    // A new lesson still gets its one review, without a check run.
    writeFileSync(join(project, "AGENTS.md"), "## Lessons\n");
    const lesson = hook("stop-check.mjs", { session_id: session }, { project });
    assert.match(lesson.stderr, /AGENTS\.md: changed/);
    assert.doesNotMatch(lesson.stderr, /checks failed/);
    assert.ok(!existsSync(join(project, "runs.txt")), "the check did not run");
    writeFileSync(join(project, "src/a.ts"), "export const a = 2;\n");
    assert.equal(hook("stop-check.mjs", { session_id: session }, { project }).code, 2, "a code change is checked");
  });
  test("a second chat in the same project does not hide the first chat's changes", () => {
    // One state file per project let chat B's start overwrite chat A's (2026-10-27).
    const project = tempProject({ scripts: { check: "node -e process.exit(1)" } });
    const a = `chat-a-${process.pid}-${Date.now()}`;
    const b = `chat-b-${process.pid}-${Date.now()}`;
    hook("session-start.mjs", { session_id: a, source: "startup" }, { project });
    writeFileSync(join(project, "a.ts"), "export const a = 1;\n");
    hook("session-start.mjs", { session_id: b, source: "startup" }, { project });
    assert.equal(hook("stop-check.mjs", { session_id: b }, { project }).code, 0, "chat B changed nothing");
    assert.equal(hook("stop-check.mjs", { session_id: a }, { project }).code, 2, "chat A's change is still checked");
  });
  test("gives up after three blocked attempts in a row", () => {
    const project = tempProject({ scripts: { check: "node -e process.exit(1)" } });
    for (let i = 1; i <= 3; i++) {
      const blocked = hook("stop-check.mjs", { stop_hook_active: i > 1 }, { project });
      assert.equal(blocked.code, 2);
      // A repeat failure asks for careful thought; the first (often formatting) does not.
      if (i === 1) assert.doesNotMatch(blocked.stderr, /think this one through/);
      else assert.match(blocked.stderr, /failed again after your fix: think this one through carefully/);
    }
    const fourth = hook("stop-check.mjs", { stop_hook_active: true }, { project });
    assert.equal(fourth.code, 0);
    assert.match(fourth.json.systemMessage, /still fail after 3 attempts/);
  });
  test("does nothing in a project without checks", () => {
    assert.equal(hook("stop-check.mjs", {}, { project: tempProject(null) }).code, 0);
  });
  test("does not block a session that changed nothing, even if the checks already fail", () => {
    const project = tempProject({ scripts: { check: "node -e process.exit(1)" } });
    hook("session-start.mjs", { source: "startup" }, { project });
    assert.equal(hook("stop-check.mjs", {}, { project }).code, 0);
    writeFileSync(join(project, "new-file.ts"), "export const a = 1;\n");
    assert.equal(hook("stop-check.mjs", {}, { project }).code, 2);
  });
  test("reminds once about debugging leftovers in files the session created", () => {
    const project = tempProject(
      { scripts: { check: "node -e process.exit(0)" } },
      { "src/old.ts": 'console.log("existing, not ours");\n' },
    );
    hook("session-start.mjs", { source: "startup" }, { project });
    writeFileSync(join(project, "src", "feature.ts"), 'export const f = () => {\n  console.log("x");\n};\n');
    writeFileSync(join(project, "tmp-verify.mjs"), "await check();\n");
    writeFileSync(join(project, "src", "verify-email.ts"), "export const ok = true;\n");
    mkdirSync(join(project, "tests", "e2e"), { recursive: true });
    writeFileSync(join(project, "tests", "e2e", "p12.spec.ts"), 'import { test } from "@playwright/test";\n');
    writeFileSync(join(project, "tests", "e2e", "real.spec.ts"), 'import { test } from "@playwright/test";\ntest("books", async () => {});\n');
    const first = hook("stop-check.mjs", {}, { project });
    assert.equal(first.code, 2);
    assert.match(first.stderr, /src\/feature\.ts: console\.log/);
    assert.match(first.stderr, /tmp-verify\.mjs: looks like a temporary file/);
    assert.match(first.stderr, /p12\.spec\.ts: a new test file with no tests/);
    // Its answer is the last message, so the report must come again (lost in both Opus kit runs).
    assert.match(first.stderr, /give your full report again/);
    assert.doesNotMatch(first.stderr, /old\.ts|verify-email|real\.spec/);
    const second = hook("stop-check.mjs", { stop_hook_active: true }, { project });
    assert.equal(second.code, 0, "the reminder is shown only once");
  });
  test("reminds once about unchecked steps of a plan the session wrote", () => {
    const project = tempProject({ scripts: { check: "node -e process.exit(0)" } });
    hook("session-start.mjs", { source: "startup" }, { project });
    mkdirSync(join(project, ".local-agent"));
    writeFileSync(
      join(project, ".local-agent", "plan.md"),
      "# Plan: tags\n- [x] 1. Data: tags column. Check: unit test.\n- [ ] 2. UI: tag chips. Check: component test.\n- [ ] 3. Filter by tag. Check: browser test.\n",
    );
    writeFileSync(join(project, "feature.ts"), "export const f = 1;\n");
    const first = hook("stop-check.mjs", {}, { project });
    assert.equal(first.code, 2);
    assert.match(first.stderr, /still has 2 unchecked steps/);
    assert.match(first.stderr, /- 2\. UI: tag chips/);
    assert.doesNotMatch(first.stderr, /Data: tags column/);
    assert.doesNotMatch(first.stderr, /debugging leftovers|Fix them, or keep them/);
    writeFileSync(join(project, "feature.ts"), "export const f = 2;\n");
    const second = hook("stop-check.mjs", { stop_hook_active: true }, { project });
    assert.equal(second.code, 0, "the reminder is shown only once");
  });
  test("an older plan about other work, left as it was, does not block", () => {
    const project = tempProject(
      { scripts: { check: "node -e process.exit(0)" } },
      { ".local-agent/plan.md": "# Plan: old\n- [ ] 1. Something else entirely.\n" },
    );
    hook("session-start.mjs", { source: "startup" }, { project });
    writeFileSync(join(project, "feature.ts"), "export const f = 1;\n");
    const out = hook("stop-check.mjs", {}, { project });
    assert.equal(out.code, 0);
    assert.match(out.json.systemMessage, /Checks passed/);
  });
  test("no leftovers reminder for clean changes", () => {
    const project = tempProject({ scripts: { check: "node -e process.exit(0)" } });
    hook("session-start.mjs", { source: "startup" }, { project });
    writeFileSync(join(project, "feature.ts"), "export const f = 1;\n");
    const out = hook("stop-check.mjs", {}, { project });
    assert.equal(out.code, 0);
    assert.match(out.json.systemMessage, /Checks passed/);
  });
  test("asks once for a second look at risky lines the session added, and only those", () => {
    const project = tempProject(
      { scripts: { check: "node -e process.exit(0)" } },
      { "src/old.ts": 'const apiKey = "existing-not-ours-123";\n' },
    );
    hook("session-start.mjs", { source: "startup" }, { project });
    const files = {
      "src/aws.ts": 'export const key = "AKIAABCDEFGHIJKLMNOP";\n',
      "src/config.ts": 'export const config = { apiKey: "q8Zr2LmV9xKp4TnW", other: process.env.API_KEY };\n',
      "src/public.ts": "export const s = process.env.NEXT_PUBLIC_STRIPE_SECRET;\n",
      "src/quiet.ts": "// @ts-ignore\nexport const n: number = 'x' as any;\n",
      "src/html.tsx": "export const H = ({ bio }: { bio: string }) => <p dangerouslySetInnerHTML={{ __html: bio }} />;\n",
      "src/dom.ts": "export const show = (el: HTMLElement, name: string) => {\n  el.innerHTML = `<b>${name}</b>`;\n};\n",
      "src/db.ts": "export const find = (db: any, name: string) => db.prepare(`SELECT * FROM users WHERE name = '${name}'`).get();\n",
      "src/query.ts": "export const remove = (id: string) => {\n  const q = `DELETE FROM posts WHERE id = ${id}`;\n  return q;\n};\n",
      "src/pg.ts": "export const raw = (sql: any, a: string) => sql.unsafe(`SELECT 1 WHERE a = '${a}'`);\n",
      "src/jwt.ts": 'const JWT_SECRET = "a8f9d7s6f5g4h3j2k1";\nexport const stripeSecretKey = "sk_test_abcdefghijklmnop";\n',
      "src/ai.ts": "export const k = process.env.NEXT_PUBLIC_OPENAI_API_KEY;\n",
      // How Prettier lays out a long query: SELECT and ${...} on different lines.
      "src/multi.ts": "export const find = (db: any, name: string) =>\n  db.query(\n    `SELECT *\n     FROM users\n     WHERE name = '${name}'`,\n  );\n",
      "src/app/api/tasks/route.ts": "export async function POST(request: Request) {\n  const body = await request.json();\n  return Response.json(body);\n}\n",
      "src/app/actions.ts": '"use server";\n\nexport async function deleteTask(id: string) {\n  return id;\n}\n',
      "AGENTS.md": "# Notes\n- Lesson: something\n",
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(project, path)), { recursive: true });
      writeFileSync(join(project, path), text);
    }
    const first = hook("stop-check.mjs", {}, { project });
    assert.equal(first.code, 2);
    for (const expected of [
      /src\/aws\.ts: what looks like a hardcoded secret/,
      /src\/config\.ts: what looks like a hardcoded secret/,
      /src\/public\.ts: a secret-looking name with a public prefix/,
      /src\/quiet\.ts: an error suppression/,
      /src\/quiet\.ts: `as any`/,
      /src\/html\.tsx: raw HTML/,
      /src\/dom\.ts: raw HTML/,
      /src\/db\.ts: SQL built from strings/,
      /src\/query\.ts: SQL built from strings/,
      /src\/pg\.ts: SQL built from strings/,
      /src\/jwt\.ts: what looks like a hardcoded secret/,
      /src\/ai\.ts: a secret-looking name with a public prefix/,
      /src\/multi\.ts: SQL built from strings .*\(``SELECT \*`\)/,
      /src\/app\/api\/tasks\/route\.ts: a route handler or Server Action that changes data, with no login or permission check/,
      /src\/app\/actions\.ts: a route handler or Server Action that changes data, with no login or permission check/,
      /AGENTS\.md: changed\. Check every line you added/,
    ]) {
      assert.match(first.stderr, expected);
    }
    assert.doesNotMatch(first.stderr, /old\.ts/, "existing code is not flagged");
    assert.doesNotMatch(first.stderr, /AKIAABCDEFGHIJKLMNOP|q8Zr2LmV9xKp4TnW/, "the secret itself is not repeated");
    assert.equal(hook("stop-check.mjs", { stop_hook_active: true }, { project }).code, 0, "shown only once");
  });
  test("no second look for the safe forms of the same things", () => {
    const project = tempProject({ scripts: { check: "node -e process.exit(0)" } });
    hook("session-start.mjs", { source: "startup" }, { project });
    const files = {
      "src/env.ts": 'export const key = process.env.API_KEY;\nexport const form = { password: "changeme", label: "Password" };\n',
      "src/db.ts":
        'export const byId = (db: any, id: number) => db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);\nexport const q = (sql: any, slug: string) => sql`SELECT * FROM user WHERE slug = ${slug}`;\n',
      "src/dom.ts": 'export const clear = (el: HTMLElement) => {\n  el.innerHTML = "";\n  el.textContent = "safe";\n};\n',
      "src/public.ts": "export const url = process.env.NEXT_PUBLIC_API_URL;\nexport const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;\n",
      "tests/login.test.ts": 'const user = { password: "hunter2hunter2" };\ntest("logs in", () => {});\n',
      // Template literals in ordinary calls are not SQL; tagged sql`...` above is safe too.
      "src/calls.ts":
        "export const load = async (axios: any, redis: any, form: FormData, id: string, i: number, n: number) => {\n  await axios.get(`${process.env.API_URL}/users/${id}`);\n  await redis.get(`session:${id}`);\n  form.get(`field-${i}`);\n  return `Select ${n} items from the list`;\n};\n",
      "src/check.ts": 'export const empty = (el: HTMLElement) => el.innerHTML === "";\n',
      "src/page.tsx": "export const P = () => <p>Use it as any other page.</p>;\n",
      "src/form.ts": 'export const fields = { password: "current-password", passwordResetUrl: "/reset-password", apiKeyEnv: "OPENAI_API_KEY" };\n',
      "src/msg.ts": "export const m = (n: number) =>\n  `Select\n  ${n} items`;\n",
      "src/app/api/items/route.ts": "export async function GET() {\n  return Response.json([]);\n}\n",
      // The login system's own endpoints are public by design (flagged in a 2026-10-28 run).
      "src/app/api/auth/signup/route.ts": "export async function POST(request: Request) {\n  return Response.json(await request.json(), { status: 201 });\n}\n",
      "src/app/api/auth/logout/route.ts": "export async function POST() {\n  return new Response(null, { status: 204 });\n}\n",
      "src/app/login/actions.ts": '"use server";\n\nexport async function logIn(form: FormData) {\n  return form.get("email");\n}\n',
      "src/app/actions.ts":
        '"use server";\n\nimport { auth } from "@/lib/auth";\n\nexport async function deleteTask(id: string) {\n  const session = await auth();\n  if (!session) throw new Error("Unauthorized");\n  return id;\n}\n',
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(project, path)), { recursive: true });
      writeFileSync(join(project, path), text);
    }
    const out = hook("stop-check.mjs", {}, { project });
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.json.systemMessage, /Checks passed/);
  });
  test("trusts the model's own passing check run on the same files, and only that", () => {
    // The check fails if the Stop hook runs it, so a pass means it was skipped.
    const project = tempProject({ scripts: { check: "node -e process.exit(1)" } });
    const session_id = `stop-${process.pid}-${Date.now()}`;
    hook("session-start.mjs", { session_id, source: "startup" }, { project });
    writeFileSync(join(project, "feature.ts"), "export const f = 1;\n");
    const ran = (command, stdout) =>
      hook("focus.mjs", { session_id, hook_event_name: "PostToolUse", tool_name: "run_shell_command", tool_input: { command }, tool_response: { stdout, stderr: "" } }, { project });
    ran("npm run check 2>&1 | tail -5", "Tests  3 passed");
    assert.equal(hook("stop-check.mjs", { session_id }, { project }).code, 2, "a piped run's exit code is unknown");
    ran("npm run check 2>&1", "Tests  3 passed");
    const out = hook("stop-check.mjs", { session_id }, { project });
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.json.systemMessage, /your own run on these same files/);
    writeFileSync(join(project, "feature.ts"), "export const f = 2;\n");
    assert.equal(hook("stop-check.mjs", { session_id }, { project }).code, 2, "a change after the run means a new run");
  });
  test("a finding kept on purpose is not shown again when another one is fixed", () => {
    const project = tempProject({ scripts: { check: "node -e process.exit(0)" } });
    hook("session-start.mjs", { source: "startup" }, { project });
    writeFileSync(join(project, "AGENTS.md"), "# Notes\n");
    writeFileSync(join(project, "feature.ts"), 'export const f = () => {\n  console.log("x");\n};\n');
    const first = hook("stop-check.mjs", {}, { project });
    assert.equal(first.code, 2);
    assert.match(first.stderr, /AGENTS\.md: changed/);
    assert.match(first.stderr, /feature\.ts: console\.log/);
    // The model removes the console.log and keeps the AGENTS.md change: nothing new, so it may finish.
    writeFileSync(join(project, "feature.ts"), "export const f = () => 1;\n");
    assert.equal(hook("stop-check.mjs", { stop_hook_active: true }, { project }).code, 0);
    // A new problem later in the session is still caught, listed on its own.
    writeFileSync(join(project, "other.ts"), "// @ts-ignore\nexport const o = 1;\n");
    const later = hook("stop-check.mjs", {}, { project });
    assert.equal(later.code, 2);
    assert.match(later.stderr, /other\.ts: an error suppression/);
    assert.doesNotMatch(later.stderr, /AGENTS\.md/);
  });
  test("flags a new .env file git would commit, not an ignored one or an example", () => {
    const project = tempProject({ scripts: { check: "node -e process.exit(0)" } });
    spawnSync("git", ["init", "-q"], { cwd: project });
    hook("session-start.mjs", { source: "startup" }, { project });
    writeFileSync(join(project, ".env"), "DATABASE_URL=postgres://u:p@localhost/db\n");
    writeFileSync(join(project, ".env.example"), "DATABASE_URL=\n");
    const exposed = hook("stop-check.mjs", {}, { project });
    assert.equal(exposed.code, 2);
    assert.match(exposed.stderr, /^- \.env: an env file git would commit/m);
    assert.doesNotMatch(exposed.stderr, /\.env\.example:/);

    const ignored = tempProject({ scripts: { check: "node -e process.exit(0)" } }, { ".gitignore": ".env*\n!.env.example\n" });
    spawnSync("git", ["init", "-q"], { cwd: ignored });
    hook("session-start.mjs", { source: "startup" }, { project: ignored });
    writeFileSync(join(ignored, ".env"), "DATABASE_URL=postgres://u:p@localhost/db\n");
    assert.equal(hook("stop-check.mjs", {}, { project: ignored }).code, 0);
  });
  test("flags a fast hash in a file that handles passwords", () => {
    const project = tempProject(null, {
      "src/auth.ts": 'export const hash = (password: string) => createHash("sha256").update(password).digest("hex");\n',
      "src/etag.ts": 'export const etag = (body: string) => createHash("sha256").update(body).digest("hex");\n',
    });
    const findings = findRisks(project, ["src/auth.ts", "src/etag.ts"], {});
    assert.equal(findings.length, 1);
    assert.match(findings[0], /^src\/auth\.ts: a fast hash in a file that handles passwords/);
  });
  test("flags a password hash compared with ===, and not the safe scrypt or other comparisons", () => {
    const project = tempProject(null, {
      "src/bad.ts": [
        "export function checkPassword(password: string, stored: string) {",
        '  const [salt, hash] = stored.split(":");',
        '  return scryptSync(password, salt, 64).toString("hex") === hash;',
        "}",
      ].join("\n"),
      "src/bad-left.ts": "export const ok = (password: string, user: User) => user.passwordHash !== digestOf(password);\n",
      "src/good.ts": [
        "export function checkPassword(password: string, stored: string) {",
        '  const [salt, hash] = stored.split(":");',
        "  if (!salt || !hash) return false;",
        '  const expected = Buffer.from(hash, "hex");',
        "  return expected.length === 64 && timingSafeEqual(scryptSync(password, salt, 64), expected);",
        "}",
        'export const missing = (user: User) => user.passwordHash === null || typeof user.passwordHash !== "string";',
        "export const hexLength = (password: string, hash: string) => hash.length === 128;",
      ].join("\n"),
      // Not about passwords: an ETag compare is not a timing risk worth a note.
      "src/etag.ts": "export const fresh = (etagHash: string, header: string) => etagHash === header;\n",
    });
    const findings = findRisks(project, ["src/bad.ts", "src/bad-left.ts", "src/good.ts", "src/etag.ts"], {});
    assert.equal(findings.length, 2, findings.join("\n"));
    assert.match(findings[0], /^src\/bad\.ts: a password hash compared with `===`/);
    assert.match(findings[1], /^src\/bad-left\.ts: a password hash compared with `===`/);
  });
  describe("route probe", () => {
    // A stand-in for `next start`: a plain server on the port it is given. `handle(method, url, body,
    // seen)` returns [status, body]; every request is logged to node_modules/requests.log.
    const server = (handle) => `const http = require("http");
const fs = require("fs");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const seen = new Set();
const handle = ${handle};
http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    if (req.url !== "/") fs.appendFileSync("node_modules/requests.log", req.method + " " + req.url + "\\n");
    const [status, text] = req.url === "/" ? [404, "{}"] : handle(req.method, req.url, body, seen);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(text);
  });
}).listen(port, "127.0.0.1");
`;
    // 500 on a body that is not JSON (both arms of the 2026-10-28 create-project run), 400 otherwise.
    const crashes = `(method, url, body) => {
  if (method !== "POST") return [404, '{"error":"Not found"}'];
  try {
    const value = JSON.parse(body);
    return value && !Array.isArray(value) ? [201, "{}"] : [400, '{"error":"Expected an object"}'];
  } catch (error) {
    console.error("SyntaxError: " + error.message);
    return [500, "Internal Server Error"];
  }
}`;
    const refuses = `() => [400, '{"error":"Bad request"}']`;
    const sharesResponse = `(method, url, body, seen) => {
  const key = method + url + body;
  if (seen.has(key)) return [400, ""];
  seen.add(key);
  return [400, '{"error":"Bad request"}'];
}`;
    const ROUTES = {
      "src/app/api/items/route.ts":
        "export async function POST(request: Request) {\n  await requireUser();\n  return Response.json(await request.json(), { status: 201 });\n}\nexport function GET() {\n  return Response.json([]);\n}\n",
      "src/app/(shop)/api/items/[id]/route.ts":
        "export function GET() {\n  return Response.json({});\n}\nexport async function DELETE() {\n  await requireUser();\n  return new Response(null, { status: 204 });\n}\n",
    };
    const setUp = (handle, { stale = false } = {}) => {
      const project = tempProject({ scripts: { check: "node -e process.exit(0)" }, dependencies: { next: "16.3.8" } }, { "node_modules/next/dist/bin/next": server(handle) });
      const session_id = `probe-${process.pid}-${Math.random()}`;
      hook("session-start.mjs", { session_id, source: "startup" }, { project, env: { LOCAL_AGENT_OFFLINE: "1" } });
      for (const [path, text] of Object.entries(ROUTES)) {
        mkdirSync(dirname(join(project, path)), { recursive: true });
        writeFileSync(join(project, path), text);
      }
      mkdirSync(join(project, ".next"), { recursive: true });
      writeFileSync(join(project, ".next", "BUILD_ID"), "test");
      if (stale) utimesSync(join(project, ".next", "BUILD_ID"), new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
      const stop = () => hook("stop-check.mjs", { session_id }, { project });
      return { project, stop };
    };
    const requests = (project) => readFileSync(join(project, "node_modules", "requests.log"), "utf8");

    test("blocks when a bad request gets a 500, and names the request and the app's error", () => {
      const { project, stop } = setUp(crashes);
      const out = stop();
      assert.equal(out.code, 2, out.stderr);
      assert.match(out.stderr, /^- POST \/api\/items, a body that is not JSON: 500 \(Internal Server Error\)$/m);
      assert.match(out.stderr, /^- POST \/api\/items, an empty body: 500/m);
      assert.doesNotMatch(out.stderr, /the body `null`/, "a 400 is right");
      assert.match(out.stderr, /SyntaxError: Unexpected end of JSON input/);
      assert.match(out.stderr, /attempt 1 of 2/);
      // Route groups leave the URL; ids that do not exist; never a DELETE without an id.
      const sent = requests(project);
      assert.match(sent, /^DELETE \/api\/items\/999999999$/m);
      assert.match(sent, /^GET \/api\/items\/not-an-id$/m);
      assert.match(sent, /^GET \/api\/items\?q=/m);
      assert.doesNotMatch(sent, /^DELETE \/api\/items$/m);
      assert.doesNotMatch(sent, /\(shop\)/);
      // The second attempt still fails; the third lets it finish and tells the user.
      assert.equal(stop().code, 2);
      const gaveUp = stop();
      assert.equal(gaveUp.code, 0, gaveUp.stderr);
      assert.match(gaveUp.json.systemMessage, /Bad requests still crash some changed API routes after 2 attempts/);
    });
    test("passes when every bad request gets a 4xx, and probes the same files once", () => {
      const { project, stop } = setUp(refuses);
      const out = stop();
      assert.equal(out.code, 0, out.stderr);
      // POST with 4 bodies and GET with odd query values; GET and DELETE with 2 ids each.
      assert.match(out.json.systemMessage, /Checks passed .*; 9 bad requests to the changed API routes got a proper answer/);
      const sent = requests(project).split("\n").filter(Boolean).length;
      assert.equal(sent, 18, "each one twice");
      assert.equal(stop().code, 0);
      assert.equal(requests(project).split("\n").filter(Boolean).length, sent, "not sent again");
    });
    test("catches a Response reused across requests: the second answer is empty", () => {
      const out = setUp(sharesResponse).stop();
      assert.equal(out.code, 2);
      assert.match(out.stderr, /the second answer had an empty body \(one Response object reused across requests\?\)/);
    });
    test("leaves a build older than the routes alone: it would answer for old code", () => {
      const { project, stop } = setUp(crashes, { stale: true });
      assert.equal(stop().code, 0);
      assert.ok(!existsSync(join(project, "node_modules", "requests.log")));
    });
  });
  test("a compaction does not reset the session's starting point", () => {
    const project = tempProject({ scripts: { check: "node -e process.exit(1)" } });
    hook("session-start.mjs", { source: "startup" }, { project });
    writeFileSync(join(project, "edited.ts"), "export const b = 2;\n");
    hook("session-start.mjs", { source: "compact" }, { project });
    assert.equal(hook("stop-check.mjs", {}, { project }).code, 2);
  });
});

describe("format-file", () => {
  // Uses a real project with ESLint and Prettier installed, when one is available.
  const project = process.env.LCA_TEST_PROJECT ?? "C:\\Development\\Project1";
  let available = false;
  try {
    available = !!readFileSync(join(project, "node_modules", "prettier", "package.json"));
  } catch {
    available = false;
  }
  test("formats with the project's Prettier and applies ESLint fixes", { skip: !available && "no project with Prettier/ESLint" }, () => {
    const file = join(project, "src", "lib", "__lca_test__.ts");
    writeFileSync(file, "var  x =1\nexport   const y = {a:x}\n");
    try {
      const out = hook("format-file.mjs", { tool_name: "Edit", tool_input: { file_path: file } }, { project });
      assert.equal(out.code, 0, out.stderr);
      assert.equal(readFileSync(file, "utf8"), "const x = 1;\nexport const y = { a: x };\n");
    } finally {
      rmSync(file, { force: true });
    }
  });
  test("reports errors it cannot fix", { skip: !available && "no project with Prettier/ESLint" }, () => {
    const file = join(project, "src", "lib", "__lca_test__.ts");
    writeFileSync(file, "export const z = {;\n");
    try {
      const out = hook("format-file.mjs", { tool_name: "Write", tool_input: { file_path: file } }, { project });
      assert.equal(out.code, 2);
    } finally {
      rmSync(file, { force: true });
    }
  });
  test("shows each warning once per conversation, however often the file is edited", { skip: !available && "no project with Prettier/ESLint" }, (t) => {
    const file = join(project, "src", "lib", "__lca_test__.ts");
    const session_id = `lint-${process.pid}-${Date.now()}`;
    const edit = (text) => {
      writeFileSync(file, text);
      return hook("format-file.mjs", { session_id, tool_name: "edit", tool_input: { file_path: file } }, { project }).json?.hookSpecificOutput?.additionalContext ?? "";
    };
    try {
      const first = edit("const unusedHere = 1;\nexport const y = 2;\n");
      if (!/unusedHere/.test(first)) return t.skip("this project's ESLint does not warn about unused variables");
      assert.equal(edit("const unusedHere = 1;\n\nexport const y = 3;\n"), "", "the same warning again, on another line");
      assert.match(edit("const unusedHere = 1;\nconst alsoUnused = 2;\nexport const y = 3;\n"), /alsoUnused/);
    } finally {
      rmSync(file, { force: true });
    }
  });
  test("flags synchronous params in Next.js 15+ route files, which the type checks accept", () => {
    const sync = "export default function Page({ params }: { params: { id: string } }) {\n  return <p>{params.id}</p>;\n}\n";
    const asyncPage =
      "export default async function Page({ params }: { params: Promise<{ id: string }> }) {\n  const { id } = await params;\n  return <p>{id}</p>;\n}\n";
    const run = (next, path, text) => {
      const project = tempProject({ dependencies: { next } }, { [path]: text });
      return hook("format-file.mjs", { tool_name: "Write", tool_input: { file_path: join(project, path) } }, { project });
    };
    const flagged = run("16.3.8", "src/app/posts/[id]/page.tsx", sync);
    assert.equal(flagged.code, 2);
    assert.match(flagged.stderr, /page\.tsx:1 .*Promises in Next\.js 15\+/);
    assert.equal(run("16.3.8", "src/app/posts/[id]/page.tsx", asyncPage).code, 0);
    assert.equal(run("^14.2.0", "src/app/posts/[id]/page.tsx", sync).code, 0);
    assert.equal(run("16.3.8", "src/components/post.tsx", sync).code, 0);
  });
  test("formats the components `shadcn add` generated, after that command only", { skip: !available && "no project with Prettier/ESLint" }, () => {
    const file = join(project, "src", "components", "ui", "__lca_test__.tsx");
    mkdirSync(dirname(file), { recursive: true });
    const add = (command) => hook("deps-check.mjs", { tool_name: "Bash", tool_input: { command } }, { project, env: { LOCAL_AGENT_OFFLINE: "1" } });
    try {
      writeFileSync(file, "export   const  a = {b:1}\n");
      assert.equal(add("npm test").code, 0);
      assert.equal(readFileSync(file, "utf8"), "export   const  a = {b:1}\n");
      assert.equal(add("echo n | npx shadcn@latest add dialog --yes").code, 0);
      assert.equal(readFileSync(file, "utf8"), "export const a = { b: 1 };\n");
    } finally {
      rmSync(file, { force: true });
    }
  });
  test("flags a Response kept in a module variable, which only the first request gets whole", () => {
    // The 2026-10-28 kit run's 409 for duplicate names: every duplicate after the first got an empty body.
    const run = (text, path = "src/app/api/projects/route.ts") => {
      const project = tempProject({}, { [path]: text });
      return hook("format-file.mjs", { tool_name: "write_file", tool_input: { file_path: join(project, path) } }, { project });
    };
    const handler = "export function POST() {\n  return duplicateResponse;\n}\n";
    const shared = run(`${handler}\nconst duplicateResponse = Response.json(\n  { error: "A project with this name already exists" },\n  { status: 409 },\n);\n`);
    assert.equal(shared.code, 2);
    assert.match(shared.stderr, /route\.ts:5 `duplicateResponse` is one Response made when the module loads/);
    assert.equal(run('const notFound =\n  NextResponse.json({ error: "Not found" }, { status: 404 });\n').code, 2, "Prettier's line break");
    assert.equal(run('export const gone: Response = new Response("Gone", { status: 410 });\n').code, 2);
    assert.equal(run('const duplicate = () =>\n  Response.json({ error: "x" }, { status: 409 });\n').code, 0, "a function makes one per call");
    assert.equal(run("export function GET() {\n  const response = Response.json([]);\n  return response;\n}\n").code, 0, "inside a function");
    assert.equal(run("const noContent = new Response(null, { status: 204 });\n").code, 0, "no body to use up");
    assert.equal(run('const r = Response.json({});\n', "tests/route.test.ts").code, 0, "a test");
  });
  test("leaves files outside the project and projects without tools alone", () => {
    const bare = tempProject({ scripts: {} }, { "a.ts": "var  x=1" });
    assert.equal(hook("format-file.mjs", { tool_input: { file_path: join(bare, "a.ts") } }, { project: bare }).code, 0);
    assert.equal(readFileSync(join(bare, "a.ts"), "utf8"), "var  x=1");
  });
});

describe("dependency news", () => {
  // A stand-in for deps.dev in its own process (the hooks run with spawnSync, which would block a
  // server in this process). Package names are unique per run, so the shared cache cannot interfere.
  const id = `${process.pid}${Date.now()}`;
  const pkg = { fresh: `lca-fresh-${id}`, old: `lca-old-${id}`, steady: `lca-steady-${id}` };
  const releases = {
    // major 3 came out after the default cutoff (2026-03)
    [pkg.fresh]: [["2.0.0", "2025-01-10"], ["3.0.0", "2026-07-01"], ["3.1.0", "2026-08-01"]],
    // installed 5, latest 7
    [pkg.old]: [["5.3.4", "2022-01-01"], ["6.0.0", "2023-01-01"], ["7.2.0", "2025-05-01"]],
    // installed and latest are both old: nothing to say
    [pkg.steady]: [["1.0.0", "2020-01-01"], ["1.2.0", "2024-01-01"]],
  };
  let server;
  let api;
  before(async () => {
    const body = JSON.stringify(
      Object.fromEntries(
        Object.entries(releases).map(([name, list]) => [
          name,
          { versions: list.map(([version, date], i) => ({ versionKey: { version }, publishedAt: `${date}T00:00:00Z`, isDefault: i === list.length - 1 })) },
        ]),
      ),
    );
    server = spawn(process.execPath, ["-e", `
      const data = ${body};
      require("node:http").createServer((req, res) => {
        const name = decodeURIComponent(req.url.split("/").pop());
        if (!data[name]) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(data[name]));
      }).listen(0, "127.0.0.1", function () { console.log(this.address().port); });`]);
    const port = await new Promise((resolve) => server.stdout.once("data", (chunk) => resolve(String(chunk).trim())));
    api = `http://127.0.0.1:${port}`;
  });
  after(() => server?.kill());

  const project = (deps, installed = {}) =>
    tempProject(
      { dependencies: deps },
      Object.fromEntries(
        Object.entries(installed).map(([name, version]) => [
          `node_modules/${name}/package.json`,
          JSON.stringify({ name, version, repository: { url: "git+https://github.com/example/thing.git" } }),
        ]),
      ),
    );
  const context = (name, input, dir) =>
    hook(name, input, { project: dir, env: { LOCAL_AGENT_DEPS_API: api, LOCAL_AGENT_MODEL_CUTOFF: "2026-03", SEARXNG_URL: "" } })
      .json?.hookSpecificOutput?.additionalContext ?? "";

  test("session start names versions newer than the training data and versions behind the latest", () => {
    const dir = project(
      { [pkg.fresh]: "^3.1.0", [pkg.old]: "^5.3.4", [pkg.steady]: "^1.2.0" },
      { [pkg.fresh]: "3.1.0", [pkg.old]: "5.3.4", [pkg.steady]: "1.2.0" },
    );
    writeFileSync(join(dir, "node_modules", pkg.fresh, "UPGRADING-v3.md"), "# Upgrading to v3\n");
    const text = context("session-start.mjs", { source: "startup" }, dir);
    assert.match(text, new RegExp(`${pkg.fresh} 3\\.1\\.0 \\(3\\.x since 2026-07-01, newer than your training data\\): code already in the project shows working usage; before using an API it doesn't use yet, .*UPGRADING-v3\\.md`));
    assert.match(text, new RegExp(`${pkg.old} 5\\.3\\.4 \\(latest is 7\\.2\\.0\\): write code for the installed 5\\.x`));
    assert.doesNotMatch(text, new RegExp(pkg.steady));
  });

  test("after an install it reports only what changed, and flags an old version pinned without need", () => {
    const dir = project({ [pkg.steady]: "^1.2.0" }, { [pkg.steady]: "1.2.0" });
    hook("session-start.mjs", { source: "startup" }, { project: dir, env: { LOCAL_AGENT_DEPS_API: api } });
    // What `npm install` leaves behind: package.json and node_modules both updated.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { [pkg.steady]: "^1.2.0", [pkg.old]: "^5.3.4", [pkg.fresh]: "^3.1.0" } }));
    for (const [name, version] of [[pkg.old, "5.3.4"], [pkg.fresh, "3.1.0"]]) {
      mkdirSync(join(dir, "node_modules", name), { recursive: true });
      writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, version, repository: "github:example/thing" }));
    }
    const text = context("deps-check.mjs", { tool_name: "Bash", tool_input: { command: `npm install ${pkg.old}@5 ${pkg.fresh}` } }, dir);
    assert.match(text, new RegExp(`${pkg.old} 5\\.3\\.4 was just installed, but 7\\.2\\.0 is the latest`));
    assert.match(text, new RegExp(`${pkg.fresh} 3\\.1\\.0 \\(3\\.x since .*release notes \\(https://github\\.com/example/thing/releases\\)`));
    assert.match(text, /with the version that made it/);
    assert.doesNotMatch(text, new RegExp(pkg.steady));
    assert.match(text, /Lessons section of AGENTS\.md/);
    // The same install again changes nothing, so there is nothing to report.
    assert.equal(context("deps-check.mjs", { tool_name: "Bash", tool_input: { command: `npm install ${pkg.old}@5` } }, dir), "");
  });

  test("after an install it reports high and critical vulnerabilities in what ships, not dev tools", () => {
    const dir = project({ [pkg.steady]: "^1.2.0" }, { [pkg.steady]: "1.2.0" });
    writeFileSync(join(dir, "package-lock.json"), "{}");
    hook("session-start.mjs", { source: "startup" }, { project: dir, env: { LOCAL_AGENT_DEPS_API: api } });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { [pkg.steady]: "^1.2.0", [pkg.fresh]: "^3.1.0" } }));
    mkdirSync(join(dir, "node_modules", pkg.fresh), { recursive: true });
    writeFileSync(join(dir, "node_modules", pkg.fresh, "package.json"), JSON.stringify({ name: pkg.fresh, version: "3.1.0" }));
    // What `npm audit --omit=dev --json` prints: dev-only packages are already left out by npm.
    const audit = join(dir, "audit.json");
    writeFileSync(audit, JSON.stringify({
      vulnerabilities: {
        "bad-parser": { severity: "critical", via: [{ title: "Prototype pollution in bad-parser" }] },
        "uses-bad-parser": { severity: "high", via: ["bad-parser"] },
        "meh-lib": { severity: "moderate", via: [{ title: "Minor issue" }] },
      },
    }));
    const text = hook("deps-check.mjs", { tool_name: "Bash", tool_input: { command: `npm install ${pkg.fresh}` } }, {
      project: dir,
      env: { LOCAL_AGENT_DEPS_API: api, LOCAL_AGENT_MODEL_CUTOFF: "2026-03", LOCAL_AGENT_AUDIT_FILE: audit },
    }).json?.hookSpecificOutput?.additionalContext ?? "";
    assert.match(text, /vulnerabilities in packages the app ships/);
    assert.match(text, /- bad-parser \(critical: Prototype pollution in bad-parser\)/);
    assert.match(text, /- uses-bad-parser \(high\)/);
    assert.doesNotMatch(text, /meh-lib/);
    assert.match(text, /--force` changes major versions, so ask first/);
  });

  test("no audit report when offline is set, or when npm audit answers with an error", () => {
    const install = (env) => {
      const dir = project({});
      writeFileSync(join(dir, "package-lock.json"), "{}");
      hook("session-start.mjs", { source: "startup" }, { project: dir, env: { LOCAL_AGENT_DEPS_API: api } });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { [pkg.steady]: "^1.2.0" } }));
      mkdirSync(join(dir, "node_modules", pkg.steady), { recursive: true });
      writeFileSync(join(dir, "node_modules", pkg.steady, "package.json"), JSON.stringify({ name: pkg.steady, version: "1.2.0" }));
      const audit = join(dir, "audit.json");
      writeFileSync(audit, env.error ? JSON.stringify({ error: { code: "ENOTFOUND" } }) : JSON.stringify({ vulnerabilities: { x: { severity: "critical", via: [] } } }));
      return hook("deps-check.mjs", { tool_name: "Bash", tool_input: { command: `npm install ${pkg.steady}` } }, {
        project: dir,
        env: { LOCAL_AGENT_DEPS_API: api, LOCAL_AGENT_AUDIT_FILE: audit, LOCAL_AGENT_OFFLINE: env.offline ? "1" : "" },
      });
    };
    const offline = install({ offline: true });
    assert.equal(offline.code, 0);
    assert.doesNotMatch(offline.stdout, /vulnerabilities/);
    const failed = install({ error: true });
    assert.equal(failed.code, 0);
    assert.doesNotMatch(failed.stdout, /vulnerabilities/);
  });

  test("ignores other commands, and says nothing when it cannot reach the registry", () => {
    const dir = project({ [pkg.fresh]: "^3.1.0" }, { [pkg.fresh]: "3.1.0" });
    assert.equal(context("deps-check.mjs", { tool_name: "Bash", tool_input: { command: "npm test" } }, dir), "");
    const offline = hook("session-start.mjs", { source: "startup" }, { project: project({ [`lca-unknown-${id}`]: "^1.0.0" }), env: { LOCAL_AGENT_DEPS_API: "http://127.0.0.1:9" } });
    assert.equal(offline.code, 0);
    assert.doesNotMatch(offline.json.hookSpecificOutput.additionalContext, /Dependencies to know about/);
  });
});

describe("status", () => {
  // Stand-ins in this process; status.mjs runs as a child process (spawn, not spawnSync).
  const http = (handler) =>
    new Promise((resolve) => {
      const server = createServer(handler).listen(0, "127.0.0.1", () => resolve(server));
    });
  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const runStatus = (env, args = []) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [join(kit, "launcher", "status.mjs"), ...args], { env: { ...process.env, ...env } });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.on("close", (code) => resolve({ code, out }));
    });
  const url = (server) => `http://127.0.0.1:${server.address().port}`;

  test("reports each part, and why the ones that are not right are not", async () => {
    const model = await http((req, res) => json(res, 200, { data: [{ id: "qwen3.8-27b", status: { value: "unloaded" } }] }));
    const searx = await http((req, res) => json(res, 403, {}));
    try {
      const { code, out } = await runStatus({ LOCAL_AGENT_URL: url(model), LOCAL_AGENT_SEARXNG_URL: url(searx) });
      assert.equal(code, 0, out);
      assert.match(out, /OK\s+Model server\s+qwen3\.8-27b not loaded \(the next request loads it/);
      assert.match(out, /WARN\s+SearXNG\s+answers, but its JSON output is off/);
    } finally {
      for (const s of [model, searx]) s.close();
    }
  });

  test("--speed warns when the loaded model writes too slowly (part of it in normal RAM)", async () => {
    const serve = (tps) =>
      http((req, res) =>
        req.method === "POST"
          ? json(res, 200, { choices: [], timings: { predicted_per_second: tps } })
          : json(res, 200, { data: [{ id: "qwen3.8-27b", status: { value: "loaded" } }] }),
      );
    const slow = await serve(12.3);
    const fast = await serve(61.4);
    try {
      const off = "http://127.0.0.1:9";
      const s = await runStatus({ LOCAL_AGENT_URL: url(slow), LOCAL_AGENT_SEARXNG_URL: off }, ["--speed"]);
      assert.match(s.out, /WARN\s+Model speed\s+writes only 12\.3 tok\/s .*normal RAM/);
      const f = await runStatus({ LOCAL_AGENT_URL: url(fast), LOCAL_AGENT_SEARXNG_URL: off }, ["--speed"]);
      assert.match(f.out, /OK\s+Model speed\s+writes 61 tok\/s/);
      const plain = await runStatus({ LOCAL_AGENT_URL: url(fast), LOCAL_AGENT_SEARXNG_URL: off });
      assert.doesNotMatch(plain.out, /Model speed/, "only with --speed");
    } finally {
      slow.close();
      fast.close();
    }
  });

  test("fails when the model server is down, or serves another model", async () => {
    const down = await runStatus({ LOCAL_AGENT_URL: "http://127.0.0.1:9", LOCAL_AGENT_SEARXNG_URL: "http://127.0.0.1:9" });
    assert.equal(down.code, 1);
    assert.match(down.out, /DOWN\s+Model server\s+no answer .*start-server\.cmd/);
    const other = await http((req, res) => json(res, 200, { data: [{ id: "something-else", status: { value: "loaded" } }] }));
    try {
      const r = await runStatus({ LOCAL_AGENT_URL: url(other) });
      assert.equal(r.code, 1);
      assert.match(r.out, /WARN\s+Model server\s+answers, but has no model "qwen3\.8-27b"/);
    } finally {
      other.close();
    }
  });
});

describe("the kit's project files", () => {
  const project = join(kit, "kit");
  const json = (path) => JSON.parse(readFileSync(join(project, path), "utf8"));

  test("kit scripts have no control characters in regexes (a project's oxlint fails on them)", () => {
    const dirs = [join(kitDir, "scripts"), join(kitDir, "scripts", "lib")];
    for (const dir of dirs) {
      for (const name of readdirSync(dir).filter((f) => f.endsWith(".mjs"))) {
        const text = readFileSync(join(dir, name), "utf8");
        assert.doesNotMatch(text, /\/[^/\n]*\\(x1[0-9a-f]|x0[0-9a-f]|u001[0-9a-f]|u000[0-9a-f])[^/\n]*\/[gimsuy]*/i, name);
      }
    }
  });

  test("every hook in .qwen/settings.json runs a script that exists", () => {
    const hooks = json(".qwen/settings.json").hooks;
    const commands = Object.values(hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command)));
    assert.ok(commands.length >= 8);
    for (const command of commands) {
      // A path relative to the project, without quotes: Qwen Code starts hooks in the project folder,
      // and on Windows it runs them through cmd, where quotes (its own around $QWEN_PROJECT_DIR too) break.
      const m = /^node (\.qwen\/kit\/scripts\/[\w-]+\.mjs)$/.exec(command);
      assert.ok(m, command);
      assert.ok(existsSync(join(project, m[1])), m[1]);
    }
  });

  test("the kit is for Qwen Code only", () => {
    for (const name of [".claude", "CLAUDE.md", ".mcp.json"]) assert.ok(!existsSync(join(project, name)), name);
  });

  test("its text for the model names Qwen Code's tools", () => {
    const style = readFileSync(join(kitDir, "prompt", "working-style.md"), "utf8");
    assert.match(style, /grep_search/);
    // Qwen's shell tool says is_background; its agent tool says run_in_background.
    assert.doesNotMatch(style, /watchers with `run_in_background`|\bEdit or Write\b|\bGrep\b/);
    assert.match(style, /watchers with `is_background: true`/);
    // The context hook has one note now, near compaction (2026-10-24).
    assert.doesNotMatch(style, /60%/);
    assert.match(readFileSync(join(project, ".qwen", "agents", "tester.md"), "utf8"), /^tools: read_file, grep_search, glob, run_shell_command, edit, write_file$/m);
  });

  test("the model picks a default instead of stopping to ask, unless only the user can answer", () => {
    // A one-prompt vibe-coding run ends at a question; "ask which auth library" could end "add accounts" (2026-10-28).
    const text = (path) => readFileSync(join(project, path), "utf8");
    assert.doesNotMatch(text(".qwen/kit/prompt/working-style.md"), /Two reasonable meanings: ask/);
    assert.match(text(".qwen/kit/prompt/working-style.md"), /take the likelier one/);
    assert.doesNotMatch(text(".qwen/skills/plan-work/SKILL.md"), /ask one short question|ask the user once/);
    assert.doesNotMatch(text(".qwen/skills/security/SKILL.md"), /Ask the user which library/);
    assert.doesNotMatch(text(".qwen/kit/scripts/focus.mjs"), /ask (the user|them one short question)/);
  });
  test("the helper agents run in the foreground", () => {
    // Qwen Code starts an agent in the background unless told otherwise; a reviewer then answered after the report.
    for (const name of readdirSync(join(project, ".qwen", "agents"))) {
      assert.match(readFileSync(join(project, ".qwen", "agents", name), "utf8"), /^background: false$/m, name);
    }
  });

  test("its session start adds .qwen/ to .prettierignore", () => {
    const dir = tempProject({ devDependencies: { prettier: "3" } });
    const run = hook("session-start.mjs", { source: "startup" }, { project: dir, env: { LOCAL_AGENT_OFFLINE: "1" } });
    assert.equal(run.code, 0, run.stderr);
    assert.match(readFileSync(join(dir, ".prettierignore"), "utf8"), /^# Qwen Code kit .*\n\.qwen\/$/m);
    assert.match(run.stdout, /`\.qwen\/` to `\.prettierignore`/);
  });

  test("the generator hint moves the generated app with one command that works in every shell", () => {
    const shared = readFileSync(join(project, ".qwen/kit/scripts/lib/project.mjs"), "utf8");
    const command = /node -e \\"(.+?)\\"/.exec(shared)?.[1];
    assert.ok(command, "the move command");
    const dir = tempProject(null, { "NAME/a.txt": "a", "NAME/.hidden": "h", "NAME/sub/b.txt": "b", "NAME/README.md": "generated", "README.md": "mine" });
    const run = spawnSync(process.execPath, ["-e", command], { cwd: dir, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /left in NAME: README\.md/);
    for (const name of ["a.txt", ".hidden", "sub/b.txt"]) assert.ok(existsSync(join(dir, name)), name);
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "mine", "an existing file is never overwritten");
  });
});

describe("SETUP-FOR-AI.md and the kit's removal", () => {
  // The AI installs and updates the kit with copy-kit.mjs, and removes it with REMOVE.md's steps.
  const setup = readFileSync(join(kit, "SETUP-FOR-AI.md"), "utf8");
  const source = join(kit, "kit");
  const copy = (cwd) => spawnSync(process.execPath, [join(kit, "copy-kit.mjs")], { cwd, encoding: "utf8" });
  const remove = (cwd) => spawnSync(process.execPath, [join(cwd, ".qwen/kit/scripts/remove.mjs")], { cwd, encoding: "utf8" });
  const read = (dir, name) => readFileSync(join(dir, name), "utf8");
  const version = read(source, ".qwen/kit/VERSION").trim();

  test("names the copy script and the removal steps", () => {
    assert.match(setup, /^node "<temp>\/local-coding-kit\/copy-kit\.mjs"$/m);
    assert.match(version, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(read(source, "QWEN.md"), /`\.qwen\/kit\/REMOVE\.md`/);
    assert.ok(existsSync(join(source, ".qwen/kit/REMOVE.md")));
  });

  test("copies the kit, never overwrites the project's own files, and records what it added", () => {
    const dir = tempProject({ scripts: {} }, { "QWEN.md": "mine\n" });
    const out = copy(dir);
    assert.equal(out.status, 0, out.stderr);
    assert.ok(out.stdout.includes(`Copied the kit (version ${version}).`), out.stdout);
    assert.match(out.stdout, /Kept as they were: QWEN\.md/);
    assert.equal(read(dir, "QWEN.md"), "mine\n");
    for (const name of [".qwen/settings.json", ".qwen/kit/scripts/guard.mjs", ".qwen/kit/prompt/working-style.md", ".qwen/agents/reviewer.md", ".qwen/skills/debug/SKILL.md"]) {
      assert.ok(existsSync(join(dir, name)), name);
    }
    const record = JSON.parse(read(dir, ".qwen/kit/installed.json"));
    assert.ok(".qwen/settings.json" in record.added && !("QWEN.md" in record.added), "only what it added");
    assert.equal(record.kit["QWEN.md"], read(source, "QWEN.md"), "the kit's own version of a shared file");
    assert.doesNotMatch(copy(tempProject(null)).stdout, /Kept/);
  });

  test("an update replaces the kit's files, keeps the ones the user changed and the project's own", () => {
    const dir = tempProject(null);
    copy(dir);
    writeFileSync(join(dir, ".qwen/kit/scripts/guard.mjs"), "// old\n");
    writeFileSync(join(dir, ".qwen/kit/VERSION"), "2026-01-01\n");
    writeFileSync(join(dir, ".qwen/settings.json"), "{}\n");
    writeFileSync(join(dir, ".qwen/skills/debug/SKILL.md"), "my own steps\n");
    // A folder without package.json gets every framework skill, on an update too.
    rmSync(join(dir, ".qwen/skills/vue"), { recursive: true });
    // An older kit file nobody changed: its hash in the record matches.
    writeFileSync(join(dir, ".qwen/agents/reviewer.md"), "an older version\n");
    const record = JSON.parse(read(dir, ".qwen/kit/installed.json"));
    record.added[".qwen/agents/reviewer.md"] = createHash("sha1").update("an older version\n").digest("hex");
    writeFileSync(join(dir, ".qwen/kit/installed.json"), JSON.stringify(record));
    const out = copy(dir);
    assert.equal(out.status, 0, out.stderr);
    assert.ok(out.stdout.includes(`Updated the kit from version 2026-01-01 to ${version}.`), out.stdout);
    assert.match(out.stdout, /Kept as they were: .*\.qwen\/settings\.json/);
    assert.match(out.stdout, /Kept as they were: .*\.qwen\/skills\/debug\/SKILL\.md/);
    assert.equal(read(dir, ".qwen/kit/scripts/guard.mjs"), read(source, ".qwen/kit/scripts/guard.mjs"));
    assert.equal(read(dir, ".qwen/agents/reviewer.md"), read(source, ".qwen/agents/reviewer.md"));
    assert.equal(read(dir, ".qwen/settings.json"), "{}\n");
    assert.equal(read(dir, ".qwen/skills/debug/SKILL.md"), "my own steps\n");
    assert.ok(existsSync(join(dir, ".qwen/skills/vue/SKILL.md")), "no package.json: every framework skill");
    // A kit from before the record: everything in its folders counts as the kit's.
    const old = tempProject(null);
    copy(old);
    rmSync(join(old, ".qwen/kit/installed.json"));
    rmSync(join(old, ".qwen/kit/VERSION"));
    writeFileSync(join(old, ".qwen/skills/debug/SKILL.md"), "older\n");
    assert.match(copy(old).stdout, /from version older \(no number\)/);
    assert.equal(read(old, ".qwen/skills/debug/SKILL.md"), read(source, ".qwen/skills/debug/SKILL.md"));
    assert.ok(existsSync(join(old, ".qwen/kit/installed.json")));
  });

  test("leaves out the framework skills the project does not use, also on an update", () => {
    // The model deleted them with a recursive delete, which the kit's guard stopped on an update (2026-10-28).
    const skills = (dir) => readdirSync(join(dir, ".qwen/skills")).filter((n) => /^(react-nextjs|shadcn-ui|vue|angular|vanilla-web)$/.test(n)).sort();
    const next = tempProject({ dependencies: { next: "16", react: "19" } });
    const out = copy(next);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /Left out the framework skills this project does not use: angular, shadcn-ui, vanilla-web, vue$/m);
    assert.deepEqual(skills(next), ["react-nextjs"]);
    writeFileSync(join(next, ".qwen/kit/VERSION"), "2026-01-01\n");
    assert.equal(copy(next).status, 0);
    assert.deepEqual(skills(next), ["react-nextjs"], "an update does not bring them back");
    const nuxt = tempProject({ dependencies: { nuxt: "4" } });
    copy(nuxt);
    assert.deepEqual(skills(nuxt), ["vue"]);
    const shadcn = tempProject({ dependencies: { next: "16" } }, { "components.json": "{}" });
    copy(shadcn);
    assert.deepEqual(skills(shadcn), ["react-nextjs", "shadcn-ui"]);
    const plain = tempProject({ devDependencies: { typescript: "5", vite: "7" } });
    copy(plain);
    assert.deepEqual(skills(plain), ["vanilla-web"]);
    // One the project has already stays and is updated like any other kit file.
    const kept = tempProject({ dependencies: { next: "16" } }, { ".qwen/skills/vue/SKILL.md": "my vue notes\n" });
    copy(kept);
    assert.equal(read(kept, ".qwen/skills/vue/SKILL.md"), "my vue notes\n");
  });

  test("adds .local-agent/ to .gitignore in a git repository, once", () => {
    const repo = tempProject(null, { ".git/HEAD": "ref: refs/heads/main\n", ".gitignore": "node_modules" });
    assert.match(copy(repo).stdout, /Added \.local-agent\/ .* to \.gitignore/);
    copy(repo);
    assert.equal(read(repo, ".gitignore"), "node_modules\n\n# Qwen Code kit: the plan of the current task\n.local-agent/\n");
    const fresh = tempProject(null, { ".git/HEAD": "ref: refs/heads/main\n" });
    copy(fresh);
    assert.equal(read(fresh, ".gitignore"), "# Qwen Code kit: the plan of the current task\n.local-agent/\n");
    const noGit = tempProject(null);
    copy(noGit);
    assert.ok(!existsSync(join(noGit, ".gitignore")));
  });

  test("the removal takes the kit's parts out of the shared files and its ignore lines, and keeps the user's", () => {
    // The model edited these by hand, the guard asked twice, and .prettierignore was left (2026-10-28).
    const dir = tempProject(
      { dependencies: { next: "16" }, devDependencies: { prettier: "3" } },
      { ".git/HEAD": "ref: refs/heads/main\n", ".gitignore": "node_modules\n", ".prettierignore": "build/\n", "QWEN.md": "- My own rule.\n" },
    );
    copy(dir);
    // What the setup's merge step and the kit's session start leave behind.
    writeFileSync(join(dir, "QWEN.md"), `- My own rule.\n\n${read(source, "QWEN.md")}`);
    const settings = JSON.parse(read(dir, ".qwen/settings.json"));
    settings.env.MY_OWN = "1";
    settings.permissions.allow.push("Bash(make *)");
    settings.$version = 4;
    writeFileSync(join(dir, ".qwen/settings.json"), JSON.stringify(settings, null, 2));
    writeFileSync(join(dir, ".prettierignore"), "build/\n# Qwen Code kit (agent tooling, not app code)\n.qwen/\n");
    mkdirSync(join(dir, ".local-agent"));
    writeFileSync(join(dir, ".local-agent/plan.md"), "# Plan\n");
    const out = remove(dir);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(read(dir, "QWEN.md"), "- My own rule.\n");
    assert.deepEqual(JSON.parse(read(dir, ".qwen/settings.json")), { env: { MY_OWN: "1" }, permissions: { allow: ["Bash(make *)"] }, $version: 4 });
    assert.equal(read(dir, ".gitignore"), "node_modules\n");
    assert.equal(read(dir, ".prettierignore"), "build/\n");
    assert.ok(!existsSync(join(dir, ".local-agent")));
    assert.match(out.stdout, /took the kit's settings out of \.qwen\/settings\.json and kept yours/);
    // Only the kit's settings (and Qwen Code's own marker): the file goes. The user's own `.qwen/` ignore line stays.
    const plain = tempProject(null, { ".prettierignore": ".qwen/\n" });
    copy(plain);
    const kitOnly = JSON.parse(read(plain, ".qwen/settings.json"));
    writeFileSync(join(plain, ".qwen/settings.json"), JSON.stringify({ ...kitOnly, $version: 4 }));
    assert.equal(remove(plain).status, 0);
    assert.ok(!existsSync(join(plain, ".qwen")));
    assert.ok(!existsSync(join(plain, "QWEN.md")));
    assert.equal(read(plain, ".prettierignore"), ".qwen/\n");
  });

  test("the removal deletes only the kit's unchanged files and leaves the project's", () => {
    const dir = tempProject({ scripts: {} }, { ".qwen/skills/mine/SKILL.md": "mine\n", "src/app.ts": "x\n" });
    copy(dir);
    writeFileSync(join(dir, ".qwen/skills/debug/SKILL.md"), "changed\n");
    const out = remove(dir);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /Removed \.qwen\/kit and \d+ other files/);
    assert.match(out.stdout, /left as they are: \.qwen\/skills\/debug\/SKILL\.md$/m);
    for (const name of [".qwen/kit", ".qwen/agents", ".qwen/settings.json", "QWEN.md", ".qwen/skills/react-nextjs"]) assert.ok(!existsSync(join(dir, name)), name);
    for (const name of [".qwen/skills/mine/SKILL.md", ".qwen/skills/debug/SKILL.md", "src/app.ts", "package.json"]) assert.ok(existsSync(join(dir, name)), name);
    // Without a record it deletes nothing.
    const old = tempProject(null);
    copy(old);
    rmSync(join(old, ".qwen/kit/installed.json"));
    assert.equal(remove(old).status, 1);
    assert.ok(existsSync(join(old, ".qwen/kit/scripts/guard.mjs")));
  });
});
