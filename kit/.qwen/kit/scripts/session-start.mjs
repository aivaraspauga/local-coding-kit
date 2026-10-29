// SessionStart hook: gives the model the working-style rules and this project's check command.
// It also runs after a compaction, so the rules survive when the conversation is summarized.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { dependencies, describe, packageDirs, packageFacts } from "./lib/deps.mjs";
import {
  checkCommand,
  fileSignatures,
  fingerprint,
  ignoreKitInPrettier,
  KIT_DIR,
  majorVersion,
  MOVE_UP_COMMAND,
  output,
  PLAN_FILE,
  planSignature,
  projectRoot,
  readInput,
  readJson,
  readState,
  version,
  writeState,
} from "./lib/project.mjs";

const input = readInput();
const kitRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = projectRoot();

// Before the fingerprint below, so this one-time change does not count as the agent's work.
const prettierIgnored = ignoreKitInPrettier(root);

// Remember how the project looked when the session began, so the Stop hook only runs the checks
// after the agent changed something. A compaction continues the same session.
// The dependencies are remembered too, so deps-check.mjs can tell what an install changed.
const depsByDir = Object.fromEntries(packageDirs(root).map((dir) => [dir, dependencies(dir)]));
if (input.source !== "compact") {
  writeState(root, input.session_id, {
    ...readState(root, input.session_id),
    sessionStart: fingerprint(root),
    startFiles: fileSignatures(root),
    failures: 0,
    reviewShown: [],
    planStart: planSignature(root),
    planShown: false,
    deps: depsByDir,
  });
}
// LOCAL_AGENT_STE=0 drops the Simplified Technical English rules for messages to the user.
// CRLF (a kit unpacked or cloned with Windows line endings) would hide the headings from the match.
const fullStyle = readFileSync(join(kitRoot, "prompt", "working-style.md"), "utf8").replace(/\r\n/g, "\n");
const style =
  process.env.LOCAL_AGENT_STE === "0" ? fullStyle.replace(/## Messages to the user\n[\s\S]*?\n(?=## )/, "") : fullStyle;

// True when something already listens on the port (IPv4 or the dual-stack default).
const portInUse = (port) =>
  Promise.all(
    [undefined, "127.0.0.1"].map(
      (host) =>
        new Promise((resolve) => {
          const server = createServer();
          server.once("error", (error) => resolve(error.code === "EADDRINUSE"));
          server.once("listening", () => server.close(() => resolve(false)));
          server.listen(port, host);
        }),
    ),
  ).then((results) => results.some(Boolean));

const facts = [];
const check = checkCommand(root);
facts.push(
  check
    ? `This project's checks: \`${check}\`. A hook runs them when you finish and sends you back if they fail.`
    : "This project has no check command the hooks could find. Verify your work by running it, and tell the user what you ran.",
);
if (prettierIgnored) {
  facts.push(
    `The kit just added \`${KIT_DIR}/\` to \`.prettierignore\`, so Prettier skips the kit's own files. Mention this once in your report.`,
  );
}
// A new project: nothing here but the kit. Generators refuse a folder with files in it, and the
// kit's own files are such files; the model only learned that from a failed run (2026-10-28 review).
const KIT_ONLY = new Set([".git", ".gitignore", ".gitattributes", KIT_DIR, "QWEN.md", ".local-agent", ".prettierignore", ".vscode", ".idea"]);
if (!existsSync(join(root, "package.json")) && readdirSync(root).every((name) => KIT_ONLY.has(name))) {
  facts.push(
    `This folder has no app yet, only the kit's files. App generators (create-next-app, create vite, ...) refuse a folder with files in it, so create the app in a subfolder NAME (\`npx create-next-app@latest NAME --yes --skip-install\`, plus the options you need), then move it up with this command (it works in every shell): ${MOVE_UP_COMMAND} Then run npm install.`,
  );
}
if (!existsSync(join(root, "AGENTS.md"))) {
  facts.push("This project has no AGENTS.md. Before a bigger task, use the `onboard-repo` skill to write one.");
}

// Versions where a model's training data is out of date and its habits break the app. Each claim
// here was checked on a real install of that version.
const pkg = readJson(join(root, "package.json")) ?? {};
const deps = { ...pkg.dependencies, ...pkg.devDependencies };
// Named outright: Qwen skipped the `vue` skill in a Vue task and read vue-router's .d.ts instead (2026-10-11).
const frameworkSkill =
  deps.next || deps.react ? "react-nextjs" : deps.vue || deps.nuxt ? "vue" : deps["@angular/core"] ? "angular" : null;
if (frameworkSkill) {
  facts.push(`Load the \`${frameworkSkill}\` skill in your first message, before reading files; its examples are checked against this stack.`);
}
const nextMajor = majorVersion(root, "next");
if (nextMajor >= 15) {
  facts.push(
    `Next.js ${nextMajor}: \`params\`, \`searchParams\`, \`cookies()\` and \`headers()\` are Promises; await them (\`const { id } = await params\`). The type checks do not catch \`params.id\` without \`await\`: the page just renders it empty and the dev server logs "params is a Promise".` +
      (nextMajor >= 16 ? " Middleware is now `proxy.ts` exporting a `proxy` function." : "") +
      " See the `react-nextjs` skill.",
  );
}
// `next dev` writes "This is NOT the Next.js you know ... read the relevant guide before writing any
// code" into AGENTS.md. Qwen read it as "a modified Next.js" and toured the docs before every task.
const agentNotes = existsSync(join(root, "AGENTS.md")) ? readFileSync(join(root, "AGENTS.md"), "utf8") : "";
if (nextMajor > 0 && agentNotes.includes("This is NOT the Next.js you know")) {
  facts.push(
    `The "This is NOT the Next.js you know" note in AGENTS.md is written by \`next dev\` into every project: this is the official Next.js ${nextMajor}, newer than your training data. Its changes that matter most are listed here and in the \`react-nextjs\` skill. Read a guide in \`node_modules/next/dist/docs/\` when you use a Next.js API you are unsure of, only that one guide; no tour of the docs.`,
  );
}
if (nextMajor > 0 && deps["@playwright/test"]) {
  facts.push(
    "Playwright with Next.js: once a page hydrates it has a hidden route announcer with `role=\"alert\"`, so `page.getByRole(\"alert\")` matches two elements and fails (it can pass on a fast run, then fail). `getByRole(\"alert\", { name: \"...\" })` finds nothing: an alert's name doesn't come from its text. Use `page.getByRole(\"alert\").filter({ hasText: \"...\" })`.",
  );
}
// The app's usual port taken by another program: Playwright's webServer with reuseExistingServer
// then tests that program. Both sides of a kit vs no-kit run lost their first e2e run to an app on
// port 3000 (2026-10-28).
const appPort = nextMajor > 0 || deps.nuxt ? 3000 : deps["@angular/core"] ? 4200 : deps.vite ? 5173 : null;
if (appPort && (await portInUse(appPort))) {
  facts.push(
    `Port ${appPort} is already in use on this PC (another program, or a server left running). Start the dev server on a free port (\`npm run dev -- --port 3100\`) and run the app's tests against that port${deps["@playwright/test"] ? `; a Playwright config with \`reuseExistingServer\` would otherwise test whatever answers on ${appPort}` : ""}. Do not stop a program you did not start.`,
  );
}
const shadcnStyle = readJson(join(root, "components.json"))?.style ?? "";
if (shadcnStyle.startsWith("base-") || (shadcnStyle && deps["@base-ui/react"])) {
  facts.push(
    "The shadcn/ui components here are built on Base UI, not Radix: there is no `asChild` (use `render={<Button />}`), `Button` defaults to `type=\"button\"`, and `Select` passes `string | null` to `onValueChange`. Use the `shadcn-ui` skill before adding or using them.",
  );
}
if (majorVersion(root, "zod") >= 4) {
  facts.push(
    "Zod 4: messages go in `{ error: \"...\" }` (`required_error` is gone), errors are in `err.issues` (not `err.errors`), and `z.email()` replaces `z.string().email()`.",
  );
}
const vitestConfig = ["vitest.config.mts", "vitest.config.ts", "vitest.config.mjs", "vitest.config.js"]
  .map((name) => join(root, name))
  .find((path) => existsSync(path));
