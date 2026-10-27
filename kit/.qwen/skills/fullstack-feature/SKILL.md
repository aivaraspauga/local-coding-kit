---
name: fullstack-feature
description: A feature across data, server and UI in a React/Next.js app, with tests. Use for changes that touch data and screens together.
---

# Build a full-stack feature

Work from the data outward, one layer at a time, and keep the project working after every layer.

1. **Find the template:** a similar finished feature (a model with its API and page); copy its structure at every layer. If there is none, set one with the `architecture` skill. Use `security` for the server layer and `performance` when it lists or searches records.
2. **Plan in one short list:** the data (fields and types), the server functions or endpoints, the UI pieces, the tests. Say which existing files you will copy.
3. **Data layer.**
   - Prisma: edit `prisma/schema.prisma`, then `npx prisma migrate dev --name <change>` (creates the migration and client). Drizzle: edit the schema file, then the project's `db:generate`/`db:push` script.
   - Never reset or drop a database the user has data in; ask first.
   - Changes must work with the data already there: a new required column needs a default (or a migration that fills it). Renaming or removing a column: add the new one, copy the data, switch the code, and drop the old one in a later change, so a running version never breaks. Suggest a backup before anything that rewrites data.
   - Seed data for development goes in a seed script (`prisma/seed.ts`, `scripts/seed.ts`), never mixed into migrations. If the user wants no extra commands: make tables in code with `CREATE TABLE IF NOT EXISTS`, and seed only when the table is empty, so a restart doesn't add the demo rows again.
   - No database yet: SQLite through Node's built-in `node:sqlite` (`DatabaseSync`) needs no install (checked on Node 26.10). `better-sqlite3` needs a prebuilt binary for the installed Node; if its install fails (node-gyp errors), use `node:sqlite`.
   - Data in a JSON file: write one change at a time (chain each write on one promise) and write a temporary file, then rename it. Otherwise two quick submits lose one, and a crash leaves half a file.
   - Money: store whole cents (`4500`), never floats (`0.1 + 0.2` is `0.30000000000000004`); format on display with `Intl.NumberFormat(locale, { style: "currency", currency: "EUR" })`.
   - Dates without a time (`2026-11-14`): format with `timeZone: "UTC"`. Without it, a browser west of UTC shows the day before.
   - Keep queries in the project's server/data module, not inside components.
4. **Server layer.** Check who is calling and that they may touch this record, in every route handler and Server Action. Validate every input at the boundary (zod or whatever the project uses), and return clear errors (400 with a message, 404 when missing). Zod 4: messages go in `{ error: "..." }` (no `required_error`/`invalid_type_error`), errors in `err.issues` (not `err.errors`), `z.email()` and `z.flattenError(err)` replace `z.string().email()` and `err.flatten()`. Next.js: route handlers in `app/api/<name>/route.ts` export `GET`/`POST`/...; Server Actions live in a `"use server"` file. Follow what the project already uses.
5. **UI layer.** Pages stay Server Components and load data on the server where the project does so; interactive parts (forms, buttons with state) go in a `"use client"` component. Show loading, empty and error states. Keep what the user typed when validation fails.
6. **Tests.** At least: the server logic with valid and invalid input, and the UI's main path (Testing Library or Playwright, matching the project).
7. **Verify end to end** with the `verify-web-app` skill: create, read, update or delete through the real UI and check the data persisted (reload the page).
8. Run the project's checks and report each layer you changed.

Common mistakes: forgetting to regenerate the DB client after a schema change; putting secrets or DB calls in client components; not handling the empty list; trusting client-side validation alone.
