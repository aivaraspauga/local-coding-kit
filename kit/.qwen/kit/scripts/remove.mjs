// Removes the kit from the project when the user asks (.qwen/kit/REMOVE.md): takes the kit's parts
// out of QWEN.md and .qwen/settings.json, deletes the files the setup added that nobody changed
// since, the kit's folder, the folders left empty, the plan folder and the kit's lines in .gitignore
// and .prettierignore. Names the files it left because they changed.
// The model did the shared files and the ignore lines by hand before, and the kit's guard asked
// about each guarded edit, so a removal needed allow codes; it also left .prettierignore (2026-10-28).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const recordFile = join(root, ".qwen/kit/installed.json");
if (!existsSync(recordFile)) {
  console.log("There is no .qwen/kit/installed.json: the kit was set up before it kept a record of what it added. Update the kit first, then run this again.");
  process.exit(1);
}
const { added = {}, kit = {} } = JSON.parse(readFileSync(recordFile, "utf8"));
const hash = (file) => createHash("sha1").update(readFileSync(file)).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const SHARED = ["QWEN.md", ".qwen/settings.json"];
const done = [];

// What is left of a settings value without the kit's parts: values equal to the kit's, the kit's
// entries of a list (hooks, permissions.allow, tools, skills) and every env key the kit sets.
// Returns undefined when nothing is left.
function withoutKit(mine, kits, key) {
  if (same(mine, kits)) return undefined;
  if (Array.isArray(mine) && Array.isArray(kits)) {
    const left = mine.filter((item) => !kits.some((k) => same(k, item)));
    return left.length ? left : undefined;
  }
  if (!isObject(mine) || !isObject(kits)) return mine;
  const out = {};
  for (const [name, value] of Object.entries(mine)) {
    if (!(name in kits)) out[name] = value;
    else if (key !== "env") {
      const left = withoutKit(value, kits[name], name);
      if (left !== undefined) out[name] = left;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function removeSettings(file, kitText) {
  const left = withoutKit(JSON.parse(readFileSync(file, "utf8")), JSON.parse(kitText));
  // Qwen Code's own `$version` marker alone is nothing of the user's.
  if (!left || Object.keys(left).every((name) => name.startsWith("$"))) {
    rmSync(file);
    done.push("deleted .qwen/settings.json (only the kit's settings were in it)");
  } else {
    writeFileSync(file, `${JSON.stringify(left, null, 2)}\n`);
    done.push("took the kit's settings out of .qwen/settings.json and kept yours");
  }
}

function removeLines(file, kitText) {
  const text = readFileSync(file, "utf8");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const kitLines = new Set(kitText.split(/\r?\n/).filter((line) => line.trim()));
  const left = text
    .split(/\r?\n/)
    .filter((line) => !kitLines.has(line))
    .join(eol)
    .replace(/(\r?\n){3,}/g, `${eol}${eol}`)
    .trim();
  if (!left) {
    rmSync(file);
    done.push(`deleted ${file.slice(root.length + 1)} (only the kit's lines were in it)`);
  } else {
    writeFileSync(file, `${left}${eol}`);
    done.push(`took the kit's lines out of ${file.slice(root.length + 1)} and kept yours`);
  }
}

// An ignore line the kit added (`line`) with the comment line above it (`comment`); the file goes
// when nothing else is in it. With `onlyWithComment`, a line without the kit's comment is the user's.
function removeIgnoreLine(name, line, comment, onlyWithComment = false) {
  const file = join(root, name);
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l, i) => line.test(l) && (!onlyWithComment || (i > 0 && comment.test(lines[i - 1]))));
  if (at < 0) return;
  const from = at > 0 && comment.test(lines[at - 1]) ? at - 1 : at;
  lines.splice(from, at - from + 1);
  const left = lines.join(eol).replace(/(\r?\n){3,}/g, `${eol}${eol}`).trim();
  if (!left) rmSync(file);
  else writeFileSync(file, `${left}${eol}`);
  done.push(left ? `took the kit's line out of ${name}` : `deleted ${name} (only the kit's line was in it)`);
}

for (const rel of SHARED) {
  const file = join(root, rel);
  if (!existsSync(file) || !(rel in kit)) continue;
  if (rel.endsWith(".json")) removeSettings(file, kit[rel]);
  else removeLines(file, kit[rel]);
}

let removed = 0;
const changed = [];
for (const [rel, sum] of Object.entries(added)) {
  const file = join(root, rel);
  if (rel.startsWith(".qwen/kit/") || SHARED.includes(rel) || !existsSync(file)) continue;
  if (hash(file) === sum) {
    rmSync(file);
    removed++;
  } else {
    changed.push(rel);
  }
}
rmSync(join(root, ".qwen/kit"), { recursive: true, force: true });
// The folders the setup's files were in, deepest first; a folder with anything left in it stays.
const folders = new Set();
for (const rel of Object.keys(added)) for (let d = dirname(rel); d !== "."; d = dirname(d)) folders.add(d);
for (const folder of [...folders].sort((a, b) => b.length - a.length)) {
  try {
    rmdirSync(join(root, folder));
  } catch {
    // not empty, or already gone
  }
}

// The plan of the current task, and the ignore lines for it and for the kit's folder. A comment
// above the line is taken too when it names the kit or the plan (older setups wrote their own).
if (existsSync(join(root, ".local-agent"))) {
  rmSync(join(root, ".local-agent"), { recursive: true, force: true });
  done.push("deleted .local-agent/ (the plan of the current task)");
}
removeIgnoreLine(".gitignore", /^\/?\.local-agent\/?\s*$/, /^#.*\b(kit|plan|local-agent)\b/i);
removeIgnoreLine(".prettierignore", /^\/?\.qwen\/?\s*$/, /^# Qwen Code kit\b/, true);

console.log(`Removed .qwen/kit and ${removed} other files of the kit.`);
for (const line of done) console.log(`Also ${line}.`);
if (changed.length) console.log(`Changed since the setup, so left as they are: ${changed.join(", ")}`);
