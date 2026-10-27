---
name: debug
description: Find and fix the cause of a bug, failing test, type, build or runtime error. Use whenever something does not behave as expected.
---

# Debug systematically

1. **Reproduce it.** Get the exact failing command, test, request or page, and the exact error text. If you cannot reproduce it, say so and ask for the steps; do not guess-fix.
2. **Read the first error, completely.** The first error is usually the cause; later ones are often consequences. Note the file and line.
3. **Locate.** Read the code at that line and one level around it (the caller, the data passed in).
4. **Hypothesis.** Write one sentence: "X happens because Y." Name the evidence that would prove it.
5. **Test the hypothesis cheaply:** a focused test (`npx vitest run path -t "name"`), a `console.log` you will remove, or a `curl` to the endpoint. If the evidence disagrees, form a new hypothesis; do not stack fixes.
6. **Fix the cause, not the symptom.** Silencing is not a fix: `@ts-ignore`, `as any`, `eslint-disable`, an empty `catch`, a skipped or loosened test, a weaker config.
7. **Prove it.** Re-run the reproduction, then the project's checks. If the bug could come back, add a test for it.

## Common causes in React / Next.js

- **HTTP 500 on a page:** a Server Component crashed, or a page marked `"use client"` exports `metadata` (move the interactive part into a client component). Read the dev server output; it names the file and line.
- **Hydration mismatch:** something renders differently on server and client: `Date.now()`, `Math.random()`, `window`/`localStorage` during render. Read browser values with `useSyncExternalStore` (see `react-nextjs`); setting state in `useEffect` is a lint error.
- **"Module not found" / bad import:** check the import alias in `tsconfig.json` `paths` and the file's real name and case.
- **Works locally, fails in tests:** async UI needs `await screen.findBy...` / `waitFor`; timers need fake timers; fetch needs a mock.
- **Form loses what the user typed:** `<form action>` resets uncontrolled fields; use `onSubmit` + `preventDefault`, or controlled inputs.
- **API returns HTML instead of JSON:** wrong route path (`app/api/x/route.ts`), or the handler threw; check the server log.
- **Same error after "fixing":** you may be running stale code. Restart the dev server or rerun the build.

If the same fix fails twice, re-think your hypothesis. After a third failure, tell the user what you tried, what you saw, and your best current hypothesis.
