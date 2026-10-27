// What the model should know about a project's dependencies: which versions came out after its
// training data, which are behind the latest release, and where the matching "what changed" docs
// are. Release dates come from deps.dev (one small request per package), cached for a day. Without
// network everything here quietly returns nothing.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { readJson, stateDir } from "./project.mjs";

// The model's training data ends around here. Qwen does not publish it for Qwen3.8-27B (released
// 2026-08-13); override with LOCAL_AGENT_MODEL_CUTOFF (YYYY-MM) once you know better.
const MODEL_CUTOFF = /^\d{4}-\d{2}$/.test(process.env.LOCAL_AGENT_MODEL_CUTOFF ?? "")
  ? process.env.LOCAL_AGENT_MODEL_CUTOFF
  : "2026-03";
const API = process.env.LOCAL_AGENT_DEPS_API ?? "https://api.deps.dev/v3/systems/npm/packages";
const CACHE_FILE = join(stateDir, "deps-facts.json");
const CACHE_HOURS = 24;
const CHANGE_DOC = /(upgrad|migrat|changelog|breaking|release-notes)/i;

const majorOf = (version) => Number(/(\d+)/.exec(String(version))?.[1] ?? NaN);
const plainVersion = (range) => /(\d+\.\d+\.\d+)/.exec(String(range))?.[1] ?? null;

// Every dependency a package.json declares, with the installed version when there is one.
export function dependencies(dir) {
  const pkg = readJson(join(dir, "package.json"));
  if (!pkg) return {};
  const declared = { ...pkg.devDependencies, ...pkg.dependencies };
  const out = {};
  for (const [name, range] of Object.entries(declared)) {
    if (name.startsWith("@types/") || /^(file|link|workspace|git|http)/.test(String(range))) continue;
    const installed = readJson(join(dir, "node_modules", name, "package.json"))?.version;
    const version = installed ?? plainVersion(range);
    if (version) out[name] = version;
  }
  return out;
}

function readCache() {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

// { latest, majors: { "16": "2025-10-21T..." } } for one package, or null.
async function fetchFacts(name, timeoutMs) {
  try {
    const response = await fetch(`${API}/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const data = await response.json();
    const majors = {};
    let latest = null;
    for (const v of data.versions ?? []) {
      const version = v.versionKey?.version ?? "";
      if (v.isDefault) latest = version;
      if (version.includes("-") || !v.publishedAt) continue; // pre-releases do not count
      const major = String(majorOf(version));
      if (!majors[major] || v.publishedAt < majors[major]) majors[major] = v.publishedAt;
    }
    return latest ? { latest, majors } : null;
  } catch {
    return null;
  }
}

// Facts for many packages at once, within a time budget; cached ones cost nothing.
export async function packageFacts(names, { timeoutMs = 5000 } = {}) {
  if (process.env.LOCAL_AGENT_OFFLINE === "1") return {};
  const cache = readCache();
  const now = Date.now();
  const fresh = (entry) => entry && now - entry.fetchedAt < CACHE_HOURS * 3600 * 1000;
  const missing = names.filter((name) => !fresh(cache[name]));
  const results = await Promise.all(missing.map((name) => fetchFacts(name, timeoutMs)));
  missing.forEach((name, i) => {
    if (results[i]) cache[name] = { ...results[i], fetchedAt: now };
  });
  if (missing.length > 0) {
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(CACHE_FILE, JSON.stringify(cache));
    } catch {
      // a cache we cannot write only costs a refetch
    }
  }
  return Object.fromEntries(names.filter((name) => cache[name]).map((name) => [name, cache[name]]));
}

// Files inside the installed package that describe changes, best match first: an upgrade guide
// for this major version, then other upgrade/migration notes, then the changelog.
function changeDocs(dir, name, major, limit = 2) {
  const base = join(dir, "node_modules", name);
  if (!existsSync(base)) return [];
  const found = [];
  const walk = (current, depth) => {
    if (depth > 7 || found.length > 200) return;
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (/\.(md|mdx|txt)$/i.test(entry.name)) {
        const rel = relative(base, path).replaceAll("\\", "/");
        if (CHANGE_DOC.test(rel)) found.push(rel);
      }
    }
  };
  walk(base, 0);
  const score = (rel) =>
    (new RegExp(`(version|v)[-_]?${major}\\b`, "i").test(rel) ? 0 : 10) +
    (/upgrad|migrat/i.test(rel) ? 0 : 5) +
    rel.split("/").length / 100;
  return found
    .sort((a, b) => score(a) - score(b))
    .slice(0, limit)
    .map((rel) => `node_modules/${name}/${rel}`);
}

function releaseNotes(dir, name) {
  const repo = readJson(join(dir, "node_modules", name, "package.json"))?.repository;
  const url = typeof repo === "string" ? repo : repo?.url;
  // npm accepts a full URL, "github:owner/repo" and plain "owner/repo".
  const m =
    /github\.com[/:]([\w.-]+\/[\w.-]+?)(\.git)?(#.*)?$/.exec(url ?? "") ??
    /^(?:github:)?([\w.-]+\/[\w.-]+?)(\.git)?$/.exec(url ?? "");
  return m ? `https://github.com/${m[1]}/releases` : null;
}

// One line per dependency worth mentioning, or none. `changed` marks packages the model just added
// or changed, which also get a warning when they are behind the latest release.
export function describe(dir, versions, facts, { changed = new Set() } = {}) {
  const lines = [];
  const search = process.env.SEARXNG_URL ? " or search the web for its migration guide" : "";
  for (const [name, version] of Object.entries(versions)) {
    const info = facts[name];
    if (!info) continue;
    const major = majorOf(version);
    const latestMajor = majorOf(info.latest);
    const since = info.majors[String(major)]?.slice(0, 10);
    const newer = since && since.slice(0, 7) > MODEL_CUTOFF;
    const docs = changeDocs(dir, name, major);
    const where = docs.length ? `read ${docs.join(" and ")}` : (() => {
      const notes = releaseNotes(dir, name);
      return notes ? `read its release notes (${notes})${search}` : `read its README and .d.ts types${search}`;
    })();
    if (changed.has(name) && latestMajor > major) {
      lines.push(
        `${name} ${version} was just installed, but ${info.latest} is the latest. Unless this project needs ${major}.x, install the latest instead.`,
      );
    } else if (newer) {
      lines.push(
        `${name} ${version} (${major}.x since ${since}, newer than your training data): code already in the project shows working usage; before using an API it doesn't use yet, ${where}.`,
      );
    } else if (latestMajor > major) {
      lines.push(`${name} ${version} (latest is ${info.latest}): write code for the installed ${major}.x, not for the latest.`);
    }
  }
  return lines;
}

// package.json files the agent may have just created or changed: the project's and its direct
// subfolders' (a scaffolder like create-next-app often makes a new folder).
export function packageDirs(root) {
  const dirs = existsSync(join(root, "package.json")) ? [root] : [];
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const dir = join(root, entry.name);
      if (existsSync(join(dir, "package.json")) && statSync(join(dir, "package.json")).isFile()) dirs.push(dir);
    }
  } catch {
    // unreadable folder: only the root counts
  }
  return dirs;
}
