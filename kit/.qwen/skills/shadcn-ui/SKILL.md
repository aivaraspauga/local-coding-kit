---
name: shadcn-ui
description: Add and use shadcn/ui components, including the Base UI flavour where Radix habits break. Use when a project with components.json adds, uses or tests one.
---

# shadcn/ui

## Adding a component
- Components are generated, never hand-written: `echo n | npx shadcn@latest add <name> --yes`.
- `--yes` does not answer "overwrite existing file?" prompts (a component that needs `button` asks about `button.tsx`). Without an answer the add can stop half-way and skip the file you wanted. The `n` keeps your existing files.
- Afterwards, check that the new file exists in `components/ui/`, then format it.
- Read the generated file before using it: it is short, matches the installed version, and shows the props and exports.

## Which flavour?
`components.json` with a `style` starting with `base-` (or `@base-ui/react` in package.json) means the components are built on **Base UI**. Otherwise they are built on Radix. Most examples you know are Radix and break on Base UI:

- No `asChild`. Pass the element to render instead: `<DialogTrigger render={<Button />}>Open</DialogTrigger>`. For a link styled as a button, use `<Link className={buttonVariants()} href="/x">`.
- `Button` defaults to `type="button"`, so it does not submit a form; a submit button needs `type="submit"`.
- `Select`'s `onValueChange` receives `(value: string | null, details)`; keep state as `useState<string | null>(null)`.

## Testing Base UI components in jsdom
- `fireEvent.click` opens a Dialog, switches Tabs and opens a Select.
- A click alone does not choose a Select option. Use the full pointer sequence on the option:
  ```ts
  fireEvent.click(screen.getByRole("combobox", { name: "Fruit" }));
  const option = await screen.findByRole("option", { name: "Pear" });
  fireEvent.pointerDown(option); fireEvent.pointerUp(option); fireEvent.click(option);
  ```
- If clicking a submit button does nothing, check its `type="submit"` and the form's `noValidate` first.
