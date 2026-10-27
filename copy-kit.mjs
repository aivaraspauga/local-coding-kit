// Copies the kit into the project in the current folder (step 2 of SETUP-FOR-AI.md): a new setup,
// or an update when the project already has .qwen/kit. It never overwrites a file of the project.
// It records in .qwen/kit/installed.json what it added (with a hash, to see later changes) and the
// kit's own QWEN.md and .qwen/settings.json, so the kit can be removed again without touching the
// project's files (.qwen/kit/REMOVE.md).
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = join(dirname(fileURLToPath(import.meta.url)), "kit");
const RECORD = ".qwen/kit/installed.json";
// The kit's files that the project may have its own of: the setup merges the kit's into them.
const SHARED = ["QWEN.md", ".qwen/settings.json"];
// The kit's own folders, which an update replaces.
const KIT_FOLDERS = /^\.qwen\/(kit|skills|agents)\//;

const hash = (file) => createHash("sha1").update(readFileSync(file)).digest("hex");
const version = (root) => {
  const file = join(root, ".qwen/kit/VERSION");
  return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
};
const files = (dir, rel = "") =>
  readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const path = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? files(dir, path) : [path];
  });

const update = existsSync(".qwen/kit");
const hadRecord = existsSync(RECORD);
const record = hadRecord ? JSON.parse(readFileSync(RECORD, "utf8")) : { added: {} };
const before = update ? version(".") : null;
const kept = [];
for (const rel of files(source)) {
  const from = join(source, rel);
  if (!existsSync(rel)) {
    mkdirSync(dirname(rel), { recursive: true });
    copyFileSync(from, rel);
    record.added[rel] = hash(rel);
    continue;
  }
  // On an update a kit file is replaced unless the user changed it since the setup. A kit set up
  // before the record existed has no hashes: then all of its folders count as the kit's.
  const replace =
    update &&
    KIT_FOLDERS.test(rel) &&
    (rel.startsWith(".qwen/kit/") || !hadRecord || record.added[rel] === hash(rel));
  if (replace) {
    copyFileSync(from, rel);
    record.added[rel] = hash(rel);
  } else if (hash(rel) !== hash(from)) {
    kept.push(rel);
  }
}
record.kit = Object.fromEntries(SHARED.map((rel) => [rel, readFileSync(join(source, rel), "utf8")]));
writeFileSync(RECORD, `${JSON.stringify(record, null, 1)}\n`);

const now = version(source);
console.log(update ? `Updated the kit from version ${before ?? "older (no number)"} to ${now}.` : `Copied the kit (version ${now}).`);
if (kept.length) console.log(`Kept as they were: ${kept.join(", ")}`);
