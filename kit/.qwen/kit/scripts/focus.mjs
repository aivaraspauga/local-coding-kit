// PostToolUse and PostToolUseFailure hook: nudges the model out of rabbit holes. Smaller models
// tend to read compiled dependency code, keep looking things up without acting, think at length
// about small choices, or rerun failing tests without a new idea, until their time or context
// runs out. It never blocks; it adds a short note to the conversation when a threshold is crossed.
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import {
  checkCommand,
  fingerprint,
  isStepCode,
  MOVE_UP_COMMAND,
  output,
  projectRoot,
  readInput,
  readState,
  REVIEW_FILE,
  SMALL_STEP_FILES,
  takeRefused,
  writeState,
} from "./lib/project.mjs";

// A benchmark task (2026-10-11) took Qwen 17 look-ups before its first edit where Claude took 9.
const STREAK_FIRST = 12; // look-ups in a row before the first nudge
const STREAK_EVERY = 10; // then again every this many
const DEPENDENCY_FIRST = 3; // reads of compiled dependency code before the first nudge
const DEPENDENCY_EVERY = 4;
const WEB_FIRST = 5; // web searches and page reads in a row before the first nudge
const WEB_EVERY = 5;
// In the same run, 12 of 173 steps had more than ~2,000 tokens of thinking, and they held half of
// all its thinking (about 13 minutes at 50 tokens/s), much of it drafted code and second-guessing.
const THINK_CHARS = 8000; // about 2,000 tokens
const CODE_LINES = 12; // drafted lines of code in one thought
const FAILED_FIRST = 4; // failing test or check runs since they last passed in full
const FAILED_EVERY = 3;

const input = readInput();
const tool = input.tool_name ?? "";
const params = input.tool_input ?? {};
const event = input.hook_event_name ?? "PostToolUse";
const stateDir = join(tmpdir(), "local-coding-agent");
// Subagents keep their own counts. Searching is an explorer's whole job (its turn limit bounds it),
// so inside a subagent only the dependency-code nudge applies.
const inSubagent = Boolean(input.agent_id);
const stateKey = `${input.session_id ?? "default"}${inSubagent ? `-${input.agent_id}` : ""}`;
const stateFile = join(stateDir, `${stateKey.replace(/[^\w-]/g, "")}.json`);

let state = { streak: 0, dependencyReads: 0, webStreak: 0, failedRuns: 0, pipeNoted: false, thinkNotedId: "", knownErrors: [] };
try {
  state = { ...state, ...JSON.parse(readFileSync(stateFile, "utf8")) };
} catch {
  // first call in this session
}

const text = String(params.command ?? params.file_path ?? params.path ?? params.pattern ?? "")
  .replaceAll("\\", "/");
const READS = /^\s*(cat|head|tail|less|sed\s+-n|grep|rg|find|ls|tree|wc|type|Get-Content|Select-String|Get-ChildItem|dir)\b/i;
// Running the project counts as acting: checks, tests, builds, the dev server, requests to it.
const RUNS = /\b(npm|pnpm|yarn|bun|npx|node|tsc|vitest|jest|playwright|next|curl|Invoke-WebRequest)\b/i;
// Docs, READMEs, type definitions and manifests are the cheap way to learn a library.
const CHEAP_DOCS = /(README|CHANGELOG|\/docs\/|\.d\.[cm]?ts\b|\.md\b|package\.json)/i;
// Test and check runs, how their output reports a failure, and runs limited to some tests.
const TEST_RUN = /\b(test|tests|vitest|jest|playwright|check|typecheck|tsc|lint|eslint)\b/i;
const FAILED_OUTPUT = /\b[1-9]\d* (failed|failing)\b|\berror TS\d+|\b[1-9]\d* problems? \(/;
const TARGETED = /\.(test|spec)\.[cm]?[jt]sx?|\s(tests?|e2e|src)\/|\s-t\s|--grep|\s-g\s|\bdebug\b/i;
const PIPED = /\|\s*(head|tail|grep|findstr|Select-Object|Select-String)\b/i;
const CODE_LINE =
  /^\s*(import |export |const |let |function |return |if \(|<\/?[A-Za-z][\w.]*[ >/]|[}\])];?,?$|await |async |type \w+ =|interface )/;

