---
name: errors-and-logging
description: Clear error messages for users and findable causes for developers (error.tsx, route and action errors, logging). Use for code that can fail.
---

# Errors and logging

## 1. Two kinds of errors

- **Expected:** invalid input, a record that doesn't exist, no permission, a service that's down. Handle them where they happen: show the user what went wrong and what to do, and keep what they typed.
- **Unexpected (bugs):** let them throw. An error boundary shows a fallback page, and the server log gets the details.

Never swallow an error: no empty `catch {}`, and no `catch` that logs and then carries on as if it worked. Handle it, or let it throw.

## 2. Next.js (App Router)

The installed docs are `node_modules/next/dist/docs/01-app/01-getting-started/10-error-handling.md` and `03-api-reference/03-file-conventions/error.md`.

- **Server Actions: return expected errors, don't throw them.** Return `{ error: "Title is required" }` or per-field errors, and show them in the form. React's form state (`useActionState`) or your own state carries them back; the `react-nextjs` skill explains how to keep what the user typed.
- **Server Components:** check the result (`res.ok`, a `null` record) and render a message. For a missing record call `notFound()` from `next/navigation`, and add a `not-found.tsx` to show a real 404 page.
- **Route handlers:** answer with the right status and one JSON error shape everywhere:

  ```ts
  return Response.json({ error: { code: "validation", message: "Check the highlighted fields", fields: { title: "Required" } } }, { status: 400 });
  ```

  400 bad input, 401 not logged in, 403 not allowed, 404 not found, 409 conflict (a duplicate, a stale edit), 500 for the rest, with a generic message. Never send the caught exception itself.
- **`error.tsx`** in a route folder catches bugs in that part of the page. It must be a Client Component (`"use client"`) and gets `error` and `retry`. Use `retry()` for "Try again": it re-fetches and re-renders. The older `reset()` only re-renders, so the same error usually comes back.

  ```tsx
  "use client";

  import { useEffect } from "react";

  export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
    useEffect(() => {
      // Report it (the project's error service, or at least the browser console).
      console.error(error);
    }, [error]);

    return (
      <div role="alert">
        <h2>Something went wrong</h2>
        <button type="button" onClick={() => retry()}>Try again</button>
      </div>
    );
  }
  ```

- **`global-error.tsx`** in the root `app/` folder catches errors in the root layout. It replaces the layout, so it renders its own `<html>` and `<body>`.
- In production, an error from a Server Component reaches the browser only as a generic message and an `error.digest`. Log the digest on the server so the two can be matched.
- Error boundaries don't catch errors in event handlers or in async code you start from them. There, use `try`/`catch` and put the message in state.

Nuxt: `throw createError({ statusCode: 404, statusMessage: "Not found" })` and an `error.vue` at the root. Angular: a custom `ErrorHandler` for bugs, and an error state in the component for expected errors.

## 3. Calling other services and APIs

- `fetch` only throws on network failure; check `res.ok` for HTTP errors.
- Give requests a timeout (`AbortSignal.timeout(5000)`), and show a clear message when it hits ("The payment service isn't answering; try again in a minute").
- Show loading, empty and error states for every list or panel that loads data.

## 4. Logging

- Log on the server, one line per event, with what happened and the ids to find it: `console.error("task update failed", { taskId, userId, digest, err })`. Use the project's logger if it has one (pino, winston).
- Levels: `error` needs fixing, `warn` is unexpected but handled, `info` is an important event (a signup, a payment). No `console.log` left from debugging.
- Never log passwords, tokens, API keys, session cookies or full request bodies with personal data. Log ids, not emails or names, where you can.
- **Error reporting in production:** Next.js calls `onRequestError` from `instrumentation.ts` (in the project root, or in `src/`) for server errors. Send them to the error service the project uses. Client errors can be reported from `error.tsx`. Adding a service like Sentry adds a package and an account: ask the user first.

## Before you finish

In your report, say what the user sees for each way the feature can fail (bad input, missing record, service down), and how you checked at least one of them.
