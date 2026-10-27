// Finds risky lines a session added: secrets in code, secrets exposed to the browser, silenced
// errors, raw HTML, eval, SQL built from strings, switched-off TLS checks, an `.env` file git would
// commit, and a changed AGENTS.md (whose new lines must have a source). Only added lines count (git
// diff, or whole files that are new this session), so existing code is never flagged. Patterns are
// kept narrow: each finding is a reminder to look, shown once, not proof of a bug.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { addedLines } from "./leftovers.mjs";

const CODE_FILE = /\.([cm]?[jt]sx?|vue|svelte|astro|html)$/;
const TEST_FILE = /(^|\/)(tests?|e2e|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const ENV_FILE = /^\.env(\.[\w-]+)?$/;
const ENV_EXAMPLE = /example|sample|template|defaults?$/i;
// Values that are obviously not real secrets: placeholders and references to other values...
const PLACEHOLDER =
  /^(x+|\*+|\.+|changeme|change-me|secret|password|todo|tbd|none|null|undefined|your[-_ ].*|my[-_ ].*|example.*|placeholder.*|dummy.*|fake.*|test.*|<.*>|\$\{.*|process\.env.*)$/i;
// ...and, case-sensitive: paths, env variable names (OPENAI_API_KEY) and plain kebab-case words
// ("reset-password", "current-password").
const NOT_A_VALUE = /^([/.#].*|[A-Z][A-Z0-9_]+|[a-z]+(-[a-z]+)+)$/;

const TOKEN_FORMATS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, // GitHub token
  /\b(sk|rk)_(live|test)_[A-Za-z0-9]{10,}\b/, // Stripe secret key
  /\bsk-(ant-|proj-)?[A-Za-z0-9_-]{20,}\b/, // OpenAI / Anthropic key
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, // Slack token
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API key
];
// A name containing a secret word (JWT_SECRET, DATABASE_PASSWORD, stripeSecretKey, apiKey) given a
// literal string value.
const SECRET_ASSIGNMENT =
  /(?<![\w$])[\w$]*?(secret|password|passwd|api[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key)[\w$]*["']?\s*[:=]\s*["'`]([^"'`\s]{8,})["'`]/i;

// [pattern, what to say, applies to (path) => boolean]. Lines are checked one at a time.
const RULES = [
  [
    /\b(NEXT_PUBLIC|VITE|NUXT_PUBLIC|PUBLIC)_\w*(SECRET|PRIVATE|PASSWORD|PASSWD|SERVICE_ROLE|ACCESS_TOKEN|AUTH_TOKEN|DATABASE_URL|(OPENAI|ANTHROPIC|GEMINI|GROQ|MISTRAL)\w*KEY)\w*/,
    "a secret-looking name with a public prefix (the browser gets every NEXT_PUBLIC_/VITE_/NUXT_PUBLIC_ value)",
    () => true,
  ],
  [/@ts-(ignore|nocheck|expect-error)|eslint-disable/, "an error suppression", (path) => CODE_FILE.test(path)],
  // Only the TypeScript form (`x as any;`, `(y as any).z`), not "use it as any other page" in JSX text.
  [/\bas any(?=\s*([;,)\].}>]|$))/, "`as any`, which switches off type checking", (path) => CODE_FILE.test(path)],
  [/\b(test|it|describe)\.skip\(/, "a skipped test", (path) => CODE_FILE.test(path)],
  [
    /dangerouslySetInnerHTML|\bv-html\b|\[innerHTML\]|insertAdjacentHTML\(|document\.write\(|\.(innerHTML|outerHTML)\s*\+?=(?!=)(?!\s*(["'])[^"'$]*\2\s*;?\s*$)/,
    "raw HTML (only safe with content you wrote or sanitized; user text is an XSS hole)",
    (path) => CODE_FILE.test(path),
  ],
  [/\beval\(|\bnew Function\(/, "`eval` / `new Function`", (path) => CODE_FILE.test(path) && !TEST_FILE.test(path)],
  [
    // An SQL statement in an untagged template literal with `${...}` in it (a tagged template such
    // as sql`...` is safe and has a name before the backtick), an SQL string joined with `+`, or an
    // explicitly unsafe raw-query API.
    /(?<![\w.$])`\s*(SELECT\b[^`]*\bFROM|INSERT\s+INTO|UPDATE\s+["`\w.]+\s+SET|DELETE\s+FROM)\b[^`]*\$\{|(["'])\s*(SELECT\b[^"']*\bFROM|INSERT\s+INTO|UPDATE\s+["`\w.]+\s+SET|DELETE\s+FROM)\b[^"']*\3\s*\+|\$(queryRaw|executeRaw)Unsafe\(|\.unsafe\(/i,
    "SQL built from strings (use placeholders like `?`/`$1` or a tagged template, so input can't change the query)",
    (path) => CODE_FILE.test(path) && !TEST_FILE.test(path),
    // Checked over the added lines together: formatters often put `SELECT` and `${...}` on
    // different lines of one template literal.
    { multiline: true },
  ],
  [
    /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED/,
    "TLS certificate checks switched off",
    (path) => CODE_FILE.test(path) || ENV_FILE.test(basename(path)),
  ],
  [
    /Access-Control-Allow-Origin["']?\s*[,:]\s*["']\*["']/,
    "`Access-Control-Allow-Origin: *` (any site can read the response)",
    (path) => CODE_FILE.test(path),
  ],
];

// An endpoint that changes data: a route handler exporting POST/PUT/PATCH/DELETE, or a Server Action.
const MUTATION_ENDPOINT = /export\s+(async\s+)?(function|const)\s+(POST|PUT|PATCH|DELETE)\b|^\s*["']use server["']/m;
// Signs of a login or permission check: the usual helper names of auth libraries and of the
// `security` skill's data-access pattern.
const AUTH_SIGN =
  /\b(auth|getSession|getServerSession|currentUser|getCurrentUser|getUser|requireUser|requireAuth|requireAdmin|requireRole|verifySession|verifyToken|validateRequest|withAuth|checkPermission|authorize)\s*\(|\bsupabase\.auth\./;

function secretIn(line) {
  if (TOKEN_FORMATS.some((format) => format.test(line))) return true;
  const match = SECRET_ASSIGNMENT.exec(line);
  return Boolean(match && !PLACEHOLDER.test(match[2]) && !NOT_A_VALUE.test(match[2]));
}

function gitWouldCommit(root, path) {
  if (!existsSync(join(root, ".git"))) return false;
  // Exit 1: not ignored. Exit 0: ignored. Anything else: can't tell, so say nothing.
  return spawnSync("git", ["check-ignore", "-q", "--", path], { cwd: root }).status === 1;
}

function readLines(root, path) {
  try {
    return readFileSync(join(root, path), "utf8").split("\n");
  } catch {
    return []; // locked or unreadable: say nothing rather than break the Stop hook
  }
}

// `changed` are relative paths; `startFiles` is the session's starting file list.
export function findRisks(root, changed, startFiles = {}) {
  const findings = [];
  for (const path of changed) {
    if (!existsSync(join(root, path))) continue;
    const newFile = !(path in startFiles);
    const name = basename(path);

    if (name === "AGENTS.md") {
      findings.push(
        `${path}: changed. Check every line you added is something you ran or read in a file; a Lesson names the version and where it came from. A Lesson that says a tool or framework does not work needs a new, minimal file that shows it; a failure in your own code is not proof. Fix or remove any line you can't back up`,
      );
      continue;
    }
    const env = ENV_FILE.test(name);
    if (env && newFile && !ENV_EXAMPLE.test(name) && gitWouldCommit(root, path)) {
      findings.push(`${path}: an env file git would commit (add it to .gitignore; commit a .env.example without values instead)`);
    }
    if (!env && !CODE_FILE.test(path)) continue;

    // Without git, only judge whole files that are new this session.
    const lines = addedLines(root, path, newFile) ?? (newFile ? readLines(root, path) : []);
    // Env files are where secrets belong; in code, test fixtures may hold fake ones.
    if (!env && !TEST_FILE.test(path) && lines.some(secretIn)) {
      findings.push(`${path}: what looks like a hardcoded secret (move it to an env variable read only on the server)`);
    }
    for (const [pattern, label, applies, options] of RULES) {
      if (!applies(path)) continue;
      let hit = lines.find((line) => pattern.test(line));
      if (!hit && options?.multiline) {
        const text = lines.join("\n");
        const match = pattern.exec(text);
        if (match) hit = text.slice(text.lastIndexOf("\n", match.index) + 1).split("\n")[0];
      }
      if (hit) findings.push(`${path}: ${label} (\`${hit.trim().slice(0, 80)}\`)`);
    }
    // A new data-changing endpoint, and nothing in its file that checks who is calling. The check
    // may live in the server function it calls; then the model says so instead of adding one.
    if (!env && !TEST_FILE.test(path) && MUTATION_ENDPOINT.test(lines.join("\n"))) {
      const file = readLines(root, path).join("\n");
      if (!AUTH_SIGN.test(file)) {
        findings.push(
          `${path}: a route handler or Server Action that changes data, with no login or permission check in this file (add one; if the server function it calls does the check, or the endpoint is public on purpose, say so in your report)`,
        );
      }
    }
  }
  return findings;
}
