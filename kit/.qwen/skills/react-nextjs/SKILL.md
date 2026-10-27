---
name: react-nextjs
description: How to write React and Next.js code that works first time (components, forms, data, routes, tests). Use for any React or Next.js code.
---

# React and Next.js essentials

For an API you're unsure of, read its guide in `node_modules/next/dist/docs/` (it matches the installed version).

## Server and Client Components (App Router)
- Components are Server Components by default. Add `"use client"` only to components that use state, effects, event handlers or browser APIs.
- Never put `"use client"` on `page.tsx` or `layout.tsx`. A client page cannot export `metadata`, and the page answers HTTP 500. Put the interactive part in its own client component and import it.
- Server Components cannot pass functions as props to Client Components (except Server Actions). Pass data instead.
- A Client Component may only `import type` from server code (files using the database, `node:fs`, `server-only`). A value import (a constant, a schema, a helper) pulls that code into the browser bundle and the dev server crashes on the page (`node:fs` "does not support external modules"). Put values both sides need, like a list of allowed options, in `src/lib/`.
- Client Components also render on the server, where `window` and `localStorage` do not exist. Read browser values with `useSyncExternalStore`, which takes a separate server value and so avoids hydration mismatches:
  ```tsx
  const subscribe = (onChange: () => void) => {
    window.addEventListener("storage", onChange);
    return () => window.removeEventListener("storage", onChange);
  };
  const name = useSyncExternalStore(subscribe, () => localStorage.getItem("name") ?? "", () => "");
  ```
- The lint config (React Compiler rules in `eslint-config-next` 16) makes these errors: calling `setState` directly inside `useEffect` ("Calling setState synchronously within an effect"), and impure calls such as `Date.now()` or `Math.random()` during render ("Cannot call impure function during render"). Instead: derive values while rendering, use `useSyncExternalStore` for browser state, set state in event handlers, or compute once with `useState(() => Date.now())`.

