---
name: verify-web-app
description: Run the app and use the feature like a user, then shut everything down. Use after building or fixing anything a user sees or calls.
---

# Verify a web app like a user

A page can pass every check and still answer HTTP 500. Verify in the running app, then clean up.

1. **Prefer the project's own e2e tests.** If it has Playwright (`playwright.config.*`), add or update a test for the feature next to the existing ones and run `npx playwright test <file> --reporter=line`. Playwright starts and stops the dev server itself. `--reporter=line` keeps the output short and stops an HTML report from opening and waiting.
   - Next.js 16 allows one dev server per project. If you already started one, stop it before running Playwright; otherwise Playwright's own server fails ("Another next dev server is already running") and the run waits until it times out. (If the config reads `BASE_URL`, you can point it at your server instead.)
   - That error prints the old server's `PID`. Stopping the background task often leaves that process running on Windows; end it with `node -e "process.kill(<PID>)"`, which works the same from Bash and PowerShell. Don't try `taskkill` variants one after another.
   - "Executable doesn't exist" means the browsers are not installed: run `npx playwright install chromium` once.
   - Before trusting a pass, make sure Playwright tested *this* app: a config with `reuseExistingServer: true` silently uses whatever already answers on its port (an old dev server, another project). Prefer `reuseExistingServer: false`.
2. **Otherwise, start the dev server in the background on a free port** so you do not collide with a server the user already runs:

   ```bash
   npm run dev -- --port 3123   # Next.js; run it with run_in_background
   ```

   Other dev servers:
   - Vite (Vue, plain projects): `npm run dev -- --port 3123 --strictPort`
   - Nuxt: `npm run dev -- --port 3123`
   - Angular: `npx ng serve --port 3123`

   Wait until its output says it is ready (Next.js prints `Ready in`), instead of sleeping for a fixed time.
3. **Check the server answers:** `curl -s -o /dev/null -w "%{http_code}" http://localhost:3123/your-page` must print `200`. For an API: `curl -s http://localhost:3123/api/thing` and read the JSON.
4. **Use the feature in a real browser** when it is interactive and the project has Playwright. Don't install Playwright or a browser just to check: without it, component tests that click through the feature are the check (an Angular, Vue or Vite page renders in the browser, so `curl` only shows the empty shell). With Playwright installed, a throwaway script is enough:

   ```js
   // verify.tmp.mjs — delete it when done
   import { chromium } from "@playwright/test";
   const browser = await chromium.launch();
   const page = await browser.newPage();
   const errors = [];
   page.on("pageerror", (e) => errors.push(e.message));
   page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
   await page.goto("http://localhost:3123/todo");
   await page.getByRole("textbox").fill("Buy milk");
   await page.getByRole("button", { name: "Add" }).click();
   console.log(await page.getByRole("list").innerText(), errors);
   await browser.close();
   ```

   Try one wrong input too (empty field, bad email) and check the error appears and what the user typed is still there.
5. **If something is wrong, read the dev server's output first.** It names the failing file and line.
6. **Clean up:** stop the dev server you started (stop the background task), delete temporary scripts and the screenshots you took yourself. Leave the test runner's output folders (`test-results/`, `playwright-report/`, `coverage/`): they are git-ignored and rewritten on every run. Then check the port is really free: on Windows, stopping the task can kill only `npm` and leave the server process running for hours.

   ```powershell
   Get-NetTCPConnection -LocalPort 3123 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { taskkill /T /F /PID $_.OwningProcess }
   ```

   (macOS/Linux: `lsof -ti tcp:3123 | xargs kill`.) Only kill what listens on the port *you* used.
7. Report what you checked and what you saw (status codes, the text on the page, console errors or "no console errors").
