---
name: onboard-repo
description: Learn a repository and write its AGENTS.md (commands, layout, conventions). Use in a project without AGENTS.md or QWEN.md.
---

# Onboard a repository

Goal: a short `AGENTS.md` (under 120 lines) that lets you, or a later session, do common tasks in this repo without exploring again. Concrete facts and copied examples beat general advice. AGENTS.md is the project's permanent memory: facts that stay true across tasks. Notes about one task belong in `.local-agent/plan.md` instead.

Delegate the searching in steps 4 and 5 to the `explorer` agent when the repo is large, so your own context stays free for writing.

1. **Manifest and commands.** Read `package.json` (and the lockfile name for the package manager). Note the scripts for dev, build, typecheck, lint, test, e2e and format. Write down as the check command the one the session start message names (the hook that runs when you finish uses it); if it names none, the chain to run (e.g. `npm run lint && npx tsc --noEmit && npm test`).
2. **Run the checks once** and note what passes, what fails and how long it takes (time it; don't estimate). Do not fix failures now; record them under "Known issues". If `npm install` reported vulnerabilities, run `npm audit --omit=dev` too and say whether they are in what the app ships or only in dev tools.
3. **Stack.** From `package.json` and config files: framework and version (Next.js App/Pages Router, Vite, Remix...), styling (Tailwind version, CSS modules), UI library (shadcn/ui, MUI...), data layer (Prisma, Drizzle, fetch/React Query), auth, test runners. Read the framework's config file (`next.config.*`, `vite.config.*`, `nuxt.config.*`, `angular.json`) and note every option that changes how code is written (for example `cacheComponents: true` in Next.js), and how styling is wired (a PostCSS config, or a bundler plugin or loader). For Next.js, check `node_modules/next/dist/docs/` exists and say so.
4. **Layout.** `glob` the top two levels of `src/` (or `app/`, `pages/`, `server/`, `prisma/`). Write one line per folder saying what lives there.
5. **Conventions, from the code itself.** Read 2 or 3 representative files: a page or route, a component, an API handler, a test. Note naming, import aliases (`@/...`), how data is fetched, how errors are handled, how tests are written.
6. **Recipes.** For the 3 to 5 most common tasks in this repo (add a page, an API route, a component, a database field, a test), write the exact steps and point to an existing file to copy. Example:

   ```markdown
   ### Add an API route
   1. Copy `src/app/api/projects/route.ts` (GET/POST handlers, zod validation, `NextResponse.json`).
   2. Add the Prisma query in `src/server/projects.ts`, not in the route.
   3. Test it like `tests/api/projects.test.ts`.
   ```

7. **Write `AGENTS.md`** at the repo root with these sections: Commands, Stack, Layout, Architecture (the boundaries the code follows: where data access, server logic and UI live, and what may import what; when the code has none yet, say so, and the `architecture` skill sets them before the first feature), Conventions, Recipes, Known issues, Lessons (empty for now; later sessions add one line per non-obvious problem they solve). Qwen Code loads `AGENTS.md` by itself. **If an `AGENTS.md` already exists, never replace it:** keep every line, add the missing sections and facts, and change a line only when you checked it is wrong (tell the user which lines and why).
8. **Monorepos: one file per package.** If the repo has workspaces (`workspaces` in `package.json`, `pnpm-workspace.yaml`, `turbo.json`, or folders like `apps/*` and `packages/*` with their own `package.json`), keep the root `AGENTS.md` short (what each package is, shared commands, how packages depend on each other) and give each package its own `AGENTS.md` with its commands, conventions and recipes.
9. Report the files you wrote and anything surprising you found.

Keep it factual: only write commands you ran or saw in `package.json`, paths that exist, timings you measured, and conventions you saw in a file (a folder that does not exist yet has none). Give a reason for a choice only when a file or docs page says it. A Lesson about a library names the version that changed it and comes from the changelog or docs line itself; a summary of a web page can be wrong.
