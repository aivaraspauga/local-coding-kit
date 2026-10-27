---
name: performance
description: Indexes, pagination, N+1 queries, caching with use cache, less client JavaScript. Use for lists, search, feeds, queries, caching, or anything slow.
---

# Fast now, fast at scale

## 1. Measure, don't guess

Before optimizing, get a number: the time in the server log, a query's time, or the browser's Network tab (how long a request takes, how much JavaScript a page loads). Change one thing, measure again, and put both numbers in your report. If you didn't measure, say so. Code that isn't slow doesn't need optimizing; clear code comes first.

## 2. Database

- **Every list is bounded.** `LIMIT` plus pagination; never load a whole table and filter in JavaScript. Offset pages are fine for small tables; for long or busy lists use a cursor:
  ```sql
  SELECT id, title FROM tasks WHERE project_id = ? AND id < ? ORDER BY id DESC LIMIT 20
  ```
- **Index what you filter, join and sort on**: foreign keys (`project_id`), sort columns (`created_at`), lookups (`email`, unique). Add the index in the same migration as the query that needs it:
  ```sql
  CREATE INDEX IF NOT EXISTS tasks_project_id ON tasks(project_id);
  ```
- **No N+1 queries.** A query inside a loop (or `await` inside `.map`) makes one database round trip per row. Load in one query with a JOIN, `WHERE id IN (...)`, or the ORM's include, then group in memory.
- **Select the columns you show**, not `SELECT *` on wide tables.
- **Writes that belong together go in one transaction**: they stay consistent, and it's faster too.
- **Independent awaits run together:** `const [user, tasks] = await Promise.all([getUser(id), listTasks(id)]);`

## 3. Caching

Next.js with Cache Components (`cacheComponents: true` in `next.config.*`; check the project's docs in `node_modules/next/dist/docs/` for the installed version):
- Data is fetched fresh on every request by default. Cache an async function or component with `"use cache"`, give it a lifetime with `cacheLife("hours")` and a tag with `cacheTag("tasks")`.
- After a write, invalidate the tag: `updateTag("tasks")` inside a Server Action (the user sees their own change at once; it works only in Server Actions). Elsewhere (route handlers, webhooks): `revalidateTag("tasks", "max")`, or `revalidateTag("tasks", { expire: 0 })` when the old data must be gone at once. The one-argument `revalidateTag("tasks")` is deprecated and fails the type check.
- Never call `cookies()` or `headers()` inside a cached scope. Read them outside and pass the values in as arguments; the arguments become part of the cache key.
- **Per-user data:** the cached function takes the user id as an argument and stays **unexported**; the exported function finds the current user itself and calls it. Otherwise any caller could pass another user's id. Cache keys and tags are stored as plain text: never put tokens, passwords or emails in arguments or tags. If you can't restructure it that way, `"use cache: private"` exists (see its docs).
- Uncached data belongs inside `<Suspense>` (or under a `loading.tsx`), so the rest of the page shows first. Next.js reports uncached data outside it in the dev overlay, and it can fail the build.

Without Cache Components (older Next.js, or the option off), read `node_modules/next/dist/docs/01-app/02-guides/caching-without-cache-components.md`. Other stacks: send cache headers on public GET responses, and don't build your own cache layer before a measurement says you need one.

## 4. Less work in the browser

- Keep `"use client"` on the interactive leaves, not on big parents: everything below a client boundary ships as JavaScript.
- Load heavy, not-needed-at-first parts (charts, editors, maps) lazily: `next/dynamic` or `import()` on demand.
- Images: `next/image` with `width` and `height` (no layout jump); plain HTML: `loading="lazy"` and set sizes.
- Don't render thousands of rows; paginate, or virtualize a long scrolling list.
- Debounce search-as-you-type (about 300 ms) and ignore answers to outdated requests (`AbortController`).

## 5. Server and load

- **Slow work out of the request:** sending email, resizing images, building reports. Use a background job or queue the project has; ask the user before adding one. On serverless hosting, work started after the response may never finish.
- **Timeouts on outgoing requests:** `fetch(url, { signal: AbortSignal.timeout(5000) })`, and a clear error when they hit.
- **More than one server instance:** anything kept in memory (sessions, rate-limit counters, caches, uploaded files on local disk) is per instance and lost on restart. Use the database, Redis or object storage for anything that must be shared.

## Before you finish

Say in your report which lists are paginated, which indexes you added, and what you cache with which tag and lifetime. If you measured something, give the numbers.
