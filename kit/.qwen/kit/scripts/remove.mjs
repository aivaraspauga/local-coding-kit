// Removes the kit from the project when the user asks (step 2 of .qwen/kit/REMOVE.md): deletes the
// files the setup added that nobody changed since, the kit's folder and the folders left empty.
// Names the files it left because they changed.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const recordFile = join(root, ".qwen/kit/installed.json");
if (!existsSync(recordFile)) {
  console.log("There is no .qwen/kit/installed.json: the kit was set up before it kept a record of what it added. Update the kit first, then run this again.");
  process.exit(1);
}
const { added = {} } = JSON.parse(readFileSync(recordFile, "utf8"));
const hash = (file) => createHash("sha1").update(readFileSync(file)).digest("hex");

let removed = 0;
const changed = [];
for (const [rel, sum] of Object.entries(added)) {
  const file = join(root, rel);
  if (rel.startsWith(".qwen/kit/") || !existsSync(file)) continue;
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

console.log(`Removed .qwen/kit and ${removed} other files of the kit.`);
if (changed.length) console.log(`Changed since the setup, so left as they are: ${changed.join(", ")}`);