## Next.js 15 and 16 changes older code gets wrong
- `params` and `searchParams` are Promises in pages, layouts, route handlers and `generateMetadata`. TypeScript does not catch the old synchronous form (Next's route types accept it), so `params.id` silently renders empty and only the dev server log says "params is a Promise". Always: `export default async function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; ... }`. In a route handler: `(req: Request, ctx: { params: Promise<{ id: string }> })`.
- `cookies()`, `headers()` and `draftMode()` are async: `const store = await cookies()`. Next 16 removed the synchronous form completely.
- Next 16: `middleware.ts` is now `proxy.ts`, exporting `function proxy(request)`. `next lint` is gone; use the project's `lint` script (ESLint CLI).
- React 19: `useFormState` is now `useActionState` (from `react`).

## Pages and state
- Every page gets a unique `title` and `description` (`export const metadata`, or `generateMetadata` with the same `params` Promise) in a server file.
- Saved data lives on the server; after a change refresh it (`updateTag`/`revalidatePath` in a Server Action, or `router.refresh()`) instead of copying it into client state. Filters, search, sort and tabs go in the URL. No new state library unless the project has one.

## Data
- Load data in Server Components or route handlers, not with `useEffect` + fetch, unless the project already does that or the data is user-interactive.
- Route handlers: `app/api/<name>/route.ts` exporting `GET`, `POST`, ... that return `Response.json(...)` (or `NextResponse.json`). Validate input and return 400 on bad input.
- Server Actions: functions in a `"use server"` file, called from forms or client components. Re-validate input on the server.
- Data in a file (JSON, SQLite) at a path made from `process.cwd()`: `next build` warns "Dynamic filesystem access causes tracing of the whole project". Mark the path: `path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "orders.json")`. Read the path from an env variable first (`process.env.ORDERS_FILE ?? ...`), so tests can use their own file (Playwright: `webServer.env`) and never touch the real data.

## Forms
- For client-side validation with error messages, use `onSubmit` with `event.preventDefault()` and state; it keeps what the user typed.
- `<form action={...}>` / `useActionState` reset uncontrolled fields after each submit: a validation error then wipes the form. Use controlled inputs if you use them, each with its own state: `const [name, setName] = useState("")` and `<input value={name} onChange={(e) => setName(e.target.value)} />`. Never `value={state.name}` with an empty `onChange={() => {}}`: the field becomes read-only and typing does nothing.
- When you show your own error messages, put `noValidate` on the `<form>`. Otherwise `required` or `type="email"` makes the browser (and jsdom) block the submit, `onSubmit` never runs, and your errors never appear.
- Give the submit button `type="submit"` explicitly; some UI libraries' buttons (shadcn/ui on Base UI) default to `type="button"` and do not submit.
- Each field: a `<label htmlFor>`, `aria-invalid` when wrong, and its error in a `<p role="alert">` next to it.

## Styling
- Use the project's Tailwind classes, theme tokens (`bg-background`, `text-muted-foreground`) and UI components; no hard-coded colours. shadcn/ui components: the `shadcn-ui` skill.

## Tests
- Testing Library: query by role and accessible name (`getByRole("button", { name: "Save" })`). For async UI use `await screen.findBy...` or `waitFor`.
- Testing Library and Playwright name their queries differently. In Vitest: `screen.getByLabelText`, `getByText`, `getByPlaceholderText`. In Playwright: `page.getByLabel`, `getByText`, `getByPlaceholder`. `screen.getByLabel` doesn't exist, and the type check fails on it.
- A page check without Playwright: start the dev server in the background, then `curl -s localhost:3000/x | grep -c "expected text"`, with text that is one piece in the JSX (React puts `<!-- -->` between `{values}`). One test file: `npx vitest run tests/unit/x.test.tsx`.
- Async Server Components cannot be rendered by Vitest; test them with Playwright, and test their logic as plain functions.
- Playwright: after hydration Next.js adds a hidden `<next-route-announcer>` with `role="alert"`, so `page.getByRole("alert")` matches two elements and fails (it may pass once before hydration). `{ name: "..." }` finds nothing: an alert's name doesn't come from its text. Use `page.getByRole("alert").filter({ hasText: "Title is required" })`.
- Playwright's `getByLabel("Workshop")` matches every label, `aria-label` and `aria-labelledby` text that contains the word, ignoring case: a `<section aria-labelledby>` titled "Upcoming workshops" matches too, and the test fails with "strict mode violation". Write form fields as `page.getByLabel("Workshop", { exact: true })`.
- A component that uses `useRouter`, `usePathname` or `useSearchParams` fails in Vitest with "invariant expected app router to be mounted". Mock the module at the top of the test file:
  ```ts
  const push = vi.fn();
  vi.mock("next/navigation", () => ({
    useRouter: () => ({ push, replace: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
    usePathname: () => "/",
    useSearchParams: () => new URLSearchParams(),
  }));
  ```
- "document is not defined" in a component test means the test runs in Node. Check `environment` in the Vitest config; projects that default to `node` opt a file into the browser with `// @vitest-environment jsdom` as its first line.
- Test a form like a user: send it empty (errors appear), with one wrong field (an error, other fields keep their values), then fixed (success). If the submit does nothing in a test, check `noValidate` and `type="submit"` first. Use `fireEvent.change(getByLabelText(...), { target: { value } })` and `fireEvent.click(getByRole("button", { name: "Send" }))`, then `await findBy...`.
- Playwright: fill and pick like a user (`fill()`, `selectOption()`, `check()`, `click()`). Never set `.value` with `evaluate()`: React does not see it, and the test hides a form that people cannot use. If `fill()` leaves a field empty, the bug is in your component (usually `value` without a working `onChange`), not in Playwright or Next.js.
- Playwright: `selectOption()` works only on a native `<select>`. A UI-library select (shadcn/ui, Base UI, Radix) is a button and a list: click the trigger, then `page.getByRole("option", { name: "Shipped" })`.
- Playwright: wait for the page to be ready (`await expect(rows).toHaveCount(10)`) before you click a client-side control. A click before hydration does nothing.
