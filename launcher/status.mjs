// Shows which parts of the local setup are running, and what to do about the ones that are not.
//
//   node launcher/status.mjs           (status.cmd runs it with the settings from config.cmd)
//   node launcher/status.mjs --speed   (start-all: also times one short answer of the loaded model)
//
// Settings (environment, as in config.cmd): LOCAL_AGENT_URL, LLAMA_MODEL_ID,
// LOCAL_AGENT_SEARXNG_URL, LOCAL_AGENT_MIN_TPS. Exit code 1
// when the model server, which everything needs, is not answering.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const kit = dirname(dirname(fileURLToPath(import.meta.url)));
const env = (name, fallback) => process.env[name] || fallback;
const MODEL_URL = env("LOCAL_AGENT_URL", "http://127.0.0.1:8080").replace(/\/$/, "");
const MODEL_ID = env("LLAMA_MODEL_ID", "qwen3.8-27b");
const SEARXNG_URL = env("LOCAL_AGENT_SEARXNG_URL", "http://127.0.0.1:8888").replace(/\/$/, "");
// Below this, part of the model is almost surely in normal RAM (healthy: ~45-70 tok/s; spilled: 0.5-25).
const MIN_TPS = Number(env("LOCAL_AGENT_MIN_TPS", "35"));

async function get(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
    const text = await response.text();
    return { status: response.status, text };
  } catch {
    return null;
  }
}

const rows = [];
const add = (state, name, detail) => rows.push({ state, name, detail });

// The model server: the one part everything needs.
const models = await get(`${MODEL_URL}/models`);
let modelOk = false;
if (!models) {
  add("DOWN", "Model server", `no answer on ${MODEL_URL}. Start it: launcher\\start-server.cmd`);
} else {
  let list = [];
  try {
    list = JSON.parse(models.text).data ?? [];
  } catch {
    list = [];
  }
  const entry = list.find((m) => m.id === MODEL_ID);
  // Another model of the router may be the one on the card.
  const other = list.find((m) => m.id !== MODEL_ID && m.status?.value && m.status.value !== "unloaded");
  const state = entry?.status?.value;
  if (!entry) {
    add("WARN", "Model server", `answers, but has no model "${MODEL_ID}". Restart it with launcher\\start-server.cmd (router mode).`);
  } else {
    modelOk = true;
    const note =
      state === "loaded"
        ? "loaded on the graphics card"
        : other
          ? `not loaded; ${other.id} is ${other.status.value === "loaded" ? "on the card" : other.status.value} (the next coding request swaps it back)`
          : state === "unloaded"
            ? "not loaded (the next request loads it)"
            : (state ?? "state unknown");
    add("OK", "Model server", `${MODEL_ID} ${note}`);
  }
}

// A model that partly sits in normal RAM (card memory too full) still answers, only ~10x slower, and
// nothing else warns about it. Time one short answer; wait for a model that is still loading.
async function modelState() {
  const r = await get(`${MODEL_URL}/models`);
  try {
    return JSON.parse(r.text).data.find((m) => m.id === MODEL_ID)?.status?.value;
  } catch {
    return undefined;
  }
}
if (process.argv.includes("--speed") && modelOk) {
  let state = await modelState();
  for (let i = 0; i < 60 && state === "loading"; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    state = await modelState();
  }
  if (state !== "loaded") {
    add("INFO", "Model speed", `not checked: the model is ${state ?? "in an unknown state"}`);
  } else {
    let tps;
    try {
      const response = await fetch(`${MODEL_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: MODEL_ID,
          messages: [{ role: "user", content: "Write a 200-word story about a lighthouse." }],
          max_tokens: 300,
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: AbortSignal.timeout(180000),
      });
      tps = (await response.json()).timings?.predicted_per_second;
    } catch {
      tps = undefined;
    }
    if (typeof tps !== "number") add("WARN", "Model speed", "no timing in the answer to a test request");
    else if (tps >= MIN_TPS) add("OK", "Model speed", `writes ${tps.toFixed(0)} tok/s`);
    else
      add(
        "WARN",
        "Model speed",
        `writes only ${tps.toFixed(1)} tok/s (usually 45-70): part of the model is probably in normal RAM. Close programs that use the graphics card (browser, Discord, games) or put the monitor on the motherboard's graphics, then restart the model server.`,
      );
  }
}

const searx = await get(`${SEARXNG_URL}/search?q=test&format=json`);
if (!searx) add("DOWN", "SearXNG", `no answer on ${SEARXNG_URL}. Start Docker Desktop (setup guide step 6).`);
else if (searx.status === 403) add("WARN", "SearXNG", "answers, but its JSON output is off (setup guide step 6).");
else add(searx.status === 200 ? "OK" : "WARN", "SearXNG", searx.status === 200 ? "web search answers" : `HTTP ${searx.status}`);

// Your own rows (other services on this PC), if you have any: launcher/status-extra.mjs, whose
// default export gets { add, get } and adds rows with add(state, name, detail).
const extra = join(kit, "launcher", "status-extra.mjs");
if (existsSync(extra)) await (await import(pathToFileURL(extra).href)).default({ add, get });

const gpu = spawnSync("nvidia-smi", ["--query-gpu=memory.used,memory.total", "--format=csv,noheader"], { encoding: "utf8", timeout: 10000 });
if (gpu.status === 0) {
  const [used, total] = gpu.stdout.trim().split("\n")[0].split(",").map((s) => s.trim());
  add("INFO", "Graphics card", `${used} of ${total} in use`);
}

for (const { state, name, detail } of rows) console.log(`${state.padEnd(5)} ${name.padEnd(15)} ${detail}`);
process.exitCode = modelOk ? 0 : 1;
