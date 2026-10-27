---
name: angular
description: How to write Angular that compiles for the project's version (standalone, signals, control flow, forms, tests). Use for any Angular code.
---

# Angular essentials

As of late 2026 Angular 22 is current. Most examples you remember use NgModules, `*ngIf`, Zone.js and default change detection; new projects don't.

## First: which Angular is this?
Everything below is for Angular 22. In an older project, use only what its version has: a v15 project full of NgModules and `*ngIf` gets more of the same, not a mix.

| Feature | From version | Before that, use |
| --- | --- | --- |
| Standalone components | 15 (default from 19) | NgModules: `declarations`, `imports`, `exports` |
| `inject()` | 14 | Constructor parameters |
| `provideHttpClient()`, `provideRouter()`, functional guards | 15 | `HttpClientModule`, `RouterModule.forRoot(routes)`, class guards |
| `signal()`, `computed()`, `toSignal()` | 16 | Class fields, RxJS `BehaviorSubject` + the `async` pipe |
| `withComponentInputBinding()` | 16 | `inject(ActivatedRoute).paramMap` |
| `@if`, `@for`, `@switch`, `@defer` | 17 | `*ngIf`, `*ngFor` (`trackBy`), `[ngSwitch]`, with `CommonModule` (or `NgIf`, `NgFor`) imported |
| `input()`, `model()`, `output()`, `viewChild()` | 17.1–17.3 | `@Input()`, `@Output()` with `EventEmitter`, `@ViewChild()` |
| `linkedSignal()`, `resource()` | 19 (experimental) | Signals plus RxJS |
| `httpResource()` | 19.2 (experimental), stable 22 | `HttpClient` in a service, `toSignal()` or the `async` pipe |
| Vitest for `ng test` | 21 (Karma + Jasmine before) | `TestBed` works the same; Jasmine uses `jasmine.createSpy` and `spyOn` instead of `vi.fn()` and `vi.spyOn` |
| Zoneless by default | 21, for new projects | Zone.js updates the view for plain fields |
| Signal forms | 21 (experimental), stable 22 | Reactive forms (`FormGroup`, `FormControl`, `ReactiveFormsModule`) or `ngModel` |
| OnPush by default, `@Service()`, Fetch for `HttpClient` | 22 | Default (eager) change detection, `@Injectable({ providedIn: "root" })` |

- An upgraded project keeps its old setup. If `angular.json` still lists `zone.js` in `polyfills`, Zone.js is on and plain fields still update the view. If components say `ChangeDetectionStrategy.Eager`, the upgrade migration added it on purpose; leave it.
- Features marked experimental or developer preview can change between minor versions. Use them only if the project already does.
- In an old project, errors like `'"@angular/core"' has no exported member named 'input'`, or `Unexpected character "EOF" (Do you have an unescaped "{" in your template?` where you wrote `@if (...) {`, mean the feature is too new for that version. Use the older form from the table; don't upgrade Angular to make it work.
- `*ngIf` and `*ngFor` need `CommonModule` (or `NgIf`, `NgFor`) in the component's `imports`. Forgetting it is not an error: it compiles with only a warning, and the element never appears.

## What changed (and what breaks old habits)
- **Standalone by default** (v19+): components import what they use in `imports: [...]`. Don't create NgModules in new code.
- **Zoneless by default** (new projects from v21): there is no Zone.js to notice that something changed. Setting a plain class field in a `setTimeout`, a promise or a subscription does not update the screen.
- **OnPush by default** (v22+): a component re-renders only when an input changes, an event in its template fires, or a signal it reads changes. The old behaviour is `changeDetection: ChangeDetectionStrategy.Eager`.
- Together: **keep component state in signals.** If the screen doesn't update, a plain field is the cause almost every time.
- **Built-in control flow**: `@if`, `@for`, `@switch`. `*ngIf`, `*ngFor` and `*ngSwitch` are deprecated.
- **Signal forms** (`@angular/forms/signals`) are stable in v22. Reactive forms still work; follow the project.
- **File names** (v20+ style guide and CLI): `user-profile.ts` with class `UserProfile`, no `.component` suffix. Follow whatever the project already does.
- TypeScript 6 or newer is required, and `strictTemplates` is on by default.

## Components and signals
```ts
import { Component, computed, input, output, signal } from "@angular/core";

@Component({
  selector: "app-counter",
  template: `
    <p>{{ label() }}: {{ count() }} (double: {{ double() }})</p>
    <button type="button" (click)="increment()">Add</button>
  `,
})
export class Counter {
  readonly label = input.required<string>();
  readonly changed = output<number>();
  protected readonly count = signal(0);
  protected readonly double = computed(() => this.count() * 2);

  protected increment() {
    this.count.update((n) => n + 1);
    this.changed.emit(this.count());
  }
}
```
- Inputs and outputs are functions: `input()`, `input.required()`, `output()`, and `model()` for two-way binding (`[(value)]="x"`). Read inputs as `this.label()`.
- Queries: `viewChild()`, `viewChildren()`, `contentChild()` return signals.
- `effect()` is for side effects only (logging, syncing to `localStorage`). Never set other signals from an effect; derive them with `computed()`.
- Dependency injection: `private readonly http = inject(HttpClient)`, not constructor parameters, unless the project does it the old way.
- Services: `@Service()` (v22+) is short for `@Injectable({ providedIn: "root" })`. Use whichever the project uses.
- RxJS still works. Turn an observable into a signal with `toSignal(obs$)` (from `@angular/core/rxjs-interop`), or use the `async` pipe in templates.

