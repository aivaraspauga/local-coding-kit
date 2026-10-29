// SubagentStop hook (reviewer only): saves the reviewer's answer to .local-agent/review.md with the
// files it reviewed. A run believed the answer was cut off, never fixed its 5 findings and started a
// second review that used up its time (2026-10-29). focus.mjs tells the model on its next tool
// result; guard.mjs points a second review of unchanged files to the saved one. Never blocks.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { fingerprint, projectRoot, readInput, readState, REVIEW_FILE, writeState } from "./lib/project.mjs";

const input = readInput();
const review = String(input.last_assistant_message ?? "").trim();
if (review && String(input.agent_type ?? "").toLowerCase() === "reviewer") {
  const root = projectRoot();
  mkdirSync(join(root, ".local-agent"), { recursive: true });
  writeFileSync(join(root, REVIEW_FILE), `${review}\n`);
  writeState(root, input.session_id, { ...readState(root, input.session_id), reviewed: fingerprint(root), reviewNote: true });
}
process.exit(0);
