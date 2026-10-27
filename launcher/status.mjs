// Shows which parts of the local setup are running, and what to do about the ones that are not.
//
//   node launcher/status.mjs           (status.cmd runs it with the settings from config.cmd)
//   node launcher/status.mjs --speed   (start-all: also times one short answer of the loaded model)
//
// Settings (environment, as in config.cmd): LOCAL_AGENT_URL, LLAMA_MODEL_ID,
// LOCAL_AGENT_SEARXNG_URL, COMFYUI_URL, GATE_URL, OPEN_WEBUI_URL, LIBRARY_URL, LOCAL_AGENT_MIN_TPS. Exit code 1
// when the model server, which everything needs, is not answering.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const kit = dirname(dirname(fileURLToPath(import.meta.url)));
const env = (name, fallback) => process.env[name] || fallback;
const MODEL_URL = env("LOCAL_AGENT_URL", "http://127.0.0.1:8080").replace(/\/$/, "");
const MODEL_ID = env("LLAMA_MODEL_ID", "qwen3.8-27b");
const SEARXNG_URL = env("LOCAL_AGENT_SEARXNG_URL", "http://127.0.0.1:8888").replace(/\/$/, "");
const COMFYUI_URL = env("COMFYUI_URL", "http://127.0.0.1:8188").replace(/\/$/, "");
const GATE_URL = env("GATE_URL", "http://127.0.0.1:8189").replace(/\/$/, "");
const OPEN_WEBUI_URL = env("OPEN_WEBUI_URL", "http://127.0.0.1:3000").replace(/\/$/, "");
const LIBRARY_URL = env("LIBRARY_URL", "http://127.0.0.1:8190").replace(/\/$/, "");
const KIWIX_URL = env("KIWIX_URL", "http://127.0.0.1:8191").replace(/\/$/, "");
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
// The chat assistant's parts (images, library, Open WebUI) are listed as OFF only where the assistant
// folder exists; a coding-only copy of the kit lists them only when they answer.
const hasAssistant = existsSync(join(kit, "assistant"));
const off = (name, detail) => hasAssistant && add("OFF", name, detail);

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
  // With a second (chat) model, the one on the card may be the other one.
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
            ? "not loaded (images had the card; the next request loads it)"
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

// The gate's own /gate does not start ComfyUI; a gate without it (older) answers through ComfyUI.
const gateInfo = await get(`${GATE_URL}/gate`);
let startsComfyui = false;
try {
  startsComfyui = gateInfo?.status === 200 && JSON.parse(gateInfo.text).startsComfyui === true;
} catch {
  // not the gate's own answer
}
const comfy = await get(`${COMFYUI_URL}/system_stats`);
if (comfy?.status === 200) add("OK", "ComfyUI", "images ready");
else if (startsComfyui) add("OK", "ComfyUI", "closed while idle; the gate starts it for the next image (~25 s)");
else off("ComfyUI", "not running (only needed for images: assistant\\start-comfyui.cmd)");

const gate = startsComfyui ? gateInfo : await get(`${GATE_URL}/system_stats`);
if (!gate) off("Image gate", "not running (starts with assistant\\start-comfyui.cmd)");
else if (gate.status === 200) add("OK", "Image gate", "frees the graphics card before each image");
else add("WARN", "Image gate", "running, but ComfyUI behind it is not answering");

const library = await get(`${LIBRARY_URL}/health`);
if (library?.status === 200) add("OK", "Offline library", `${LIBRARY_URL} (books and pictures for the chat)`);
else off("Offline library", "not running (starts with start-all when the library folder exists)");
const kiwix = await get(`${KIWIX_URL}/`);
if (kiwix?.status === 200) add("OK", "Offline sites", `${KIWIX_URL} (Kiwix)`);
else off("Offline sites", "not running (assistant\\library\\start-kiwix.cmd)");

const webui = await get(`${OPEN_WEBUI_URL}/health`);
if (webui?.status === 200) add("OK", "Open WebUI", OPEN_WEBUI_URL);
else off("Open WebUI", "not running (assistant guide step 6; starts with Docker Desktop)");

// The Word and PDF tools have no port on this PC; ask Docker. A coding-only copy has none.
const compose = join(kit, "assistant", "docker-compose.yml");
const ps = hasAssistant ? spawnSync("docker", ["compose", "-f", compose, "ps", "--format", "json"], { encoding: "utf8", timeout: 15000 }) : null;
if (!ps) {
  // no assistant: nothing to report
} else if (ps.status !== 0) {
  add("OFF", "Word/PDF tools", "Docker is not running, or the assistant is not set up");
} else {
  const lines = ps.stdout.trim().split("\n").filter(Boolean);
  const services = lines.flatMap((line) => {
    try {
      const parsed = JSON.parse(line);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  });
  for (const name of ["word", "pdf"]) {
    const service = services.find((s) => s.Service === name);
    add(service?.State === "running" ? "OK" : "OFF", `${name === "word" ? "Word" : "PDF"} tools`, service ? service.State : "not created (assistant guide step 6)");
  }
}

const gpu = spawnSync("nvidia-smi", ["--query-gpu=memory.used,memory.total", "--format=csv,noheader"], { encoding: "utf8", timeout: 10000 });
if (gpu.status === 0) {
  const [used, total] = gpu.stdout.trim().split("\n")[0].split(",").map((s) => s.trim());
  add("INFO", "Graphics card", `${used} of ${total} in use`);
}

for (const { state, name, detail } of rows) console.log(`${state.padEnd(5)} ${name.padEnd(15)} ${detail}`);
process.exitCode = modelOk ? 0 : 1;