if (vitestConfig && /environment:\s*["']node["']/.test(readFileSync(vitestConfig, "utf8"))) {
  facts.push(
    "Vitest runs tests in Node here. A component test needs `// @vitest-environment jsdom` as its first line, or it fails with \"document is not defined\".",
  );
}

// Angular.
const [angularMajor] = version(root, "@angular/core");
if (angularMajor > 0 && angularMajor < 17) {
  facts.push(
    `Angular ${angularMajor} has no \`@if\`/\`@for\` blocks and no \`input()\`/\`output()\` functions: use \`*ngIf\`/\`*ngFor\` (with \`CommonModule\` in \`imports\`, or the element silently never shows) and \`@Input()\`/\`@Output()\`. See the version table in the \`angular\` skill.`,
  );
} else if (angularMajor >= 17) {
  const angularJson = existsSync(join(root, "angular.json")) ? readFileSync(join(root, "angular.json"), "utf8") : "";
  const zoneless = angularMajor >= 21 && !deps["zone.js"] && !angularJson.includes("zone.js");
  facts.push(
    `Angular ${angularMajor}` +
      (zoneless
        ? `: zoneless${angularMajor >= 22 ? " with OnPush by default" : ""}. Keep component state in signals; a plain field set in a timer, promise or subscription never shows on screen.`
        : ": check the version table in the `angular` skill before using signal inputs, resources or signal forms.") +
      (angularMajor >= 21 && deps.vitest ? " `ng test` runs Vitest: `vi.fn()`, not `jasmine.createSpy`." : "") +
      " See the `angular` skill.",
  );
}

// Vue.
const [vueMajor, vueMinor] = version(root, "vue");
if (vueMajor === 2) {
  facts.push(
    "Vue 2: Options API and `this`. A property added later or an array item set by index is not reactive (use `this.$set` or `splice`), and there is no `defineModel` or `useId`. See the Vue 2 section of the `vue` skill.",
  );
} else if (vueMajor === 3) {
  const vueNotes = [
    vueMinor >= 5 && "watch a destructured prop with a getter (`watch(() => count, ...)`)",
    deps.pinia && "destructuring a Pinia store loses reactivity; use `storeToRefs(store)`",
    deps["vue-router"] && "when only the route params change, the page component is reused: watch the param",
  ].filter(Boolean);
  if (vueNotes.length > 0) facts.push(`Vue 3.${vueMinor}: ${vueNotes.join("; ")}. See the \`vue\` skill.`);
}

// TypeScript and the tsconfig settings that decide what compiles.
const [tsMajor] = version(root, "typescript");
const tsconfigText = ["tsconfig.json", "tsconfig.app.json"]
  .map((name) => (existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8") : ""))
  .join("\n");
const setting = (name) => new RegExp(`"${name}"\\s*:\\s*true`).test(tsconfigText);
const tsNotes = [
  tsMajor >= 6 && "`strict` is on and `@types` packages load only when listed in `types`, unless the tsconfig says otherwise",
  setting("verbatimModuleSyntax") && "import types with `import type`",
  setting("erasableSyntaxOnly") && "no `enum`, `namespace` or constructor parameter properties (use an `as const` object)",
  setting("noUncheckedIndexedAccess") && "`items[0]` and `record[key]` may be `undefined`",
].filter(Boolean);
if (tsMajor > 0 && tsNotes.length > 0) {
  facts.push(`TypeScript ${tsMajor}: ${tsNotes.join("; ")}. See the \`typescript\` skill.`);
}

// Dependencies released after the model's training data, or behind the latest release.
const rootDeps = depsByDir[root] ?? {};
if (Object.keys(rootDeps).length > 0) {
  const lines = describe(root, rootDeps, await packageFacts(Object.keys(rootDeps)));
  if (lines.length > 0) {
    facts.push(
      `Dependencies to know about (the installed version decides which API you use):\n${lines
        .slice(0, 10)
        .map((line) => `  - ${line}`)
        .join("\n")}`,
    );
  }
}

// A plan saved by the plan-work skill. After a compaction the conversation no longer holds it,
// so it comes back in full; at the start of a session only its progress is mentioned.
let planSection = "";
const planPath = join(root, PLAN_FILE);
if (existsSync(planPath)) {
  const plan = readFileSync(planPath, "utf8");
  const done = (plan.match(/^\s*[-*] \[x\]/gim) ?? []).length;
  const total = done + (plan.match(/^\s*[-*] \[ \]/gm) ?? []).length;
  if (input.source === "compact") {
    planSection =
      `\n## Your current plan (${PLAN_FILE}, ${done} of ${total} steps done)\n` +
      "The conversation was just summarized. Continue from the first unchecked step, and keep ticking steps off in the file.\n\n" +
      `${plan.slice(0, 8000)}\n`;
  } else if (done < total) {
    facts.push(
      `There is an unfinished plan in \`${PLAN_FILE}\` (${done} of ${total} steps done). If the user's request continues that work, read it and carry on from the first unchecked step; otherwise ignore it.`,
    );
  }
}

output({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: `${style}\n## This project\n${facts.map((fact) => `- ${fact}`).join("\n")}\n${planSection}`,
  },
});
