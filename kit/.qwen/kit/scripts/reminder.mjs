// UserPromptSubmit hook: re-adds a short checklist to every user message, because smaller models
// lose track of long instructions as the conversation grows. Requests that look big or vague also
// get a nudge to plan first. It also notes for the other hooks what only the user's own words can
// say: blocks the user allows (guard.mjs), config files the message names (guard.mjs), and whether
// the message only asks a question (focus.mjs).
import { basename } from "node:path";

import { CHECK_CONFIGS, output, projectRoot, readInput, readState, writeState } from "./lib/project.mjs";

const input = readInput();
const prompt = String(input.prompt ?? "");
const root = projectRoot();
const state = readState(root, input.session_id);

// "allow 3f9a": a code the guard gave for a blocked command or file. Only a user message reaches
// this hook, so the model cannot allow its own blocks.
const pending = { ...state.pending };
const allowed = new Set(state.allowed ?? []);
const newlyAllowed = [];
for (const [, code] of prompt.matchAll(/\ballow\s+([0-9a-f]{4})\b/gi)) {
  const key = pending[code.toLowerCase()];
  if (!key) continue;
  delete pending[code.toLowerCase()];
  allowed.add(key);
  newlyAllowed.push(key);
}
// Config files named in the message ("Create vitest.config.ts: ..."): changing them is the task.
const named = new Set(state.named ?? []);
for (const word of prompt.split(/[\s`"'(),:;<>[\]]+/)) {
  const name = basename(word.replaceAll("\\", "/")).toLowerCase();
  if (CHECK_CONFIGS.test(name)) named.add(name);
}
// A question or a review is all reading: the look-up nudge would push it to edit something.
const CHANGE =
  /\b(add|fix|build|create|make|implement|change|update|remove|delete|rename|refactor|write|move|install|set up|migrate|convert|replace|edit)\b/i;
const QUESTION = /\?\s*$|^\s*(how|what|why|where|which|who|when|is|are|does|do|did|can|could|should|would|explain|review)\b/i;
const question = QUESTION.test(prompt) && !CHANGE.test(prompt);
writeState(root, input.session_id, { ...state, pending, allowed: [...allowed], named: [...named], question });

// Signs of a request that needs a plan: building a whole new app or system, or several asks or a
// long description that doesn't yet say what exactly to build. One page or component ("add a
// contact page") is a small task: a plan file there costs more turns than it saves.
const BUILD = /\b(build|create|make|set up|scaffold|implement)\b.{0,40}\b(app|site|system|dashboard|game|backend|platform)\b/i;
// Commas and "and"s that are not separate asks: code (signatures, file names), quoted examples,
// asides, "find and fix", the test that goes with any change, and a list of single words ("name,
// email and message"). Counting them sent a one-function spec and a one-line bug fix to plan-work.
const text = prompt
  .replace(/`[^`]*`/g, "code")
  .replace(/"[^"]*"/g, "text")
  .replace(/\([^)]*\)/g, "")
  .replace(/\bfind and fix\b/gi, "fix")
  .replace(/,? ?\band add (?:\w+ ){0,2}tests?\b[^.;]*/gi, "")
  .replace(/\b\w+(?:, \w+)+,? (?:and|or) \w+\b/gi, "items");
const asks = (text.match(/\b(and|also|plus|then)\b|[,;]\s|\n\s*[-*\d]/gi) ?? []).length;
// A request that names its files, code and texts is already a spec; a plan would only repeat it.
const spelledOut = (prompt.match(/`[^`]+`|"[^"]+"|\bsrc\/\S+/g) ?? []).length >= 2;
// A request with its own numbered steps ("STEP 1 - Create the app", "1. Run ...") is already the plan:
// plan-work would write it again, and "big request" raised the effort for every step (2026-10-24).
const ownSteps = (prompt.match(/^\s*(step\s+\d+\b|\d+[.)]\s)/gim) ?? []).length >= 3;
const needsPlan = !ownSteps && (BUILD.test(prompt) || ((asks >= 4 || prompt.length > 800) && !spelledOut));

// How hard to think. The server runs the model at a medium effort (launcher: LLAMA_REASONING_EFFORT);
// switching the template's effort per request would change the start of the prompt and make the
// server re-read all of it, so the nudge goes here, at the end. Hard: a bug or failure to find the
// cause of, a design question, or a big request. "Show an error next to the field" or "if the email
// looks wrong" describe a feature, so loose words like "error" and "wrong" don't count.
const DEBUG =
  /\b(bugs?|broken|crash(es|ed|ing)?|fails?|failing|failed|exceptions?|stack trace|regression|flaky|leak(s|ing)?|hangs?|freezes?|500|(does not|doesn't|did not|didn't|no longer|stopped) work(s|ing)?|not working|(is|are|went|goes) wrong|why)\b|\b(returns?|gives?|outputs?|prints?)\b[^.]{0,60}\binstead of\b/i;
const DESIGN = /\b(architect\w*|refactor\w*|secur\w*|vulnerab\w*|performance|slow|race conditions?|deadlock|migrat\w*|concurren\w*)\b/i;
// An "if/when ..." clause or an example in brackets states a rule for the feature ("If something is
// wrong, show the error", "when the password is wrong (for example ...)", "if better-sqlite3 fails to
// install, use node:sqlite"), not a bug: both friend prompts got "high" from one (2026-10-24).
const reported = prompt.replace(/\([^)]*\)/g, "").replace(/\b(if|when|whenever)\b[^.,;\n]*/gi, "");
const hard = needsPlan || DEBUG.test(reported) || DESIGN.test(prompt);

const lines = [
  "Checklist for this request:",
  "1. Restate the goal. Read the files involved first; follow a matching skill or the project's AGENTS.md.",
  "2. Smallest change, one step at a time. Look up libraries in docs and types, not compiled node_modules code.",
  "3. Verify by running the checks (and the app, for UI). Report what you changed and how you verified it.",
];
lines.push(
  hard
    ? "Effort: high. This is a bug, a failure, a design question or a big request: before you change code, think the cause or the design through carefully and check it against the code or a quick run. Once you have it, act on it; don't re-derive it."
    : "Effort: normal. The request is clear: keep each thought short and aimed at the next action.",
);
if (needsPlan) {
  lines.push(
    "This request looks big or open-ended: use the `plan-work` skill first (goal, done checks, smallest complete version, 3-8 steps), then work through the steps.",
  );
}
for (const key of newlyAllowed) {
  lines.push(`The user allowed this for the rest of the conversation: ${key.startsWith("file ") ? `changes to \`${key.slice(5)}\`` : `\`${key}\``}. Run it again unchanged.`);
}

output({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: lines.join("\n") } });
