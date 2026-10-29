// Sends bad requests to the Next.js API routes a session changed, on the project's own build
// (`next start`), and reports each one the route answers with a 5xx, a hang, or a different answer
// the second time. Smaller models check the happy path and forget the rest: in the 2026-10-28 kit
// vs no-kit runs both arms returned 500 for a body that was not JSON, and the reviewer missed it.
// Only requests a correct route refuses are sent (broken or missing bodies, unknown ids, odd query
// values), and only to handlers that read a body for those with one, so a working route changes no
// data. DELETE goes only to routes with an id in the path, with an id that does not exist.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

const ROUTE_FILE = /(^|\/)app\/(.+\/)?route\.[cm]?[jt]s$/;
const METHOD = /export\s+(?:async\s+)?(?:function\s+|const\s+|let\s+)(GET|POST|PUT|PATCH|DELETE)\b|\bas\s+(GET|POST|PUT|PATCH|DELETE)\b/g;
const READS_BODY = /\.(json|formData|text|arrayBuffer|blob)\(\s*\)/;
const MISSING_ID = "999999999";
const BAD_ID = "not-an-id";
const ODD_QUERY = "?q=%27%22%25_%5C&page=abc&limit=-1&sort=%00";
const BAD_BODIES = [
  ["a body that is not JSON", '{"broken": '],
  ["an empty body", ""],
  ["the body `null`", "null"],
  ["the body `[]`", "[]"],
];
const MAX_REQUESTS = 40;
const REQUEST_TIMEOUT = 8000;
const START_TIMEOUT = 30000;

// "src/app/api/tasks/[id]/route.ts" -> ["api", "tasks", "[id]"], or null when it is not a URL
// (a private `_folder`).
function segments(path) {
  const match = /(?:^|\/)app\/(.*?)\/?route\.[cm]?[jt]s$/.exec(path);
  if (!match) return null;
  const parts = match[1].split("/").filter(Boolean);
  if (parts.some((part) => part.startsWith("_"))) return null;
  // Route groups `(name)` and parallel-route slots `@name` are not part of the URL.
  return parts.filter((part) => !/^\(.*\)$/.test(part) && !part.startsWith("@") && !/^\[\[\.\.\..+\]\]$/.test(part));
}

function urlFor(parts, id) {
  return `/${parts.map((part) => (/^\[\.\.\..+\]$/.test(part) ? "probe" : /^\[.+\]$/.test(part) ? id : part)).join("/")}`;
}

// The requests for one route file: [label, method, url, body].
function requestsFor(path, text) {
  const parts = segments(path);
  if (!parts) return [];
  const methods = new Set([...text.matchAll(METHOD)].map((match) => match[1] ?? match[2]));
  const dynamic = parts.some((part) => /^\[.+\]$/.test(part));
  const ids = dynamic ? [MISSING_ID, BAD_ID] : [null];
  const requests = [];
  if (methods.has("GET")) {
    if (dynamic) for (const id of ids) requests.push([`an id that does not exist (${id})`, "GET", urlFor(parts, id)]);
    else requests.push(["odd query values", "GET", `${urlFor(parts)}${ODD_QUERY}`]);
  }
  for (const method of ["POST", "PUT", "PATCH"]) {
    if (!methods.has(method) || !READS_BODY.test(text)) continue;
    for (const [label, body] of BAD_BODIES) requests.push([label, method, urlFor(parts, MISSING_ID), body]);
  }
  if (methods.has("DELETE") && dynamic) {
    for (const id of ids) requests.push([`an id that does not exist (${id})`, "DELETE", urlFor(parts, id)]);
  }
  return requests;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function send(base, method, url, body) {
  try {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    return { status: response.status, body: await response.text() };
  } catch (error) {
    return { status: 0, body: "", error: error?.name === "TimeoutError" ? "no answer within 8 s" : "the connection failed" };
  }
}

function stop(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGKILL");
}

// The route files among `changed` that the build in `.next` is newer than. Null when there is
// nothing to probe: no Next.js, no build, no changed route, or a build older than the routes
// (then the checks did not build these files and the answers would be about old code).
export function routesToProbe(root, changed) {
  const routes = changed.filter((path) => ROUTE_FILE.test(path) && existsSync(join(root, path)));
  if (routes.length === 0) return null;
  const nextBin = join(root, "node_modules", "next", "dist", "bin", "next");
  const buildId = join(root, ".next", "BUILD_ID");
  if (!existsSync(nextBin) || !existsSync(buildId)) return null;
  const built = statSync(buildId).mtimeMs;
  if (routes.some((path) => statSync(join(root, path)).mtimeMs > built)) return null;
  return routes;
}

// Starts the build, sends the requests, stops it. Returns { sent, problems, log } or null when the
// app could not be started (the probe then says nothing: it must never block on its own failure).
export async function probeRoutes(root, routes) {
  const requests = routes
    .flatMap((path) => requestsFor(path, readFileSync(join(root, path), "utf8")))
    .slice(0, MAX_REQUESTS);
  if (requests.length === 0) return null;

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    [join(root, "node_modules", "next", "dist", "bin", "next"), "start", "--port", String(port), "--hostname", "127.0.0.1"],
    { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk));
  child.stderr.on("data", (chunk) => (log += chunk));
  try {
    const deadline = Date.now() + START_TIMEOUT;
    let up = false;
    while (!up && Date.now() < deadline && child.exitCode === null) {
      up = (await send(base, "GET", "/")).status > 0;
      if (!up) await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (!up) return null;
    const startLog = log.length;

    const problems = [];
    for (const [label, method, url, body] of requests) {
      const first = await send(base, method, url, body);
      const second = first.status === 0 ? first : await send(base, method, url, body);
      const what = `${method} ${url}, ${label}`;
      if (first.status === 0) problems.push(`${what}: ${first.error}`);
      else if (first.status >= 500) problems.push(`${what}: ${first.status} (${first.body.slice(0, 120).trim() || "empty body"})`);
      else if (second.status !== first.status) problems.push(`${what}: ${first.status} the first time, ${second.status} the second`);
      else if (first.body !== "" && second.body === "") {
        problems.push(`${what}: the same request twice, and the second answer had an empty body (one Response object reused across requests?)`);
      }
    }
    // Stack lines inside the build's minified chunks name no file the model can open.
    const errors = stripVTControlCharacters(log.slice(startLog))
      .split("\n")
      .filter((line) => line.trim() && !/^\s+at .*[\\/]\.next[\\/]/.test(line))
      .slice(-30)
      .join("\n");
    return { sent: requests.length, problems, log: errors };
  } finally {
    stop(child);
  }
}
