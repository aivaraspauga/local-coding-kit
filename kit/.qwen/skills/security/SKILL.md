---
name: security
description: Auth checks, input validation, injection, XSS, secrets, cookies, uploads, webhooks. Use for anything touching users, input, API routes, Server Actions, queries or secrets.
---

# Secure by default

Check each section that applies to your change. Before writing auth or Server Action code in Next.js, read `node_modules/next/dist/docs/01-app/02-guides/data-security.md`.

## 1. Every server entry point checks the caller

A route handler, Server Action or API endpoint is public: anyone can call it directly, whatever your UI shows. In Next.js, an exported Server Action is reachable by a direct POST, and a login check on the page does not cover the actions inside it. So in **each** one:

1. **Authenticate:** who is calling? No user → 401 / throw.
2. **Authorize the specific thing:** may *this* user touch *this* record (owner, team, role)? Checking only "logged in" lets any user read or delete anyone's data by changing an id (IDOR).
3. **Validate the input** (section 2).
4. **Return only what the UI needs**, never the raw database row (it may hold password hashes, emails, internal fields).

Keep these checks in one server-only data module, so actions and routes stay thin and nothing skips them:

```ts
// src/server/posts.ts
import "server-only"; // importing this file from client code becomes a build error

export async function deletePost(postId: string) {
  const user = await getCurrentUser(); // from the project's auth library
  if (!user) throw new Error("Unauthorized");
  const post = await db.post.findUnique({ where: { id: postId } });
  if (!post || post.authorId !== user.id) throw new Error("Forbidden");
  await db.post.delete({ where: { id: postId } });
}
```

No auth yet and the feature needs it? Use the library the user named. If they named none, do not stop to ask: pick one well-known library that does email and password with the project's database (Better Auth is a common choice for Next.js; it takes Node's `node:sqlite` `DatabaseSync` directly), check its install and setup in its docs for the installed version, and name your choice in the report. For plain email and password in a small app, Node's built-in `scrypt` is also fine, done exactly as section 6 shows; name that choice too. Never invent your own hashing scheme, token format or crypto.

## 2. Validate input on the server

Form data, JSON bodies, `params`, `searchParams`, headers and cookies all come from the user and can be anything. Validate at the server boundary with the project's schema library (zod, valibot), with limits: string lengths, number ranges, array sizes, allowed values. Never trust a role, price, owner id or "isAdmin" sent by the client; read them from the session or the database. Client-side validation is only for the user's convenience.

## 3. Database: parameters, never string building

```ts
db.prepare(`SELECT * FROM users WHERE email = '${email}'`).get(); // BAD: injection
db.prepare("SELECT * FROM users WHERE email = ?").get(email);    // good (better-sqlite3)
await pool.query("SELECT * FROM users WHERE email = $1", [email]); // good (pg)
await prisma.$queryRaw`SELECT * FROM users WHERE email = ${email}`; // good: tagged template
// $queryRawUnsafe / $executeRawUnsafe with user input: never
```

A column or table name from user input (a sort field) can't be a parameter: check it against a fixed list (`["name", "createdAt"].includes(sort)`).

## 4. Output: no raw HTML from users (XSS)

React, Vue and Angular escape text in templates. The raw HTML doors bypass that: `dangerouslySetInnerHTML`, `v-html`, `[innerHTML]`, `el.innerHTML`, `insertAdjacentHTML`, `document.write`. Use them only for HTML you wrote, or sanitize first with a library the project has (DOMPurify). In plain DOM code use `textContent`.

The one common safe use is JSON-LD for search engines, written the way the Next.js docs show, with `<` escaped so the data can't close the script tag:

```tsx
<script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
```

Links from users: allow only `http:` and `https:` (a `javascript:` URL runs code when clicked).

## 5. Secrets

