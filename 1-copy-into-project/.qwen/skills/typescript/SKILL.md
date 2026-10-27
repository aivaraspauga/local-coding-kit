---
name: typescript
description: Types that pass the project's tsconfig and compiler version. Use for new types or generics, a tsconfig change, or type errors you can't explain.
---

# TypeScript essentials

Read the project's `tsconfig.json` (and any file it `extends`): its settings decide what you may write. As of late 2026 TypeScript 7 is the newest (a native rewrite), but `create-vue`, `ng new` and `create-vite` still start on TypeScript 6.

## First: which TypeScript is this?

| Feature | From version | Before that, use |
| --- | --- | --- |
| `satisfies` | 4.9 | A type annotation (`const routes: Record<string, Route> = ...`), which loses the literal types |
| `const` type parameters (`<const T>`) | 5.0 | `as const` where the value is written |
| `NoInfer<T>` | 5.4 | Accept the wider inference, or pass the type argument explicitly |
| `.filter((x) => x !== undefined)` narrowing the result | 5.5 | An explicit predicate: `.filter((x): x is number => x !== undefined)` |
| `strict` on by default, `types` defaulting to `[]` | 6.0 | `strict` was off unless set; every `@types` package loaded on its own |
| `baseUrl` | an error in 6.0 (unless `"ignoreDeprecations": "6.0"`), removed in 7.0 | Use `paths` on its own |

**TypeScript 7 and tools:** tools that use the compiler's JavaScript API may not support 7 yet. In October 2026, typescript-eslint accepted TypeScript below 6.1. Before moving a project to 7, check its tools (`npm view typescript-eslint peerDependencies`). Never upgrade TypeScript as a side effect of another task.

## Settings that change what you can write
- **`strict`** (the default from 6.0): no implicit `any`, `null` and `undefined` must be handled, and a caught error is `unknown`.
- **`noUncheckedIndexedAccess`**: `items[0]` and `record[key]` are `T | undefined`. Check before use (`if (!first) return;`, `?.`); don't silence it with `!`.
- **`verbatimModuleSyntax`** (on in `create-vite` projects and many others): import types with `import type { User } from "./user"` or `import { type User, save } from "./user"`. A plain import of a type is an error (TS1484).
- **`erasableSyntaxOnly`**: no `enum`, `namespace` or constructor parameter properties (`constructor(private name: string)`), because they generate code. An error otherwise (TS1294). Use a constant object instead of an enum:
  ```ts
  export const Status = { Open: "open", Done: "done" } as const;
  export type Status = (typeof Status)[keyof typeof Status]; // "open" | "done"
  ```
- **`types`**: from 6.0, `@types` packages load only when listed, e.g. `"types": ["node"]`, `["vite/client"]`, `["vitest/globals"]`. In a 6+ project, "Cannot find name 'process'" usually means a missing `types` entry, not a missing package.
- **`allowImportingTsExtensions`** (needs `noEmit`): allows `import { x } from "./x.ts"`. Without it, a `.ts` ending in an import is an error (TS5097).

## Habits that pass strict checks
- Data from outside (`JSON.parse`, `fetch`, `localStorage`, `postMessage`) is `unknown`, not `any`. Narrow it with `typeof`, `in` or `instanceof`, or validate it with the project's schema library (zod, valibot) if it has one.
- Caught errors: `catch (err) { const message = err instanceof Error ? err.message : String(err); }`.
- Model states as discriminated unions, and end every `switch` over them with a `never` check, so a new case becomes a compile error everywhere it is missing:
  ```ts
  type Shape = { kind: "circle"; r: number } | { kind: "square"; side: number };
  function area(shape: Shape): number {
    switch (shape.kind) {
      case "circle": return Math.PI * shape.r ** 2;
      case "square": return shape.side ** 2;
      default: {
        const missing: never = shape;
        throw new Error(`Unknown shape: ${JSON.stringify(missing)}`);
      }
    }
  }
  ```
- `satisfies` checks a value against a type and keeps its literal types: `const routes = { home: { path: "/" } } satisfies Record<string, Route>;`.
- Avoid `as SomeType` casts and the non-null `!`: they hide the bugs the checker would find. Narrow instead. For DOM lookups, check the result: `const el = document.querySelector<HTMLInputElement>("#name"); if (!el) throw new Error("#name is missing");`.
- Write types on exported functions (parameters and return type); let inference handle local variables.
- Never fix a type error with `any`, `@ts-ignore` or a looser `tsconfig.json`. `@ts-expect-error` with a comment is for a known library bug only.

## Running TypeScript
- Type checks: `npx tsc --noEmit`, or the project's own script. Vue projects use `vue-tsc`; Angular checks templates through its build (`ng build`, `ng test`).
- Node 23.6 and newer (and 22.18 and newer) run `.ts` files directly: `node script.ts`. Node only removes the types:
  - erasable syntax only. An `enum` fails with "TypeScript enum is not supported in strip-only mode";
  - relative imports need the `.ts` ending (`import { x } from "./x.ts"`), or Node can't find the module;
  - there is no type checking, so run `tsc` as well.
- Older projects use `tsx` or `ts-node` for this; follow the project.
