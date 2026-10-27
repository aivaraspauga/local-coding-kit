// PostToolUse hook (shell): formats the components `shadcn add` generated. After a command
// that installs, upgrades or scaffolds packages, also tells the model what changed: versions that came out after its training data (with the docs to
// read before using them), old versions it installed without need, and high or critical
// vulnerabilities in the packages the app ships (`npm audit --omit=dev`; dev tools are left out).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { dependencies, describe, packageDirs, packageFacts } from "./lib/deps.mjs";
import { importFromProject, output, projectRoot, readInput, readState, writeState } from "./lib/project.mjs";

// High and critical advisories in what ships, as "name (severity: title)", or [] when npm audit
// can't run (offline, no lockfile, another package manager). npm audit sends the lockfile's
// package list to the registry, so LOCAL_AGENT_OFFLINE=1 turns it off like the release-date
// lookups. LOCAL_AGENT_AUDIT_FILE stands in for npm's JSON output in tests.
function shippedVulnerabilities(dir) {
  if (process.env.LOCAL_AGENT_OFFLINE === "1") return [];
  if (!existsSync(join(dir, "package-lock.json"))) return [];
  let text = "";
  if (process.env.LOCAL_AGENT_AUDIT_FILE) {
    text = readFileSync(process.env.LOCAL_AGENT_AUDIT_FILE, "utf8");
  } else {
    // npm audit exits 1 when it finds anything, so the exit code says nothing about success.
    // 10 s keeps the hook inside its 20 s limit in settings.json (a normal run takes about 1 s).
    const run = spawnSync("npm audit --omit=dev --json", { cwd: dir, shell: true, encoding: "utf8", timeout: 10_000 });
    text = run.stdout ?? "";
  }
  try {
    const report = JSON.parse(text);
    return Object.entries(report.vulnerabilities ?? {})
      .filter(([, info]) => info.severity === "high" || info.severity === "critical")
      .map(([name, info]) => {
        const title = (info.via ?? []).find((via) => typeof via === "object")?.title;
        return `${name} (${info.severity}${title ? `: ${title}` : ""})`;
      });
  } catch {
    return [];
  }
}

const INSTALLS =
  /\b(npm|pnpm|yarn|bun)\s+(install|i|add|update|upgrade|up|create)\b|\bnpx\s+(-y\s+|--yes\s+)?[\w@./-]*create[\w@./-]*|\bnpm\s+init\s+[\w@]/i;

// `shadcn add` writes components Prettier rejects, and the format hook only sees Edit and Write. In a
// benchmark run the model then failed `format:check` and spent a round fixing generated files, so
// they are formatted here: files in a components/ui folder changed in the last 10 minutes.
const SHADCN_ADD = /\bshadcn(@[\w.-]+)?\s+add\b/i;

async function formatGenerated(root) {
  const prettierModule = await importFromProject(root, "prettier");
  const prettier = prettierModule?.default ?? prettierModule;
  if (!prettier?.format) return;
  // Prettier finds plugins and ignore files from the working folder, as in format-file.mjs.
  process.chdir(root);
  for (const folder of ["src/components/ui", "components/ui"]) {
    const dir = join(root, folder);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      if (!/\.[cm]?[jt]sx?$/.test(name) || Date.now() - statSync(file).mtimeMs > 10 * 60 * 1000) continue;
      const info = await prettier.getFileInfo(file, { ignorePath: [".gitignore", ".prettierignore"] });
      if (info.ignored || !info.inferredParser) continue;
      const options = (await prettier.resolveConfig(file)) ?? {};
      const source = readFileSync(file, "utf8");
      const formatted = await prettier.format(source, { ...options, filepath: file });
      if (formatted !== source) writeFileSync(file, formatted);
    }
  }
}

const input = readInput();
const command = String(input.tool_input?.command ?? "");
if (SHADCN_ADD.test(command)) {
  try {
    await formatGenerated(projectRoot());
  } catch {
    // Formatting is a convenience; the format check still reports anything left over.
  }
}
if (!INSTALLS.test(command)) process.exit(0);

const root = projectRoot();
const before = readState(root, input.session_id).deps ?? {};
const after = {};
const lines = [];
const vulnerable = [];
for (const dir of packageDirs(root)) {
  const now = dependencies(dir);
  after[dir] = now;
  const old = before[dir] ?? {};
  const changed = new Set(Object.keys(now).filter((name) => old[name] !== now[name]));
  if (changed.size === 0) continue;
  const versions = Object.fromEntries([...changed].map((name) => [name, now[name]]));
  const facts = await packageFacts([...changed]);
  const prefix = dir === root ? "" : `${relative(root, dir).replaceAll("\\", "/")}: `;
  for (const line of describe(dir, versions, facts, { changed })) lines.push(prefix + line);
  // Only the project's own folder: each audit can take seconds, and the hook has 20 in all.
  if (dir === root) vulnerable.push(...shippedVulnerabilities(dir));
}
writeState(root, input.session_id, { ...readState(root, input.session_id), deps: after });

const notes = [];
if (lines.length > 0) {
  notes.push(
    `Packages that command added or changed:\n- ${lines.slice(0, 12).join("\n- ")}\n` +
      "The installed versions decide which API you use. After reading what changed, add the two or three changes that matter for this project to the Lessons section of AGENTS.md, each with the version that made it, so later sessions do not have to look again. Write only what the changelog or docs line itself says; a summary of a web page can be wrong.",
  );
}
if (vulnerable.length > 0) {
  notes.push(
    `npm audit found high or critical vulnerabilities in packages the app ships (dev tools left out):\n- ${vulnerable.slice(0, 10).join("\n- ")}\n` +
      "Tell the user. If a package you just added brought it in, prefer a version or alternative without it. `npm audit fix` is fine; `npm audit fix --force` changes major versions, so ask first.",
  );
}
if (notes.length > 0) {
  output({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: notes.join("\n\n") } });
}
