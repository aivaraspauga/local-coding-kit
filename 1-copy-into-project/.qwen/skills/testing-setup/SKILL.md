---
name: testing-setup
description: Set up Vitest, Testing Library and Playwright with an axe check, proven on Next.js 16. Use when the project has no test runner.
---

# Set up tests in a project that has none

First look: a `test` script, `vitest.config.*`, `jest.config.*` or `playwright.config.*` means the project already has a setup. Use it, don't add a second one. Angular projects test through `ng test` (see the `angular` skill); create-vue projects already have Vitest.

These steps were proven on a fresh create-next-app 16.4 project (Vitest 5.0, Playwright 1.64, axe-core/playwright 4.13); install the latest versions. Tell the user that `package.json` changes.

## 1. Install

```bash
npm install -D vitest @testing-library/react @testing-library/dom @testing-library/jest-dom jsdom @playwright/test @axe-core/playwright @types/node@<your Node major>
npx playwright install chromium
```

- `@types/node@<major>`: use `node -v` (`v26.x` → `@types/node@26`). create-next-app writes `@types/node: ^20`, which Vitest 5 doesn't accept, and npm stops with `ERESOLVE`. Raise `@types/node`; never use `--legacy-peer-deps` or `--force` to get past it.
- `npx playwright install chromium` once per Playwright version ("Executable doesn't exist" means it's missing).

## 2. Files

`vitest.config.mts`:

```ts
import { defineConfig } from "vitest/config";

// Vite 8 compiles JSX and resolves tsconfig paths itself, so no React or tsconfig-paths plugin.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "jsdom",
    // Unit tests are *.test.ts(x), in tests/ or next to the code in src/; browser tests are *.spec.ts.
    include: ["{src,tests}/**/*.test.{ts,tsx}"],
    setupFiles: ["./tests/setup.ts"],
  },
});
```

`tests/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
```

`scripts/vitest.mjs` (Windows: started from a path whose drive letter has a different case, `c:\` instead of `C:\`, Vitest loads itself twice and every test fails with "Vitest failed to find the current suite"; this runs it from the true path):

```js
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";

const cwd = realpathSync.native(process.cwd());
const vitest = join(cwd, "node_modules", "vitest", "vitest.mjs");
const run = spawnSync(process.execPath, [vitest, ...process.argv.slice(2)], { cwd, stdio: "inherit" });
process.exit(run.status ?? 1);
```

`playwright.config.ts`:

```ts
import { defineConfig, devices } from "@playwright/test";

const port = 3123;
const baseURL = process.env.BASE_URL ?? `http://localhost:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL, trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.BASE_URL
    ? undefined
    : // Never reuse a server already on the port: it may be another app, or an old copy of this one.
      { command: `npm run dev -- --port ${port}`, url: baseURL, reuseExistingServer: false },
});
```

Scripts (`npm pkg set` edits `package.json` safely):

```bash
npm pkg set "scripts.test=node scripts/vitest.mjs run" "scripts.test:e2e=playwright test"
```

`.gitignore`: add `test-results/` and `playwright-report/`.

Next.js 16 allows one `next dev` per project folder, whatever the port. If the user (or you) already has `npm run dev` running, Playwright's own server stops with "Another next dev server is already running": stop that server first, or point the tests at it with `BASE_URL=http://localhost:3000 npx playwright test`.

The kit's checks pick up the `test` script by themselves, so unit tests now run before every "done". Browser tests are slower and stay a separate `npm run test:e2e`.

## 3. First tests

`tests/unit/home.test.tsx`, a component test (import with `@/`, query by role and name). Read `src/app/page.tsx` first and put its real `<h1>` text where these examples say `Your page heading` (a fresh create-next-app 16.4 page says "To get started, edit the page.tsx file."):

```tsx
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";

import Home from "@/app/page";

test("home page shows its heading", () => {
  render(<Home />);
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Your page heading");
});
```

Async Server Components (pages that `await` data) aren't fully supported by these tools; the Next.js testing guide recommends browser tests for them. Test their data functions directly, and the page in a browser test.

`tests/e2e/home.spec.ts`, a browser test with the accessibility check:

```ts
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("home page loads and has no accessibility violations", async ({ page }) => {
  await page.goto("/");
  // Check the right page loaded first: a 404 page passes axe too.
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Your page heading");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
});
```

## 4. Prove it

`npm test` and `npx playwright test --reporter=line` must pass, and the project's checks must still pass (the type check now covers the test files). Then make one test fail on purpose (change the expected text), see it fail, and change it back: a setup where nothing can fail tests nothing.

Other stacks: plain Vite projects use the same Vitest setup without `resolve.tsconfigPaths` (unless they have path aliases) and with their own components; Nuxt has `@nuxt/test-utils` (read its README in `node_modules` after installing).
