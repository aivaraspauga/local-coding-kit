// Shared helpers for the hook scripts: where the project is, how it checks itself, and hook I/O.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The folder that holds the kit in a project (.qwen).
export const KIT_DIR = basename(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))));

// Qwen Code's tool ids, as the short names the hook scripts use (Bash, Edit, Read, ...). The
// parameter names stay as Qwen Code sends them (file_path, command, old_string); the shell's
// is_background is also given as run_in_background.
const QWEN_TOOLS = {
  run_shell_command: "Bash",
  edit: "Edit",
  write_file: "Write",
  read_file: "Read",
  read_many_files: "Read",
  grep_search: "Grep",
  glob: "Glob",
  list_directory: "Glob",
  web_fetch: "WebFetch",
};

// Hooks get their input as JSON on stdin.
export function readInput() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
  if (!input || typeof input !== "object") return {};
  const tool = QWEN_TOOLS[input.tool_name];
  if (tool) {
    input.tool_name = tool;
    const params = input.tool_input;
    if (params && params.is_background !== undefined && params.run_in_background === undefined) {
      params.run_in_background = params.is_background;
    }
  }
  return input;
}

// The project root with its real letter case. Started from a path whose drive letter case
// differs (c:\ vs C:\, as VS Code passes it), Vitest loads itself twice and every test fails.
export function projectRoot() {
  const dir = process.env.QWEN_PROJECT_DIR ?? process.cwd();
  try {
    return realpathSync.native(dir);
  } catch {
    return dir;
  }
}

export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// The installed major version of a package (falling back to package.json's range), or 0.
export function majorVersion(root, name) {
  const pkg = readJson(join(root, "package.json")) ?? {};
  const version =
    readJson(join(root, "node_modules", name, "package.json"))?.version ??
    { ...pkg.dependencies, ...pkg.devDependencies }[name] ??
    "";
  return Number(/\d+/.exec(version)?.[0] ?? 0);
}

function packageManager(root) {
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))) return "bun";
  return "npm";
}

const PLACEHOLDER_TEST = /no test specified/;

// Configs that decide what "passing" means: changing one needs the user's OK (guard.mjs), unless
// the user's message names it (reminder.mjs).
export const CHECK_CONFIGS =
  /^(package\.json|tsconfig(\.[\w-]+)?\.json|eslint\.config\.[cm]?[jt]s|\.eslintrc(\.\w+)?|(vitest|vite|jest|playwright)\.config\.[cm]?[jt]s|\.prettierrc(\.\w+)?|prettier\.config\.[cm]?[jt]s|\.prettierignore|biome\.jsonc?)$/;

// The command that decides whether work is done, or null when the project has nothing to run.
// Order: LOCAL_AGENT_CHECK > a `check` script > the project's typecheck, lint and test scripts
// (with `tsc --noEmit` when there is a tsconfig but no typecheck script; Angular builds instead,
// because its root tsconfig lists no files and only the build checks templates), then a Next.js
// build last.
export function checkCommand(root) {
  if (process.env.LOCAL_AGENT_CHECK) return process.env.LOCAL_AGENT_CHECK;
  const pkg = readJson(join(root, "package.json"));
  if (!pkg) return null;
  const pm = packageManager(root);
  const run = (script) => `${pm} run ${script}`;
  const scripts = pkg.scripts ?? {};
  if (scripts.check) return run("check");

  const steps = [];
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const typecheck = ["typecheck", "type-check", "types", "tsc"].find((name) => scripts[name]);
  if (typecheck) steps.push(run(typecheck));
  else if (existsSync(join(root, "angular.json"))) steps.push("npx ng build --configuration development");
  // Nuxt's root tsconfig only points at generated ones; its own command checks pages and components.
  else if (deps.nuxt) steps.push("npx nuxi typecheck");
  else if (existsSync(join(root, "tsconfig.json"))) {
    // Next.js generates route types that `tsc` needs; `next typegen` writes them without a build.
    steps.push(deps.next ? "npx next typegen && npx tsc --noEmit" : "npx tsc --noEmit");
  }
  if (scripts.lint) steps.push(run("lint"));
  if (scripts.test && !PLACEHOLDER_TEST.test(scripts.test)) steps.push(run("test"));
  // create-vue names it test:unit and starts Vitest in watch mode; `--run` makes it finish.
  else if (scripts["test:unit"]) {
    steps.push(/\bvitest\b/.test(scripts["test:unit"]) && !/\brun\b/.test(scripts["test:unit"]) ? `${run("test:unit")} -- --run` : run("test:unit"));
  }
  // Only `next build` catches a client component that imports server code, `useSearchParams`
  // without Suspense, or a page that cannot prerender. ~5 s on a small app (2026-10-27).
  if (deps.next && scripts.build) steps.push(run("build"));
  return steps.length > 0 ? steps.join(" && ") : null;
}