## Templates
```html
@if (user(); as u) {
  <h2>{{ u.name }}</h2>
} @else {
  <p>Loading…</p>
}

@for (item of items(); track item.id) {
  <li>{{ item.title }}</li>
} @empty {
  <li>No items yet.</li>
}
```
- `@for` requires `track`: an id, or `$index` only for lists that never reorder.
- Call signals in templates: `count()`, not `count`.
- `[innerHTML]` is sanitized, but avoid it for user content anyway; use interpolation.
- `@defer (on viewport) { <heavy-chart /> }` lazy-loads part of a template.

## Data: HTTP and resources
- Set up HTTP once: `provideHttpClient()` in `app.config.ts`. In v22 it uses the Fetch API by default.
- For data a component shows, `httpResource` gives you signals for the value, loading and error state, and refetches when the signals it reads change:
  ```ts
  readonly userId = input.required<string>();
  protected readonly user = httpResource<User>(() => `/api/users/${this.userId()}`);
  ```
  ```html
  @if (user.isLoading()) { <p>Loading…</p> }
  @else if (user.error()) { <p role="alert">Could not load the user.</p> }
  @else if (user.hasValue()) { <h2>{{ user.value().name }}</h2> }
  ```
- For saving (POST, PUT, DELETE), call `HttpClient` from a service and handle errors where the user can see them.

## Forms
With signal forms (v22, or what the project uses). This example and the test under "Tests" are proven on Angular 22 by the kit's own tests: copy them as written, without looking the API up in `@angular/forms`' `.d.ts` files.
```ts
import { Component, signal } from "@angular/core";
import { email, form, FormField, required, submit } from "@angular/forms/signals";

@Component({
  selector: "app-contact-form",
  imports: [FormField],
  template: `
    @if (sent()) {
      <p>Thanks, we'll be in touch!</p>
    } @else {
      <form novalidate (submit)="send($event)">
        <label for="email">Email</label>
        <input id="email" type="email" [formField]="contact.email" />
        @if (contact.email().touched() && contact.email().invalid()) {
          @for (error of contact.email().errors(); track error.kind) {
            <p role="alert">{{ error.message }}</p>
          }
        }
        <!-- ...more fields... -->
        <button type="submit">Send</button>
      </form>
    }
  `,
})
export class ContactForm {
  protected readonly model = signal({ name: "", email: "" });
  protected readonly contact = form(this.model, (path) => {
    required(path.name, { message: "Name is required" });
    required(path.email, { message: "Email is required" });
    email(path.email, { message: "Enter a valid email" });
  });
  protected readonly sent = signal(false);

  protected async send(event: Event) {
    event.preventDefault();
    // submit() marks every field touched, so the errors show; the action runs only when valid.
    await submit(this.contact, {
      action: async () => {
        this.sent.set(true);
        return undefined;
      },
    });
  }
}
```
- The value lives in the `model` signal; what the user typed stays there after a failed submit.
- Field state is a signal call away: `contact.email().value()`, `.errors()`, `.touched()`, `.invalid()`; the whole form is `contact()`.
- Every input needs a `<label>`.

## Routing
- Routes in `app.routes.ts`; lazy-load pages with `loadComponent: () => import("./users/user-page").then((m) => m.UserPage)`.
- To get route params as inputs, add `withComponentInputBinding()` to `provideRouter(...)`; then `readonly id = input.required<string>()` on the page receives `:id`.
- Navigating from `/users/1` to `/users/2` reuses the component. With signal inputs and `httpResource`, the data follows by itself.
- Links: `<a routerLink="/users">`, with `RouterLink` in `imports`.

## Tests
- `ng test` runs Vitest (v21+). Tests use `TestBed` as before. One spec: `npx ng test --watch=false --include src/app/x/x.spec.ts`; plain `npx vitest run` finds no tests in an Angular project.
- Zoneless: after an interaction, `await fixture.whenStable()` before checking the DOM.
  ```ts
  const fixture = TestBed.createComponent(ContactForm);
  await fixture.whenStable();
  const el: HTMLElement = fixture.nativeElement;
  el.querySelector("form")!.dispatchEvent(new Event("submit"));
  await fixture.whenStable();
  expect(el.textContent).toContain("Email is required");
  ```
- Set inputs with `fixture.componentRef.setInput("label", "Total")`, not by assigning to the component.
- HTTP: `provideHttpClient()` plus `provideHttpClientTesting()` in the test providers, then `TestBed.inject(HttpTestingController)` to answer requests.
- Vitest 5 (check the installed version): mocks are cleared before every test, `vi.mock()` must sit at the top level of the file, and `expect(...).resolves` / `.rejects` must be awaited.
- E2E: Playwright if the project has it.

## Commands
- Generate, don't hand-write boilerplate: `npx ng generate component users/user-card`, `npx ng generate service users/users`.
- Dev server on another port: `npx ng serve --port 4300`. Build: `npx ng build`.
- Upgrades go through `npx ng update @angular/core @angular/cli`, which runs the code migrations. Don't bump the versions in `package.json` by hand.
