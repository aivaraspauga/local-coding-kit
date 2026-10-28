// Stop hook: the agent may not finish while the project's checks fail, and gets one reminder to
// review what it changed: debugging leftovers (temporary scripts, console.log, .only) and risky
// lines (secrets, silenced errors, raw HTML, SQL from strings, a changed AGENTS.md; lib/risks.mjs).
// Runs only when project files changed since the session started (or since the last pass), so a
// question in a project with existing failures is not blocked. Skips the run when the model's own
// run of the check command passed on the same files (focus.mjs records it). Re-runs a failing test
// once to rule out a flaky one, and gives up after MAX_BLOCKS failed attempts in a row so it cannot
// loop forever.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { findLeftovers } from "./lib/leftovers.mjs";
import { findRisks } from "./lib/risks.mjs";
import {
  changedFiles,
  checkCommand,
  fileSignatures,
  fingerprint,
  output,
  PLAN_FILE,
  planSignature,
  projectRoot,
  readInput,
  readState,
  writeState,
} from "./lib/project.mjs";

const MAX_BLOCKS = 3;
// Files that hold notes for the agent or the tools, not code.
const NOTES_ONLY = /^(QWEN|AGENTS|CLAUDE)\.md$|^\.(gitignore|prettierignore)$/;
const MAX_PLAN_STEPS_SHOWN = 6;
// Type, lint and build errors fail the same way every time, so a second run only doubles the wait.
// Only a test failure can be flaky.
const SAME_EVERY_TIME = /\berror TS\d+|\b\d+ problems? \(|Failed to compile|Build error occurred|Type error:/;
// The model's answer to this hook becomes its last message. Without this line it answered only the
// hook's items, and the report the user asked for was lost (both Opus kit runs, 2026-10-24).
const REPORT_AGAIN =
  "Your next message is the last one the user reads. When you are done here, give your full report again (what you built or changed, the commands you ran and their results, how to start it, what is not done), with these points added, not only your answer to them.";

const input = readInput();
const root = projectRoot();
const command = checkCommand(root);

function runCheck() {
  return spawnSync(command, {
    cwd: root,
    shell: true,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 14 * 60 * 1000,
    // CI=1 stops test runners from starting in watch mode.
    env: { ...process.env, CI: "1" },
  });
}

const state = readState(root, input.session_id);
const now = fingerprint(root);
if (now === state.passed || now === state.sessionStart) {
  if (state.failures) writeState(root, input.session_id, { ...state, failures: 0 });
  process.exit(0);
}

// Unchecked steps of a plan this session wrote or changed. An older plan about other work stays out
// of it, and without the session's start (no session-start run) nothing is known, so nothing shows.
// Open steps are not a failure: the model finishes them or names them as not done, so this shows once.
function openPlanSteps() {
  if (state.planShown || !("planStart" in state) || planSignature(root) === state.planStart) return [];
  try {
    const plan = readFileSync(join(root, PLAN_FILE), "utf8");
    return [...plan.matchAll(/^\s*[-*] \[ \]\s*(.+)$/gm)].map((match) => match[1].trim());
  } catch {
    return [];
  }
}

// After the checks pass (or when the project has none): one reminder about leftovers, risks and
// unfinished plan steps.
function finish(message) {
  const passedState = { ...state, passed: fingerprint(root), failures: 0 };
  // Without the session's starting file list every file would look new, so skip the scan.
  let leftovers = [];
  let risks = [];
  try {
    const changed = state.startFiles ? changedFiles(root, state.startFiles) : [];
    leftovers = state.startFiles ? findLeftovers(root, changed, state.startFiles) : [];
    risks = state.startFiles ? findRisks(root, changed, state.startFiles) : [];
  } catch {
    // An unreadable file must not break the Stop hook; skip the review.
  }
  // Each finding is shown once per session: the model fixes it or says why it stays, and keeping
  // one should not bring it back when another is fixed. A finding is keyed without the quoted line.
  const shown = new Set(state.reviewShown ?? []);
  const keyOf = (item) => item.replace(/ \(`.*`\)$/, "");
  leftovers = leftovers.filter((item) => !shown.has(keyOf(item)));
  risks = risks.filter((item) => !shown.has(keyOf(item)));
  const openSteps = openPlanSteps();
  if (leftovers.length + risks.length + openSteps.length > 0) {
    writeState(root, input.session_id, {
      ...passedState,
      reviewShown: [...shown, ...[...leftovers, ...risks].map(keyOf)],
      planShown: passedState.planShown || openSteps.length > 0,
    });
    console.error(
      [
        `${message ? `${message}. ` : ""}Before you finish, review what you changed.`,
        ...(leftovers.length ? ["These look like debugging leftovers:", ...leftovers.map((item) => `- ${item}`)] : []),
        ...(risks.length
          ? ["These need a second look (the `security` skill says what to do instead):", ...risks.map((item) => `- ${item}`)]
          : []),
        ...(leftovers.length + risks.length
          ? ["Fix them, or keep them if they are intended and say why in your report."]
          : []),
        ...(openSteps.length
          ? [
              `Your plan (\`${PLAN_FILE}\`) still has ${openSteps.length} unchecked step${openSteps.length === 1 ? "" : "s"}:`,
              ...openSteps.slice(0, MAX_PLAN_STEPS_SHOWN).map((step) => `- ${step}`),
              ...(openSteps.length > MAX_PLAN_STEPS_SHOWN ? [`- … and ${openSteps.length - MAX_PLAN_STEPS_SHOWN} more`] : []),
              "Finish them before you report. If you stop here, leave them unchecked, add a line under Notes for each with the reason, and name them in your report as not done. Do not check off a step whose check you did not run.",
            ]
          : []),
        "This reminder is shown once.",
        REPORT_AGAIN,
      ].join("\n"),
    );
    process.exit(2);
  }
  writeState(root, input.session_id, passedState);
  if (message) output({ systemMessage: message });
  process.exit(0);
}

if (!command) finish(null);
// A kit setup, update or removal, or a lesson in AGENTS.md, changes no code, so the checks would
// only repeat the last result: a removal ran typecheck, lint, tests and the build (2026-10-28).
if (state.startFiles) {
  const files = fileSignatures(root);
  const touched = [
    ...Object.keys(files).filter((path) => state.startFiles[path] !== files[path]),
    ...Object.keys(state.startFiles).filter((path) => !(path in files)),
  ];
  if (touched.length > 0 && touched.every((path) => NOTES_ONLY.test(path))) finish(null);
}
// The model's own passing run of this command on these same files (recorded by focus.mjs) counts:
// a benchmark run spent 20-60 s per task repeating it here. Any change since then means a new run.
if (now === state.modelPassed) finish(`Checks passed (\`${command}\`, your own run on these same files)`);

let run = runCheck();
let flaky = false;
if (run.status !== 0 && !SAME_EVERY_TIME.test(`${run.stdout ?? ""}${run.stderr ?? ""}`)) {
  // A real failure fails again; a slow worker or busy machine usually does not.
  const retry = runCheck();
  flaky = retry.status === 0;
  run = retry;
}

if (run.status === 0) {
  finish(
    flaky
      ? `Checks passed on a second run (\`${command}\`; the first run failed, possibly a flaky test)`
      : `Checks passed (\`${command}\`)`,
  );
}

const failures = input.stop_hook_active ? (state.failures ?? 0) + 1 : 1;
writeState(root, input.session_id, { ...state, failures });

if (failures > MAX_BLOCKS) {
  output({
    systemMessage: `The checks still fail after ${MAX_BLOCKS} attempts (\`${command}\`). Stopping so you can take a look.`,
  });
  process.exit(0);
}

// Not an escape-code regex: a project's linter (oxlint's no-control-regex) checks the kit's files too.
const text = stripVTControlCharacters(`${run.stdout ?? ""}${run.stderr ?? ""}`)
  .trim()
  .split("\n")
  .slice(-80)
  .join("\n");

console.error(
  [
    `The project's checks failed (\`${command}\`, attempt ${failures} of ${MAX_BLOCKS}). You are not done yet.`,
    "Fix the cause of the errors below, then run the checks yourself to confirm.",
    // The first failure is often small (formatting, a missed import); a repeat means a wrong assumption.
    ...(failures >= 2
      ? ["They failed again after your fix: think this one through carefully. What did the last fix assume, and what does the error actually say?"]
      : []),
    "If they were already failing before your change and the failure is unrelated, say so to the user instead of fixing it.",
    "Do not weaken tests, lint rules, TypeScript settings or scripts to make them pass.",
    REPORT_AGAIN,
    "",
    text || `(no output; exit code ${run.status ?? run.signal})`,
  ].join("\n"),
);
process.exit(2);
