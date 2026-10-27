---
name: vanilla-web
description: Plain HTML, CSS and JavaScript or TypeScript without a framework, often with Vite. Use for sites that don't use React, Vue or Angular.
---

# Plain HTML, CSS and JavaScript

No framework means no one else keeps the page in sync, escapes text or cleans up listeners. These habits do it.

## Project setup
- Look at what is there: a `package.json` with Vite (`vite.config.*`, `npm run dev`), or plain files opened through a static server. Keep it that way; don't add a framework or a bundler nobody asked for.
- New project with a build step: `npm create vite@latest my-app -- --template vanilla-ts` (or `vanilla` for JavaScript).
- Use ES modules: `<script type="module" src="/src/main.ts"></script>`. Modules are deferred and strict, and they keep variables out of the global scope. Opening the HTML file straight from disk (`file://`) blocks modules: always use a dev server.
- Vite 8 (check `node_modules/vite/package.json`) renamed `build.rollupOptions` to `build.rolldownOptions` (the old name still works but is deprecated) and the `esbuild` option to `oxc`.
- TypeScript 6 and newer (check `node_modules/typescript/package.json`): `strict` is on by default, and `types` defaults to `[]`, so `@types` packages are no longer picked up on their own. List them: `"types": ["node"]`, or `["vite/client"]` for `import.meta.env`.
- `baseUrl` in `tsconfig.json`: an error in TypeScript 6 (unless `"ignoreDeprecations": "6.0"` is set) and removed in 7. Use `paths` on its own: `"paths": { "@/*": ["./src/*"] }`.
- More on TypeScript itself (tsconfig settings, strict habits, older versions): the `typescript` skill.

## The DOM
- Find elements once and check they exist:
  ```ts
  const list = document.querySelector<HTMLUListElement>("#todo-list");
  if (!list) throw new Error("#todo-list is missing from index.html");
  ```
- Put user text in with `textContent`, never `innerHTML` (that is an XSS hole). Build elements with `document.createElement`, or clone a `<template>` from the HTML and fill in its text.
- Keep state in plain variables and write one `render()` that rebuilds the part of the page from that state. Change state, then call `render()`. Spreading DOM edits across event handlers is where pages drift out of sync.
- Lists: one listener on the container, not one per item (event delegation):
  ```ts
  list.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-id]");
    if (button) remove(Number(button.dataset.id));
  });
  ```
- Use real elements: `<button type="button">` for actions, `<a href>` for navigation. A clickable `<div>` can't be reached by keyboard.
- Show and hide with the `hidden` attribute or a class, not inline styles scattered through the code.

## Forms
- Read values with `new FormData(form)`, or each element's `.value`.
- `<form novalidate>` when you show your own messages; otherwise `required` or `type="email"` make the browser block the submit. You can still ask the browser's checks with `input.checkValidity()` and `input.validationMessage`.
- `event.preventDefault()` in the `submit` handler, or the page reloads.
- Keep what the user typed after an error; clear the form only after success.
- Every input needs a `<label for>`. Put errors in an element with `role="alert"` and set `aria-invalid="true"` on the input.

```ts
const form = document.querySelector<HTMLFormElement>("#contact")!;
const nameError = document.querySelector<HTMLElement>("#name-error")!;

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = String(new FormData(form).get("name") ?? "").trim();
  const nameInput = form.elements.namedItem("name") as HTMLInputElement;
  nameError.textContent = name ? "" : "Name is required";
  nameInput.setAttribute("aria-invalid", String(!name));
  if (!name) return;
  form.replaceWith(Object.assign(document.createElement("p"), { textContent: "Thanks, we'll be in touch!" }));
});
```

## Fetch and async
- `fetch` doesn't throw on 404 or 500. Check `response.ok` before reading the body:
  ```ts
  async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return (await response.json()) as T;
  }
  ```
- Show loading and error states in the page, not only in the console.
- Cancel requests the user no longer needs (typing in a search box) with an `AbortController`; abort the old one before starting the next.
- Disable the submit button while a request is running, so a double click doesn't send twice.

## Storage
- `localStorage` holds strings only, can be full or blocked, and can hold old data in another shape. Read it carefully:
  ```ts
  function load<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  }
  ```
- Never store secrets or tokens there that a script on the page could steal.

## CSS
- Use the project's existing approach (one stylesheet, CSS modules through Vite, a utility framework). Put colours and spacing in custom properties (`--color-text`) so a dark theme is one block of overrides.
- Layout with flexbox and grid; avoid fixed pixel widths for page sections. Check the page at phone width.

## Tests
- Logic (formatting, validation, state changes) goes in plain functions in their own modules. Test those with Vitest; no DOM needed.
- DOM code: Vitest with `environment: "jsdom"` (or `happy-dom`), build the HTML in the test, run your setup function, then use the page like a user (`form.requestSubmit()`, `button.click()`) and check the text.
- Whole pages: Playwright against the dev server.
- Vitest 5 (check the installed version): mocks are cleared before every test, `vi.mock()` must sit at the top level of the file, and `expect(...).resolves` / `.rejects` must be awaited.
