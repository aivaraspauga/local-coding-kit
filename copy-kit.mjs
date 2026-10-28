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
// What the kit adds to .gitignore; remove.mjs takes out the same two lines.
const GITIGNORE_LINES = "# Qwen Code kit: the plan of the current task\n.local-agent/\n";

// The framework skills the project does not use. Left out here instead of deleted by the model
// afterwards: the kit's guard asked about each recursive delete, so an update stopped for an allow
// code (2026-10-28). A folder without package.json (a new project) gets all of them.
function unusedFrameworkSkills() {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync("package.json", "utf8"));
  } catch {
    return [];
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const uses = (...names) => names.some((name) => name in deps);
  const used = {
    "react-nextjs": uses("next", "react"),
    "shadcn-ui": existsSync("components.json"),
    vue: uses("vue", "nuxt"),
    angular: uses("@angular/core"),
  };
  used["vanilla-web"] = !used["react-nextjs"] && !used.vue && !used.angular;
  return Object.keys(used).filter((name) => !used[name]);
}

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
const unused = unusedFrameworkSkills();
const leftOut = new Set();
for (const rel of files(source)) {
  const from = join(source, rel);
  // A framework skill the project does not use is not added. One it has already (kept on purpose,
  // or from an older setup) is updated like any other.
  const skill = /^\.qwen\/skills\/([^/]+)\//.exec(rel)?.[1];
  if (unused.includes(skill) && !existsSync(join(".qwen/skills", skill))) {
    leftOut.add(skill);
    continue;
  }
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

// In a git repository the plan of the current task (.local-agent/) stays out of commits.
let ignored = false;
if (existsSync(".git")) {
  const text = existsSync(".gitignore") ? readFileSync(".gitignore", "utf8") : "";
  if (!/^\/?\.local-agent\/?\s*$/m.test(text)) {
    const gap = text === "" ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    writeFileSync(".gitignore", `${text}${gap}${GITIGNORE_LINES}`);
    ignored = true;
  }
}

const now = version(source);
console.log(update ? `Updated the kit from version ${before ?? "older (no number)"} to ${now}.` : `Copied the kit (version ${now}).`);
if (leftOut.size) console.log(`Left out the framework skills this project does not use: ${[...leftOut].join(", ")}`);
if (ignored) console.log("Added .local-agent/ (the plan of the current task) to .gitignore.");
if (kept.length) console.log(`Kept as they were: ${kept.join(", ")}`);
