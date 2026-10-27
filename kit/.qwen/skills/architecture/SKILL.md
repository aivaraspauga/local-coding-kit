---
name: architecture
description: Where code goes and how to split it, recorded in AGENTS.md. Use before the first feature of a new project, for a new area, a file grown too big, or code repeated a third time.
---

# Structure that stays easy to change

## 1. Find the structure, or set one

- Read the "Architecture" section of `AGENTS.md` and look at the folder tree. **If the project has a structure, follow it**, even where you would have chosen differently. Consistency beats your preference.
- **No structure yet** (a fresh scaffold, or a few files in `app/`): before the first real feature, pick one (section 2), write it into `AGENTS.md` under "Architecture" (5 to 10 lines, see section 6), and tell the user in one line. Don't redesign an existing project unless the user asks.
- **The existing code has a pattern that causes bugs** (database calls inside components, secrets in client code, a 1,500-line file): don't spread it. Write your new code the right way, leave the old code alone unless asked, and mention it in your report.

## 2. A default layout

Next.js App Router (the same layers apply elsewhere, with the framework's folder names):

| Folder | What goes there |
| --- | --- |
| `src/app/` | Routes only: `page.tsx`, `layout.tsx`, `route.ts`. Thin: read params, call a server module, render. |
| `src/app/<route>/_components/` | Components only that route uses. A folder starting with `_` is private: Next.js never makes it a route. |
| `src/components/` | UI shared by two or more routes. `src/components/ui/` holds primitives (shadcn/ui puts them there). |
| `src/server/` | Server-only code, one file per domain (`tasks.ts`, `projects.ts`): database access, authorization checks, business rules. Starts with `import "server-only"`. |
| `src/lib/` | Pure helpers safe on client and server: formatting, schemas both the form and the server use. No database, no secrets. |

Elsewhere: Nuxt uses `pages/`, `components/`, `composables/`, `server/api/` (thin) and `server/utils/` (logic). Angular: a folder per feature with its components and a service that owns the data access. Plain web: `src/<feature>/` with the DOM code and a separate `api.ts` for requests.

## 3. Boundaries that keep it modular

- **Dependencies point one way:** routes and components → server modules → database. UI code never imports the database or a server-only module; server modules never import UI.
- **One owner per piece of data.** Only `tasks.ts` touches the tasks table. Another domain that needs tasks calls a function from `tasks.ts` instead of writing its own query.
- **A module is used through what it exports.** Don't import another module's internal helpers; if you need one, export it on purpose.
- **Define each rule once.** A validation schema lives in one place and both the form and the server import it. The same goes for prices, limits, permissions and status names (a constant or a union type, not a string repeated in five files).
- **Read config and server env variables in one module** (`src/server/env.ts`, with a `getEnv()` that checks them on first use) and pass values on, so a missing variable gives one clear error instead of `undefined` deep in a request. Public `NEXT_PUBLIC_` values are the exception: client code reads them directly as `process.env.NEXT_PUBLIC_X`.

## 4. Reuse without over-engineering

- **Search before you write.** Grep for similar names and components; reuse or extend what exists instead of writing a near-copy.
- **Extract on the third copy**, or on the second when the copies must never drift apart (validation, prices, permissions). Two similar blocks that may change independently can stay separate.
- **Shared components take props for what differs.** If a component needs more than about three boolean flags to serve its callers, it is really two components.
- **No layers for their own sake:** no repository, factory or service class wrapping a single implementation, no interfaces with one class, no `utils.ts` grab bag. Name each module after what it does (`dates.ts`, `slug.ts`).

**Outside services** (email, payments, file storage, maps, AI): one server module per service (`src/server/email.ts` exporting `sendWelcomeEmail(user)`), the only place that imports its SDK and reads its keys. The rest of the app calls those functions, so swapping the provider or faking it in tests touches one file. Read the provider's current docs for the installed SDK version before writing the calls; their APIs change often. Use their test mode or sandbox keys while building.

## 5. When a file grows

These are signals, not hard rules:
- A file passes about 300 lines, or a component loads data, holds state and renders several unrelated parts. Split it by job: a server component that loads, a client component for the interactive part, small presentational pieces.
- A function passes about 50 lines or has nested branches you need comments to follow. Extract named steps.
- A props list keeps growing. The component is doing too much.

Split code you are already changing for the task; don't reorganise untouched files without asking.

## 6. Write the decisions down

`AGENTS.md` is how the next session follows your structure. Keep an "Architecture" section like:

```markdown
## Architecture
- Routes in src/app stay thin: they call src/server/<domain>.ts and render.
- src/server/*: server-only ("server-only" import), one file per domain; the only code that touches the database or process.env (except NEXT_PUBLIC_ values, read as `process.env.NEXT_PUBLIC_X` where they are used).
- Shared UI in src/components, route-only UI in src/app/<route>/_components.
- Zod schemas in src/lib/schemas.ts, used by forms and server alike.
- Decided 2026-10-08: SQLite via better-sqlite3 (single server, no extra service).
```

Add a line whenever you make a structural decision, with the reason when there is one.