// Errors with one known fix, each named once per session the first time a shell call shows it.
// Seen in the 2026-10-24 kit vs no-kit runs: each cost Opus a retry, a local model more.
const KNOWN_ERRORS = [
  [
    /ERESOLVE[\s\S]*@types\/node/,
    "ERESOLVE on @types/node: create-next-app writes @types/node ^20, and Vitest 5 needs 22 or 24+. Add @types/node@<your Node major> (from `node -v`) to the same npm install command and run it again. Never use --legacy-peer-deps or --force.",
  ],
  [
    /contains files that could conflict/,
    `The generator refuses a folder that has files in it. Run it again with a new subfolder name NAME instead of \`.\` (and --skip-install). Then move the files up without overwriting what is here, with this command (it works in every shell): ${MOVE_UP_COMMAND} Merge each file it left in NAME with the one here, delete NAME, then npm install.`,
  ],
  [
    /strict mode violation: getByLabel\(/,
    'Playwright\'s getByLabel matches every label, aria-label and aria-labelledby text that contains the words, ignoring case (a "Workshop" field also matches a section labelled "Upcoming workshops"). Use getByLabel("Workshop", { exact: true }).',
  ],
  [
    /strict mode violation: getByRole\(['"]alert['"]/,
    'Next.js adds a hidden route announcer with role="alert" to every page, so getByRole("alert") finds two elements. Use page.getByRole("alert").filter({ hasText: "..." }).',
  ],
  [
    /TS2344: Type '"\/[^']*' does not satisfy the constraint/,
    "Next.js route types are out of date. Run `npx next typegen`, then the type check again.",
  ],
  // A route that was deleted or renamed (or a branch switch) leaves Next's generated validator
  // pointing at it; a run lost minutes reading it (2026-10-28).
  [
    /\.next[\\/](dev[\\/])?types[\\/]\S*\.ts\(\d+,\d+\): error TS2307/,
    "This type error is in a file Next.js generated (in `.next/`) for a route that no longer exists. Delete that one file (the path in the error), then run `npx next typegen` and the type check again. Never edit files in `.next/`.",
  ],
  // React 19 peer ranges (charts, editors, date pickers) and native builds on a Node version too new
  // for prebuilt binaries: both general install blockers (pre-test review, 2026-10-28).
  [
    /ERESOLVE[\s\S]*peer react(-dom)?@/,
    "ERESOLVE on a React peer: this version of the package does not list the installed React. Look up a version that does (`npm view <package> peerDependencies`, or its newest version), install that one, or choose another package. Never use --legacy-peer-deps or --force.",
  ],
  [
    /gyp ERR!|node-pre-gyp|prebuild-install[^\n]*(warn|err)|Could not find any Visual Studio installation/,
    "This package needs a native build (no prebuilt binary for this Node.js version), and that needs a C++ compiler. Use a pure JavaScript package or what Node.js has built in instead: `bcryptjs` for bcrypt, `node:sqlite` for better-sqlite3, `node:crypto` for hashing.",
  ],
  [
    /EADDRINUSE[^\n]*?:(\d{2,5})|[Pp]ort (\d{2,5}) is (already )?in use/,
    "Another program already uses that port. Do not stop it: it is not part of this project. Start the dev server on a free port (`npm run dev -- --port 3100`), and point the tests at the same port.",
  ],
];

// Web search (the optional SearXNG tools) and page reads.
const web = tool.startsWith("mcp__searxng__") || tool === "WebFetch";
const shell = tool === "Bash";

let acted = false;
let lookedUp = false;
if (tool === "Edit" || tool === "Write") acted = true;
else if (tool === "Read" || tool === "Grep" || tool === "Glob" || web) lookedUp = true;
else if (shell) {
  if (READS.test(text)) lookedUp = true;
  else if (RUNS.test(text)) acted = true;
}

// The newest assistant message's thinking, from the end of the session transcript. The transcript
// is written asynchronously and can lag a step; then the note comes one tool call later.
function latestThinking(path) {
  if (!path) return null;
  let tail = "";
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, 512 * 1024);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      tail = buffer.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  let id = null;
  let thinking = "";
  for (const line of tail.split("\n").reverse()) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // the first line of the tail is usually cut
    }
    if (entry.type !== "assistant" || !Array.isArray(entry.message?.parts)) continue;
    // Qwen Code stores thinking as Gemini-style parts marked `thought`.
    const parts = entry.message.parts.filter((part) => part.thought === true);
    if (id === null) {
      if (parts.length === 0) continue;
      id = entry.uuid ?? "";
    } else if (entry.uuid !== id) {
      break;
    }
    // A long answer can be stored as several entries with the same id.
    thinking = parts.map((part) => part.text ?? "").join("\n") + thinking;
  }
  return id === null ? null : { id, thinking };
}

