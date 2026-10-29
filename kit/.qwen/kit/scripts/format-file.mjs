// PostToolUse hook (edit, write_file): applies the project's own ESLint fixes and Prettier to the
// edited file, then reports ESLint errors (and mistakes no check catches: Next.js params, a Response
// shared across requests) back to the agent
// (exit 2) and warnings as a note, each warning once per conversation.
// Projects without ESLint or Prettier are left alone.
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { importFromProject, majorVersion, output, projectRoot, readInput, readState, writeState } from "./lib/project.mjs";
import { SHARED_RESPONSE } from "./lib/risks.mjs";

const ROUTE_FILE = /(^|\/)app\/(.+\/)?(page|layout|route|default|template)\.[cm]?[jt]sx?$/;
const TEST_FILE = /(^|\/)(tests?|e2e|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

const input = readInput();
const root = projectRoot();
const file = input.tool_input?.file_path ?? input.tool_response?.filePath;
if (!file) process.exit(0);

const abs = resolve(root, file);
const rel = relative(root, abs).replaceAll("\\", "/");
if (rel.startsWith("..") || isAbsolute(rel) || /(^|\/)(node_modules|\.next|dist|build|\.claude|\.qwen)\//.test(rel)) {
  process.exit(0);
}
process.chdir(root);

try {
  const errors = [];
  const warnings = [];

  const eslintModule = /\.[cm]?[jt]sx?$/.test(abs) ? await importFromProject(root, "eslint") : null;
  if (eslintModule) {
    const { ESLint } = eslintModule;
    let eslint = null;
    try {
      eslint = new ESLint({ cwd: root, fix: true });
      if (await eslint.isPathIgnored(abs)) eslint = null;
    } catch {
      eslint = null; // no usable ESLint config in this project
    }
    if (eslint) {
      const results = await eslint.lintFiles([abs]);
      await ESLint.outputFixes(results);
      for (const message of results.flatMap((r) => r.messages)) {
        const line = `${rel}:${message.line}:${message.column} ${message.message} (${message.ruleId})`;
        if (message.severity === 2) errors.push(line);
        // Keyed without the line number, which moves as the file grows.
        else warnings.push({ line, key: `${rel} ${message.message} (${message.ruleId})` });
      }
    }
  }

  const prettierModule = await importFromProject(root, "prettier");
  const prettier = prettierModule?.default ?? prettierModule;
  if (prettier?.format) {
    const info = await prettier.getFileInfo(abs, { ignorePath: [".gitignore", ".prettierignore"] });
    if (!info.ignored && info.inferredParser) {
      const options = (await prettier.resolveConfig(abs)) ?? {};
      const source = readFileSync(abs, "utf8");
      const formatted = await prettier.format(source, { ...options, filepath: abs });
      if (formatted !== source) writeFileSync(abs, formatted);
    }
  }

  // Next.js 15+: `params` and `searchParams` are Promises. TypeScript accepts the old object type
  // in route files (Next's route types allow it) and the page then renders the value empty, so no
  // check would notice.
  if (ROUTE_FILE.test(rel) && majorVersion(root, "next") >= 15) {
    readFileSync(abs, "utf8")
      .split("\n")
      .forEach((text, i) => {
        if (/\b(params|searchParams)\??\s*:\s*(\{|Record<)/.test(text)) {
          errors.push(
            `${rel}:${i + 1} \`params\` and \`searchParams\` are Promises in Next.js 15+: type them as \`Promise<{ ... }>\` and \`await\` them. The type checks accept the old form, but the value renders empty. (next-params-promise)`,
          );
        }
      });
  }

  // One Response kept in a module variable: no check fails, the first request works, and every
  // later one gets an empty body (lib/risks.mjs).
  if (/\.[cm]?[jt]sx?$/.test(rel) && !TEST_FILE.test(rel)) {
    const source = readFileSync(abs, "utf8");
    for (const match of source.matchAll(SHARED_RESPONSE)) {
      const line = source.slice(0, match.index).split("\n").length;
      errors.push(
        `${rel}:${line} \`${match[1]}\` is one Response made when the module loads. Its body can be read only once, so every request after the first gets an empty body. Build a new Response in each call (a function that returns it). (shared-response)`,
      );
    }
  }

  if (errors.length > 0) {
    console.error(`Errors in ${rel} that auto-fix could not resolve:\n${errors.join("\n")}`);
    process.exit(2);
  }
  // Each warning once per conversation. A file written in steps (imports first, their use later)
  // got the same "defined but never used" note on every edit: 6 notes in one 13-minute run, the
  // same one twice in 5 seconds (2026-10-27).
  const state = readState(root, input.session_id);
  const shown = new Set(state.lintShown ?? []);
  const fresh = warnings.filter((warning) => !shown.has(warning.key));
  if (fresh.length > 0) {
    writeState(root, input.session_id, { ...state, lintShown: [...shown, ...fresh.map((warning) => warning.key)] });
    output({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: `ESLint warnings in ${rel}; fix them unless there is a reason not to:\n${fresh.map((warning) => warning.line).join("\n")}`,
      },
    });
  }
} catch (error) {
  // A syntax error the formatter cannot parse is useful feedback for the agent too.
  console.error(`Could not format ${rel}: ${error instanceof Error ? error.message : error}`);
  process.exit(2);
}
