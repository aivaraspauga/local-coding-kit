---
name: explore-codebase
description: Find where and how something is done without reading everything. Use before changing code you have not seen.
---

# Explore a codebase efficiently

Aim for an answer in about 10 look-ups. Each step narrows the search.

1. **Start from names, not folders.** `grep_search` for the most specific word you have: a route (`/api/orders`), a UI label (`"Add to cart"`), an error message, a function or table name. UI text and error strings lead straight to the right file.
2. **Find the entry point** for the feature: the page (`app/**/page.tsx`, `pages/**`), the API handler (`app/api/**/route.ts`, `pages/api/**`, `server/**`), or the component that renders it.
3. **Follow the data one hop at a time:** UI → fetch or server action → API handler → service/query → database schema (`prisma/schema.prisma`, `drizzle/schema.ts`, `db/schema.*`). Read only the functions on that path.
4. **Read the tests** for the area (`glob` `**/*.test.*`, `**/*.spec.*`); they show intended behaviour and edge cases.
5. **Find one similar, finished feature** and use it as the template for your change.
6. **Stop and summarise** in 3 to 5 lines: the files involved, how data flows, and the template you will copy. Then act.

Avoid: listing whole directories recursively, reading lockfiles or build output (`.next/`, `dist/`), and reading compiled code in `node_modules`. For library questions, use the package's README, docs folder or `.d.ts` types.
