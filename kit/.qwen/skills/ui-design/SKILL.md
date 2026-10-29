---
name: ui-design
description: Spacing, type, responsive layout, states, dark mode tokens, Tailwind v4 and translatable text. Use when building or restyling UI.
---

# UI that looks finished

Match the project first: its components (`src/components/ui`), theme tokens and spacing. With no design yet, keep it plain and consistent. If the project has its own design skill (AGENTS.md names it), that decides the look; the rules below still apply underneath it, together with the `accessibility` skill.

## 1. Spacing and layout

- Use the spacing scale, not one-off numbers: Tailwind steps are multiples of `--spacing` (0.25rem), so `p-4` is 1rem. Pick a few and reuse them: `gap-2` inside controls, `gap-4` between items, `gap-8`/`py-12` between sections.
- Lay out with flex and grid plus `gap`, not margins on every child.
- Limit line length for reading: `max-w-prose` for text, a `max-w-5xl mx-auto px-4` (or the project's) container for pages.
- Align things to the same edges; a page with three different left margins looks broken.

## 2. Typography

- A small set of sizes: one page title (`text-2xl` or `text-3xl font-semibold`), section headings (`text-lg font-semibold`), body (`text-base`), secondary text (`text-sm text-muted-foreground` or the project's muted token).
- Hierarchy comes from size, weight and colour together, used the same way on every page.
- Numbers in tables and prices: `tabular-nums` so columns line up.

## 3. Responsive, mobile first

- Write the phone layout first, then add breakpoints: `grid gap-4 sm:grid-cols-2 lg:grid-cols-3`. Tailwind 4's breakpoints: `sm` 40rem (640px), `md` 48rem, `lg` 64rem, `xl` 80rem.
- Nothing scrolls sideways at 320px: long words and URLs get `wrap-break-word` (Tailwind 4's name for `break-words`), wide tables sit in `overflow-x-auto`. Don't hide important actions behind hover (phones have none).
- Check it: a Playwright project with a phone device (`devices["Pixel 7"]`) or the browser's device mode at 375px.

## 4. States make it feel real

Every interactive element has hover, `focus-visible`, active and `disabled` styles (the UI library's components already do). Every view that loads data has:
- **Loading:** a skeleton or spinner in the same space, so the page doesn't jump.
- **Empty:** a short message and the next action ("No tasks yet. Add your first task").
- **Error:** what went wrong and a way to retry (see the `errors-and-logging` skill).
- **Pending actions:** disable the button and show progress while saving, so it isn't pressed twice.

## 5. Colour, theme and dark mode

- Use the theme tokens (`bg-background`, `text-foreground`, `bg-primary`, `text-muted-foreground`, `border-border`, or whatever the project defines), never raw hex colours or `bg-white`/`text-black` in components. Then dark mode and theme changes work everywhere.
- One accent colour for primary actions; red only for destructive actions and errors.
- Tailwind 4: by default `dark:` follows the system setting (`prefers-color-scheme`). For a theme switch with a class, add to the main CSS file:

  ```css
  @custom-variant dark (&:where(.dark, .dark *));
  ```

  With a class, nothing follows the system any more, so do all three:
  - Colours that a `@media (prefers-color-scheme: dark)` block sets (create-next-app writes one for `--background` and `--foreground`) move to `.dark { ... }`. Otherwise the toggle changes the `dark:` classes but not the page background.
  - With no saved choice, set the class from `matchMedia("(prefers-color-scheme: dark)")`. Do it in a small inline script in `<head>`, before the page paints, so it does not flash light first.
  - Put `suppressHydrationWarning` on `<html>`: the class differs between the server's HTML and the browser.
- Charts: a chart in a responsive wrapper (Recharts `ResponsiveContainer`, Chart.js with `responsive`) takes its parent's size. Give the parent a height (`h-80`), or the chart is 0 px tall and invisible. Chart components run in the browser (`"use client"`).

## 6. Tailwind CSS v4 specifics

- Configuration lives in CSS, not `tailwind.config.js`: `@import "tailwindcss";` then tokens in `@theme { --color-brand: oklch(0.6 0.2 250); }`, which creates `bg-brand`, `text-brand` and so on. `@theme inline` points tokens at other CSS variables (how shadcn/ui and create-next-app set up themes).
- Use the class names Tailwind can see in full: build them from a map (`{ high: "text-red-600", low: "text-green-600" }[priority]`), never by gluing strings (`` `text-${color}-600` ``), which produces no CSS.
- Check the installed version (`node_modules/tailwindcss/package.json`) and the project's AGENTS.md lessons before using a utility you are unsure of.

## 7. Text and translations

- Format numbers, dates and money for the user's language with `Intl` instead of by hand: `new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(9.5)`, `new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }).format(date)`.
- If the app is (or will be) in several languages, keep UI text out of components: one dictionary per language, looked up by key. Next.js App Router (`node_modules/next/dist/docs/01-app/02-guides/internationalization.md`): pages live under `app/[lang]/`, `proxy.ts` sends visitors to their language, and a `server-only` `getDictionary(lang)` loads the right file. A translation library the project already uses (next-intl, i18next) wins over this.
- Leave room for longer words (a German or Finnish label can be much longer than the English one); don't fix widths around text.

## Before you finish

Look at the page at phone and desktop width (a screenshot from Playwright is enough), with real-looking data, an empty list and an error, and in dark mode if the project has one.