- Secrets live in env variables, read only in server code (one module, such as `src/server/env.ts`, whose `getEnv()` checks them on first use; a check at the top of the file fails `next build` where secrets aren't present). The exception is public values meant for the browser: read those where they are used, written out in full as `process.env.NEXT_PUBLIC_X`. Next.js only fills in that exact form (not `process.env[name]` or a destructured `env`), and client code can't import a server-only module.
- Never give a secret a public prefix: `NEXT_PUBLIC_`, `VITE_` and `NUXT_PUBLIC_` values are copied into the browser bundle for anyone to read.
- `.env*` files go in `.gitignore`; commit a `.env.example` with the names and no values.
- Never log, return or write down secrets, tokens or passwords (not in errors, not in AGENTS.md, not in the plan).

## 6. Sessions, cookies, tokens

- Session cookies: `httpOnly: true`, `secure: true` in production, `sameSite: "lax"` (or `"strict"`), `path: "/"`.
- Random tokens and ids: `crypto.randomUUID()` or `crypto.randomBytes()`, never `Math.random()`.
- Compare tokens and signatures with `crypto.timingSafeEqual`, not `===`.
- Passwords: through the auth library, argon2 / bcrypt, or Node's `scrypt` as below; never a fast hash (md5, sha*), never stored or logged in plain text. On a new Node.js version the native `bcrypt` and `argon2` packages may have no prebuilt binary and fail to install without a C++ compiler: then use `bcryptjs` (pure JavaScript) or `scrypt`.

```ts
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// Stored as "salt:hash", with a new random salt for each user.
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

export function checkPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  return expected.length === 64 && timingSafeEqual(scryptSync(password, salt, 64), expected); // never ===
}
```

## 7. CSRF and side effects

- Never change data in a GET request or while rendering a page; use POST (forms, Server Actions) or PUT/PATCH/DELETE.
- Next.js Server Actions only accept POST and compare the `Origin` header with the host. Your own route handlers don't: for a cookie-authenticated route that changes data, check that `Origin` matches your host.
- CORS: never `Access-Control-Allow-Origin: *` on routes that use cookies or return private data; list the allowed origins.

## 8. Abuse and errors

- Rate-limit login, signup, password reset, sending email and expensive endpoints, per IP and per account. A counter in memory resets on restart and isn't shared between servers; use the database or Redis when the app runs on more than one.
- Errors to the client stay generic ("Invalid email or password", "Something went wrong"); details go to the server log. Never send stack traces or raw database errors.

## 9. Files and outgoing requests

- Uploads: limit the size, allow a fixed list of types, store under a name you generate, and never build a file path from user input. If you must, resolve it and check it is still inside the intended folder (`../` path traversal).
- Fetching a URL the user gave (webhooks, link previews): allow only expected hosts, so the server can't be pointed at internal addresses.
- Incoming webhooks (payments, Git hosts): verify the provider's signature before trusting the body, and handle the same event arriving twice (store its id).

## 10. Personal data

- Collect only what the feature needs, and say in your report what personal data a feature stores (emails, names, addresses, IP addresses, anything about health or money).
- Deleting an account deletes or anonymizes that person's data everywhere it lives (related tables, uploads, caches), not just the user row. Ask the user how long other data (logs, backups) is kept.
- Personal data stays out of logs, URLs (they end up in logs and browser history), analytics and cache keys.
- Privacy laws (GDPR in the EU) apply to most apps with users. You can build the mechanics; what to keep and for how long is the user's decision.

## 11. Packages

After an install, the kit reports high and critical vulnerabilities in the packages the app ships; tell the user. Prefer well-known, maintained packages, and check the exact name (look-alike names are a known attack).

## 12. Using an auth library (Better Auth, Auth.js, Clerk)

- Its API changes between minor versions. Use the installed version's docs (README, `node_modules/<pkg>/package.json` `exports`, its `.d.ts`, the web) before you write the setup; don't write it from memory.
- The secret comes from an env variable (`BETTER_AUTH_SECRET`, `AUTH_SECRET`) in `.env.local`, made with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. The site address comes from an env variable too, never a fixed `localhost:3000`: the app runs on other ports in tests and production, and a wrong address makes the library refuse the request (origin check) or set cookies for the wrong host.
- Its database tables: create them with the library's migration API or CLI. If the user wants no extra commands, run the migration in code on first use, and seed demo data in the same place.
- Check the session on the server in each protected page and Server Action with the library's server call. A check in `proxy.ts` only looks for a cookie; it doesn't prove the session is valid.
- Log in and register through the library's own functions; they hash passwords and set `httpOnly` cookies. Never store the password yourself.
- e2e tests: log in through the form with a seeded demo user, and register with a unique email (`user${Date.now()}@example.com`), because the database keeps users from earlier runs.

## Before you finish

For each server entry point you added or changed, say in your report how it authenticates, authorizes and validates. The Stop hook points out secrets, raw HTML, SQL built from strings, silenced errors, and data-changing endpoints with no login or permission check in their file, in the lines you added: fix them, or say why each one is safe (for example, "the check is in `src/server/tasks.ts`").
