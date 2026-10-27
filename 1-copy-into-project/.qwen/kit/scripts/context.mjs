// PostToolUse hook: tells the model how full its context is, because it cannot see that itself.
// Reads the token usage of the latest model call from the session transcript and compares it with
// the budget: the smaller of the server's context window and LOCAL_AGENT_CONTEXT (where Qwen Code
// compresses the chat). Notes are given once per threshold, and re-armed after a compaction frees
// space.
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { output, readInput, stateDir } from "./lib/project.mjs";

// One note, near the compaction point. A 60% note ("save progress to plan.md") came 5 minutes into a
// normal 27B run (2026-10-24); the model took it as a sign of an earlier session, wrote a plan with
// steps it had not done, and acted on a user request it imagined.
const THRESHOLDS = [
  [
    0.8,
    "Your context is about {pct}% full ({used} of {budget} tokens). It is compacted automatically soon, and then you keep only a summary. Before that, write in .local-agent/plan.md the steps you finished in this session (only ones you ran and saw pass) and the next step, then go on. Do not stop to ask the user.",
  ],
];
const REARM_BELOW = 0.4;
const TAIL_BYTES = 512 * 1024;

const input = readInput();
// Inside a subagent the main conversation's size is not this agent's business.
if (input.agent_id || !input.transcript_path) process.exit(0);
// The kit's .qwen/settings.json names the server and model.
const serverUrl = process.env.LOCAL_AGENT_URL;
const serverModel = process.env.LOCAL_AGENT_MODEL;

// Tokens the latest model call used: its whole prompt plus its answer.
function lastUsage(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n").reverse();
    for (const line of lines) {
      if (!line.includes('"usageMetadata"')) continue;
      try {
        // Gemini-style usageMetadata on each assistant record. Helper agents write their own files.
        const meta = JSON.parse(line).usageMetadata;
        if (meta) return meta.totalTokenCount ?? (meta.promptTokenCount ?? 0) + (meta.candidatesTokenCount ?? 0);
      } catch {
        // a partial line at the start of the tail
      }
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return null;
}

const stateFile = join(stateDir, `context-${String(input.session_id ?? "default").replace(/[^\w-]/g, "")}.json`);
let state = {};
try {
  state = JSON.parse(readFileSync(stateFile, "utf8"));
} catch {
  // first call in this session
}

// The server's window, asked once per session (llama-server reports it in /v1/models as meta.n_ctx).
async function serverContext() {
  if (state.serverContext !== undefined) return state.serverContext;
  let context = null;
  const base = serverUrl;
  if (base) {
    try {
      const response = await fetch(`${base.replace(/\/$/, "")}/v1/models`, { signal: AbortSignal.timeout(1500) });
      const models = await response.json();
      // In router mode the list can hold several models; prefer the one the agent asks for.
      const model = models.data?.find((m) => m.id === serverModel) ?? models.data?.[0] ?? {};
      context = model.meta?.n_ctx ?? model.context_length ?? model.max_context_length ?? null;
    } catch {
      context = null;
    }
  }
  state.serverContext = context;
  return context;
}

const used = lastUsage(input.transcript_path);
if (used === null) process.exit(0);
const compactAt = Number(process.env.LOCAL_AGENT_CONTEXT ?? 100000);
const server = await serverContext();
const budget = Math.min(compactAt, server ?? Infinity);
const ratio = used / budget;

let note = null;
if (ratio < REARM_BELOW) state.warned = 0;
for (const [threshold, message] of THRESHOLDS) {
  if (ratio >= threshold && (state.warned ?? 0) < threshold) {
    state.warned = threshold;
    note = message
      .replace("{pct}", String(Math.round(ratio * 100)))
      .replace("{used}", used.toLocaleString("en-US"))
      .replace("{budget}", budget.toLocaleString("en-US"));
    break;
  }
}

mkdirSync(stateDir, { recursive: true });
writeFileSync(stateFile, JSON.stringify(state));
if (note) output({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: note } });
