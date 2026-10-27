---
name: accessibility
description: Keyboard, screen reader and contrast rules for UI, with an axe check in Playwright. Use when building or reviewing pages, forms, dialogs, menus or images.
---

# Accessible by default

Cheap while building, expensive later. Lint catches few mistakes and axe (section 7) many more; neither replaces trying the page with the keyboard.

## 1. Use the real element

- An action is a `<button type="button">`; going somewhere is a link (`<Link href>` / `<a href>`). A clickable `<div>` or `<span>` can't be reached with Tab or pressed with Enter.
- Lists are `<ul>`/`<ol>`, tables of data are `<table>` with `<th>`, navigation is `<nav>`, the main content is one `<main>`.
- Use the project's UI components (shadcn/ui, Base UI, Radix): their dialogs, menus, selects and tabs already handle the keyboard and ARIA. Don't rebuild them from `div`s.

## 2. Names for everything

- Every input has a visible `<label htmlFor>` (a placeholder is not a label). Groups of radios or checkboxes go in a `<fieldset>` with a `<legend>`.
- A button with only an icon needs a name: `<button aria-label="Delete task">` with the icon `aria-hidden`.
- `aria-label` only names an element that has a role. On a plain `<div>` or `<span>` axe reports `aria-prohibited-attr`. A loading placeholder: `<div role="status" aria-label="Loading orders">`.
- Images: `alt` describes what matters ("Chart: sales doubled in March"); decorative images get `alt=""`. `next/image` requires `alt`.
- Links say where they go: "Read the pricing guide", not "Click here".

## 3. Structure

- Each page has a unique, descriptive title (`metadata.title`) and one `<h1>`. Next.js reads the title, then the `<h1>`, to announce page changes to screen readers.
- Headings go in order (`h1` → `h2` → `h3`) and follow the content, not the font size you want; style with classes.
- `<html lang="en">` (or the page's language) is set in the root layout.

## 4. Keyboard and focus

- Everything that works with a mouse works with Tab, Shift+Tab, Enter, Space and Escape, in a sensible order. Don't use a positive `tabIndex`.
- Focus must stay visible. Never remove the outline without a replacement: with Tailwind, `focus-visible:ring-2 focus-visible:ring-ring` (or the project's ring token).
- A dialog moves focus inside when it opens, keeps Tab inside, closes on Escape, and returns focus to the button that opened it. The UI library's dialog does this; a hand-made one usually doesn't.
- After an action that removes the focused element (deleting a row), move focus somewhere sensible (the next row, the list heading).

## 5. Errors and changing content

- Show errors as text next to the field, connected to it: `aria-invalid={!!error}` and `aria-describedby="title-error"` on the input, `id="title-error"` on the message. Don't rely on red alone.
- Announce results that appear without a page change ("Saved", "3 results") with `role="status"` (polite) or, for errors, `role="alert"`.
- Keep what the user typed after an error.

## 6. Seeing and moving

- Text contrast at least 4.5:1 (3:1 for large text and for icons and input borders). Use the project's theme tokens, which are usually chosen for this; grey-on-grey decorations are the common failure.
- Never show information by colour alone (a red border needs an error message, a status dot needs a word).
- Pages must work zoomed to 200% and at 320 px wide without sideways scrolling.
- Respect reduced motion for anything that animates more than a fade: `motion-safe:` / `motion-reduce:` in Tailwind, or `@media (prefers-reduced-motion: reduce)`.
- Touch targets at least 24×24 px; 44×44 is better for main actions.

## 7. Check it automatically

With Playwright and `@axe-core/playwright` (the `testing-setup` skill installs both), add an axe check to the browser test of each page you build:

```ts
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// Dark mode has its own colours: a button that passes contrast in light mode can fail in dark mode.
for (const colorScheme of ["light", "dark"] as const) {
  test(`task page has no accessibility violations (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto("/tasks");
    // Make sure the right page loaded first: a 404 page passes axe too.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tasks");
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
  });
}
```

Check the states too: open the dialog, show the validation errors, then run axe again. Axe finds missing names, labels, alt text, contrast and ARIA mistakes; it can't judge keyboard order, focus handling or whether alt text makes sense, so try those by hand (or with Playwright's `page.keyboard`).

## Before you finish

Say in your report how the feature works with the keyboard (what Tab reaches, what Escape does) and whether the axe check passes.