// The kit's own files are not formatted to the project's Prettier settings, so `prettier --check .`
// fails on them and the check command can never pass. Adds the kit's folder (`.qwen/`) to
// .prettierignore once.
// Returns true when it changed the file. The benchmark calls this too, as part of installing the kit.
export function ignoreKitInPrettier(root) {
  const pkg = readJson(join(root, "package.json"));
  if (!pkg || !{ ...pkg.dependencies, ...pkg.devDependencies }.prettier) return false;
  const line = new RegExp(`^/?${KIT_DIR.replace(".", "\\.")}/?\\s*$`, "m");
  const ignored = (name) => existsSync(join(root, name)) && line.test(readFileSync(join(root, name), "utf8"));
  if (ignored(".prettierignore") || ignored(".gitignore")) return false;
  const path = join(root, ".prettierignore");
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const gap = text === "" || text.endsWith("\n") ? "" : "\n";
  writeFileSync(path, `${text}${gap}# Qwen Code kit (agent tooling, not app code)\n${KIT_DIR}/\n`);
  return true;
}

// The installed [major, minor] version of a package (falling back to package.json's range), or [0, 0].
export function version(root, name) {
  const pkg = readJson(join(root, "package.json")) ?? {};
  const text =
    readJson(join(root, "node_modules", name, "package.json"))?.version ??
    { ...pkg.dependencies, ...pkg.devDependencies }[name] ??
    "";
  const m = /(\d+)(?:\.(\d+))?/.exec(text);
  return m ? [Number(m[1]), Number(m[2] ?? 0)] : [0, 0];
}

// Imports a package from the project's own node_modules, or returns null when it is not installed.
export async function importFromProject(root, name) {
  try {
    const require = createRequire(join(root, "package.json"));
    return await import(pathToFileURL(require.resolve(name)).href);
  } catch {
    return null;
  }
}

export function output(object) {
  console.log(JSON.stringify(object));
}

// Where the plan-work skill saves the current plan, relative to the project root. Not under
// .qwen/: that folder is the kit, which the model must leave alone.
export const PLAN_FILE = ".local-agent/plan.md";

// "size:mtime" of the plan file, or null without one. The Stop hook compares it with the value at
// session start to tell this session's plan from an old one about other work.
export function planSignature(root) {
  try {
    const { size, mtimeMs } = statSync(join(root, PLAN_FILE));
    return `${size}:${mtimeMs}`;
  } catch {
    return null;
  }
}

// State the hooks share within one conversation (kept outside the project, so it never shows in
// git). Per conversation, not per project: with one file per project, a second chat in the same
// folder reset the first one's starting point, and its Stop hook then judged the other chat's
// work (2026-10-27). Helper agents send their parent's session_id, so they share it.
export const stateDir = join(tmpdir(), "local-coding-agent");

function stateFile(root, sessionId) {
  const project = createHash("sha1").update(root.toLowerCase()).digest("hex");
  const session = String(sessionId ?? "default").replace(/[^\w-]/g, "");
  return join(stateDir, `project-${project}-${session}.json`);
}

export function readState(root, sessionId) {
  try {
    return JSON.parse(readFileSync(stateFile(root, sessionId), "utf8"));
  } catch {
    return {};
  }
}

export function writeState(root, sessionId, state) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(stateFile(root, sessionId), JSON.stringify(state));
}

const NOT_SOURCE = new Set([
  ".git",
  ".claude", // agent settings
  ".qwen",
  ".local-agent", // the plan file: editing a plan alone should not trigger checks
  ".next",
  ".angular", // Angular CLI's build cache
  ".nuxt",
  ".output",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "test-results",
  "playwright-report",
  "blob-report",
  ".turbo",
  ".vercel",
]);

// A cheap summary of the project's files (names, sizes, times), to tell whether anything changed.
export function fingerprint(root) {
  return createHash("sha256").update(Object.entries(fileSignatures(root)).sort().join("\n")).digest("hex");
}

// Files created or modified since `before` (a fileSignatures() result), as relative paths.
export function changedFiles(root, before = {}) {
  const now = fileSignatures(root);
  return Object.keys(now).filter((path) => before[path] !== now[path]);
}

// Relative path -> "size:mtime" for every project file outside build output and dependencies.
export function fileSignatures(root) {
  const signatures = {};
  const walk = (dir) => {
    let list = [];
    try {
      list = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of list) {
      if (NOT_SOURCE.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && !entry.name.endsWith(".tsbuildinfo")) {
        const { size, mtimeMs } = statSync(path);
        signatures[relative(root, path).replaceAll("\\", "/")] = `${size}:${mtimeMs}`;
      }
    }
  };
  walk(root);
  return signatures;
}