const notes = [];
// Calls the guard refused since the last result, said again where the model reads next (a run
// read past them in a parallel batch and took the files for written, 2026-10-29).
const refused = takeRefused(projectRoot(), input);
if (refused.length > 0) {
  notes.push(
    [
      `NOT DONE: the kit refused ${refused.length === 1 ? "this call" : `these ${refused.length} calls`}, so ${refused.length === 1 ? "it" : "they"} changed nothing:`,
      ...refused.map((line) => `- ${line}`),
      "Your other calls ran. Deal with each reason, then make the refused calls again (or say why not).",
    ].join("\n"),
  );
}
if (acted) {
  state.streak = 0;
  state.webStreak = 0;
}
if (web) {
  state.webStreak += 1;
  const n = state.webStreak;
  if (n === WEB_FIRST || (n > WEB_FIRST && (n - WEB_FIRST) % WEB_EVERY === 0)) {
    notes.push(
      `You have searched or read the web ${n} times since you last changed or ran anything. ` +
        "Write down in two lines what you found, then act on it. Prefer the installed package's docs and types for exact APIs. If the web has not answered the question, make the simplest choice, check it by running the code, and name it in your report.",
    );
  }
}
if (lookedUp) {
  state.streak += 1;
  // A question or a review (reminder.mjs) is all look-ups: telling it to edit was noise (2026-10-27).
  const questionOnly = readState(projectRoot(), input.session_id).question === true;
  if (inSubagent || questionOnly) {
    // no streak nudges inside a subagent, or while the user only asked a question
  } else if (
    state.streak === STREAK_FIRST ||
    (state.streak > STREAK_FIRST && (state.streak - STREAK_FIRST) % STREAK_EVERY === 0)
  ) {
    notes.push(
      `You have made ${state.streak} look-ups in a row without changing or running anything. ` +
        "Write down in two lines what you know and the first file to change, then make that edit now; " +
        "decide the other edits one at a time, not all at once in your head. " +
        "Cannot decide? Take the simpler option, name it in your report, and let the checks tell you if it was wrong.",
    );
  }
  if (/node_modules\//.test(text) && !CHEAP_DOCS.test(text)) {
    state.dependencyReads += 1;
    const n = state.dependencyReads;
    if (n === DEPENDENCY_FIRST || (n > DEPENDENCY_FIRST && (n - DEPENDENCY_FIRST) % DEPENDENCY_EVERY === 0)) {
      notes.push(
        `You have opened compiled dependency code ${n} times. That fills your context and rarely answers the question. ` +
          "Use how this project already uses the library, its README or docs folder, or its .d.ts types. " +
          "If that is not enough, make the simplest reasonable choice and check it by running the code.",
      );
    }
  }
}

// What the shell call printed: the error of a failed call, else its output (a piped run exits 0).
const response = input.tool_response;
const result =
  event === "PostToolUseFailure"
    ? String(input.error ?? "")
    : typeof response === "string"
      ? response
      : `${response?.stdout ?? ""}\n${response?.stderr ?? ""}`;

if (shell) {
  KNOWN_ERRORS.forEach(([pattern, fix], index) => {
    if (!state.knownErrors.includes(index) && pattern.test(result)) {
      state.knownErrors.push(index);
      notes.push(fix);
    }
  });
}

// Test and check runs. A pipe into head or tail makes a failing run exit 0, so the output decides.
if (shell && RUNS.test(text) && TEST_RUN.test(text) && !inSubagent) {
  const failed = (event === "PostToolUseFailure" && !input.is_interrupt) || FAILED_OUTPUT.test(result);
  if (failed) {
    state.failedRuns += 1;
    const n = state.failedRuns;
    if (n === FAILED_FIRST || (n > FAILED_FIRST && (n - FAILED_FIRST) % FAILED_EVERY === 0)) {
      notes.push(
        `The tests or checks have failed ${n} times since they last passed in full. Before you change anything else, write down in three lines: what fails, what you assumed, and what each attempt changed. ` +
          "A test that passes alone but fails with the others, or flips without a code change, is flaky: look at what the tests share (database rows other tests left, a running dev server, timing, a click before hydration) rather than at the feature. " +
          "If the next attempt does not explain the failure, stop and tell the user what you know.",
      );
    }
  } else if (!TARGETED.test(text)) {
    state.failedRuns = 0;
  }
  // The project's own check command passed, unpiped (so its exit code counts): the Stop hook need
  // not run it again while the files stay as they are now.
  if (!failed && event === "PostToolUse" && !PIPED.test(text)) {
    const root = projectRoot();
    const check = checkCommand(root);
    if (check && text.replace(/\s*2>&1\s*/g, " ").trim() === check) {
      writeState(root, input.session_id, { ...readState(root, input.session_id), modelPassed: fingerprint(root) });
    }
  }
  // Piping a passing run to save context is fine; a failing one hides its exit code and often the
  // error, and the model then reruns it with a longer head or tail.
  if (failed && event === "PostToolUse" && PIPED.test(text) && !state.pipeNoted) {
    state.pipeNoted = true;
    notes.push(
      "That run failed, but the pipe through head, tail or grep made it exit 0 and may have cut the error off. While tests or checks fail, run them without a pipe, so you see the whole error in one run; long output is saved to a file you can read with read_file.",
    );
  }
}

