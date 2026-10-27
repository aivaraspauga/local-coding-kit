// Finds debugging leftovers in the files a session changed: temporary scripts and screenshots,
// console.log / debugger / .only in code. Uses git's diff for added lines when the project is a
// git repository, so existing code is never flagged.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

// Clearly throwaway names only, so a real `verify-email.tsx` or `debug-panel.tsx` is not flagged.
const TEMP_FILE = /^(tmp|temp|scratch|probe)([._-]|\d|$)|[._-](tmp|temp|scratch)\.|\.tmp\./i;
// New images outside the places real assets live are usually screenshots taken while checking.
const STRAY_IMAGE = (path) => /\.(png|jpe?g|webp)$/i.test(path) && !/^(public|src|app|assets|static|docs)\//.test(path);
const CODE_FILE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /(^|\/)(tests?|e2e|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const SPEC_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
// A test file that defines no test: a debugging probe emptied because the model could not delete it.
const DEFINES_TEST = /\b(test|it|describe)(\.\w+)*\s*\(/;
// Folders where console output is normal: CLI scripts, build tooling.
const SCRIPT_DIR = /^(scripts|bin|tools)\//;
const PATTERNS = [
  [/\bconsole\.log\(/, "console.log", (path) => !TEST_FILE.test(path) && !SCRIPT_DIR.test(path)],
  [/\bdebugger\b/, "debugger", () => true],
  [/\b(test|it|describe)\.only\(/, ".only in a test", () => true],
];

// Lines added to `path` since the last commit, or null when that can't be told (no git, new file).
// Remembered per run, because the leftovers and risks scans both ask for the same files.
const diffs = new Map();
export function addedLines(root, path, newFile) {
  if (newFile || !existsSync(join(root, ".git"))) return null;
  const key = `${root}\n${path}`;
  if (!diffs.has(key)) {
    const diff = spawnSync("git", ["diff", "--no-color", "-U0", "HEAD", "--", path], {
      cwd: root,
      encoding: "utf8",
    });
    diffs.set(
      key,
      diff.status !== 0
        ? null
        : diff.stdout
            .split("\n")
            .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
            .map((line) => line.slice(1)),
    );
  }
  return diffs.get(key);
}

// `changed` are relative paths; `startFiles` is the session's starting file list.
export function findLeftovers(root, changed, startFiles = {}) {
  const findings = [];
  for (const path of changed) {
    const newFile = !(path in startFiles);
    if (!existsSync(join(root, path))) continue;
    if (newFile && (TEMP_FILE.test(basename(path)) || STRAY_IMAGE(path))) {
      findings.push(`${path}: looks like a temporary file you created (delete it if it was only for checking)`);
      continue;
    }
    if (newFile && SPEC_FILE.test(path) && !DEFINES_TEST.test(readFileSync(join(root, path), "utf8"))) {
      findings.push(`${path}: a new test file with no tests in it (a debugging probe? delete it, or ask the user to)`);
      continue;
    }
    if (!CODE_FILE.test(path)) continue;
    // Without git, only judge whole files that are new this session.
    const lines = addedLines(root, path, newFile) ?? (newFile ? readFileSync(join(root, path), "utf8").split("\n") : []);
    for (const [pattern, label, applies] of PATTERNS) {
      if (!applies(path)) continue;
      const hit = lines.find((line) => pattern.test(line));
      if (hit) findings.push(`${path}: ${label} left in (\`${hit.trim().slice(0, 80)}\`)`);
    }
  }
  return findings;
}