// Small steps: the code files changed since the last check, test or build run (a reminder past
// SMALL_STEP_FILES, once per list; the write itself always goes through: a refusal inside a batch
// of parallel writes went unnoticed, 2026-10-29). Any such run clears the list, passing or not:
// the model has seen what its changes do.
if (!inSubagent && (tool === "Edit" || tool === "Write") && event === "PostToolUse") {
  const root = projectRoot();
  const rel = relative(root, resolve(root, String(params.file_path ?? ""))).replaceAll("\\", "/");
  const projectState = readState(root, input.session_id);
  const unchecked = projectState.unchecked ?? [];
  if (isStepCode(rel) && !unchecked.includes(rel)) {
    const list = [...unchecked, rel];
    const command = list.length > SMALL_STEP_FILES && !projectState.stepNoted && checkCommand(root);
    if (command) {
      notes.push(
        `You have changed ${list.join(", ")} and run no check since. Work in small steps: run the type check (or the tests for these files) before the next file, and fix what it finds. (The full check command is \`${command}\`; one part of it is enough here.)`,
      );
    }
    writeState(root, input.session_id, { ...projectState, unchecked: list, stepNoted: Boolean(projectState.stepNoted || command) });
  }
} else if (shell && RUNS.test(text) && (TEST_RUN.test(text) || /build/.test(text)) && !input.is_interrupt) {
  const root = projectRoot();
  const projectState = readState(root, input.session_id);
  if (projectState.unchecked?.length || projectState.stepNoted) {
    writeState(root, input.session_id, { ...projectState, unchecked: [], stepNoted: false });
  }
}

// The reviewer's answer was saved (review-saved.mjs, when the reviewer stopped): say so once, on the
// next tool result. A run believed the answer was cut off and never fixed its 5 findings (2026-10-29).
if (!inSubagent) {
  const root = projectRoot();
  const projectState = readState(root, input.session_id);
  if (projectState.reviewNote) {
    writeState(root, input.session_id, { ...projectState, reviewNote: false });
    notes.push(
      `The reviewer's answer is saved in \`${REVIEW_FILE}\`: if you cannot see all of it, read it there. Fix each finding it lists, or say in your report why one is not a real problem, then run the checks again. A second review of the same files is not needed.`,
    );
  }
}

// Long thinking in the step that made this call: once per message.
if (!inSubagent) {
  const latest = latestThinking(input.transcript_path);
  if (latest && latest.id !== state.thinkNotedId && latest.thinking.length >= THINK_CHARS) {
    state.thinkNotedId = latest.id;
    const codeLines = latest.thinking.split("\n").filter((line) => CODE_LINE.test(line)).length;
    const tokens = Math.round(latest.thinking.length / 4 / 100) * 100;
    notes.push(
      codeLines >= CODE_LINES
        ? `Your last step had about ${tokens} tokens of thinking, ${codeLines} lines of it code. Thinking is the slowest part of your work, and drafted code gets written twice. Write code straight into the edit or write_file call; the checks tell you if it is wrong.`
        : `Your last step had about ${tokens} tokens of thinking. Thinking is the slowest part of your work. Settle small choices (a type, a name, an extra guard) by copying what nearby code does, then act; the checks tell you if it was wrong.`,
    );
  }
}

mkdirSync(stateDir, { recursive: true });
writeFileSync(stateFile, JSON.stringify(state));
if (notes.length > 0) {
  output({ hookSpecificOutput: { hookEventName: event, additionalContext: notes.join("\n") } });
}
