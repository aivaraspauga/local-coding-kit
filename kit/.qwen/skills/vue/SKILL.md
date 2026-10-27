---
name: vue
description: How to write Vue and Nuxt code for the project's version (script setup, reactivity, Pinia, router, tests). Use for any .vue, store or Nuxt code.
---

# Vue and Nuxt essentials

As of late 2026: Vue 3.5 (3.6 with Vapor Mode in release candidates), Vue Router 5, Pinia 4, Nuxt 4, Vite 8, Vitest 5.

## First: which Vue is this?
Everything below is for Vue 3.5. In an older project, use only what its version has.

| Feature | From version | Before that, use |
| --- | --- | --- |
| `<script setup>` | 3.2 (and 2.7) | `export default defineComponent({ setup() { ...; return { ... } } })`, or the Options API |
| `defineOptions`, `defineSlots`, generic components, short `defineEmits` syntax (`save: [id: number]`) | 3.3 | `defineEmits<{ (e: "save", id: number): void }>()`, a separate `<script>` block for options |
| `defineModel()` | 3.4 | A `modelValue` prop plus `emit("update:modelValue", value)` |
| Same-name binding shorthand (`:id` for `:id="id"`) | 3.4 | Write it out |
| Reactive destructured props with defaults, `useTemplateRef()`, `useId()`, `onWatcherCleanup()` | 3.5 | `const props = withDefaults(defineProps<...>(), { count: 0 })` and `props.count`; `const input = ref<HTMLInputElement>()` with `ref="input"`; your own id; the `onCleanup` argument of `watch` |
| Vapor Mode | 3.6 (opt-in) | Normal components |

**Libraries and tools by generation:**

| | Vue 3 projects | Vue 2 projects |
| --- | --- | --- |
| State | Pinia (2, 3 or 4), or older Vuex 4 | Vuex 3, or Pinia 2 |
| Router | Vue Router 4 or 5 (same API) | Vue Router 3 (`new VueRouter`, `this.$route`) |
| Meta-framework | Nuxt 3 (app code in the root: `pages/`, `components/`) or Nuxt 4 (`app/`) | Nuxt 2 (`asyncData`, `fetch()` hooks) |
| Tests | Vitest (or Jest) with Vue Test Utils 2 | Jest with Vue Test Utils 1 |
| Build | Vite (`npm run dev`) | Vue CLI (`npm run serve`), webpack |

**Vue 2 (2.6 and older, or 2.7):** the rest of this skill does not apply. Vue 2 ended support at the end of 2023, but many apps still run it. Follow the existing components:
- Options API: `data()`, `computed`, `methods`, `watch`, and `this`.
- Adding a new property to a reactive object, or setting an array item by index, is not reactive. Use `this.$set(obj, "key", value)` or `array.splice(i, 1, value)`.
- `v-model` on a component uses the `value` prop and the `input` event (or the component's `model` option); there is no `defineModel`.
- Filters (`{{ price | currency }}`) and `.sync` exist in Vue 2 and are gone in Vue 3.
- Vue 2.7 also has the Composition API and `<script setup>`, but not `defineModel`, `useTemplateRef` or `useId`.
- Don't migrate a Vue 2 app to Vue 3 as a side effect of another task. It's a project of its own.

## Components
- Write components with `<script setup lang="ts">` unless the project uses the Options API; then stay with it in that file.
- Props with TypeScript types. Since Vue 3.5, destructured props stay reactive and can have defaults:
  ```ts
  const { title, count = 0 } = defineProps<{ title: string; count?: number }>();
  const emit = defineEmits<{ save: [id: number]; cancel: [] }>();
  ```
  Watching a destructured prop needs a getter: `watch(() => count, ...)`, not `watch(count, ...)`.
- Two-way binding on your own component: `const model = defineModel<string>()` in the child, `v-model="name"` in the parent. Don't mutate props directly.
- Template refs: `const input = useTemplateRef<HTMLInputElement>("input")` with `ref="input"` in the template (Vue 3.5+).
- Use `useId()` for ids that pair a `<label for>` with an input; it is stable between server and client.
- Vapor Mode (`<script setup vapor>`, Vue 3.6) is opt-in. Don't use it unless the project already does.

## Reactivity
- `ref()` for values (read and write `.value` in script; templates unwrap it). `reactive()` only for objects you never replace or destructure.
- Destructuring a `reactive()` object or a Pinia store loses reactivity. Use `toRefs(obj)` or `storeToRefs(store)` (state and getters); take actions straight from the store.
- Derived values are `computed()`, not a `watch` that sets another ref.
- `watch` for side effects (fetching when an id changes). Clean up with `onWatcherCleanup(() => controller.abort())` (3.5+), or the `onCleanup` argument.
- Replace arrays and objects held in a `ref` freely; mutating them (`items.value.push(x)`) also works.

## Templates
- Every `v-for` needs a stable `:key` (an id, not the index if items can move).
- Never put `v-if` and `v-for` on the same element: in Vue 3 `v-if` runs first and can't see the loop variable. Filter in a `computed`, or wrap in `<template v-for>`.
- `v-html` with user content is an XSS hole. Use text interpolation.
- Event modifiers: `@submit.prevent`, `@keyup.enter`.

## Forms
- `v-model` on inputs; `v-model.number` and `v-model.trim` when needed.
- `<form novalidate @submit.prevent="send">` when you show your own error messages; otherwise `required` or `type="email"` make the browser block the submit and your messages never appear.
- Keep what the user typed after an error; only clear the form after success.
- Every input needs a `<label>` (tests and screen readers find fields by it).

```vue
<script setup lang="ts">
import { reactive, ref, useId } from "vue";

const form = reactive({ name: "", email: "" });
const errors = ref<Record<string, string>>({});
const sent = ref(false);
const id = useId();

function send() {
  const found: Record<string, string> = {};
  if (!form.name.trim()) found.name = "Name is required";
  if (!/^\S+@\S+\.\S+$/.test(form.email)) found.email = "Enter a valid email";
  errors.value = found;
  if (Object.keys(found).length === 0) sent.value = true;
}
</script>

<template>
  <p v-if="sent">Thanks, we'll be in touch!</p>
  <form v-else novalidate @submit.prevent="send">
    <label :for="`${id}-name`">Name</label>
    <input :id="`${id}-name`" v-model="form.name" :aria-invalid="!!errors.name" />
    <p v-if="errors.name" role="alert">{{ errors.name }}</p>
    <!-- ...more fields... -->
    <button type="submit">Send</button>
  </form>
</template>
```

## State: Pinia
- Prefer setup stores, the same style as components:
  ```ts
  export const useCartStore = defineStore("cart", () => {
    const items = ref<Item[]>([]);
    const total = computed(() => items.value.reduce((sum, i) => sum + i.price, 0));
    function add(item: Item) { items.value.push(item); }
    return { items, total, add };
  });
  ```
- A setup store must return every piece of state, or devtools and SSR miss it.

## Routing: Vue Router
- Vue Router 5 keeps the v4 API (`createRouter`, `useRoute`, `useRouter`, `<RouterLink>`). File-based routing is now built in (`vue-router/vite`), but only use it if the project does.
- When only the params change (`/users/1` → `/users/2`), the same component instance is reused and `onMounted` doesn't run again. Watch the param: `watch(() => route.params.id, load, { immediate: true })`.
- `route.params.id` is typed `string | string[]`; pass it on as `String(route.params.id)` (vue-tsc rejects it where a `string` is expected).
- Lazy-load route components: `component: () => import("./views/UserView.vue")`.
- Test a routed page through a real router (proven on Vue Router 5 by the kit's tests; copy it rather than reading vue-router's `.d.ts`):
  ```ts
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/users/:id", component: UserView }] });
  router.push("/users/1");
  await router.isReady();
  const wrapper = mount(RouterView, { global: { plugins: [router] } });
  await flushPromises();
  expect(wrapper.text()).toContain("Ada");
  await router.push("/users/2");
  await flushPromises();
  ```

## Nuxt (a `nuxt.config.*` in the project)
- Nuxt 4 keeps app code in `app/` (`app/pages`, `app/components`, `app/composables`); server code stays in `server/`. A `pages/` folder at the project root is ignored: its pages answer 404.
- Load data in pages and components with `await useFetch("/api/x")` or `useAsyncData`: they run once on the server and hand the result to the client. Plain `fetch("/api/x")` in `setup` fails during server rendering (the page answers 500). Use `$fetch` in event handlers (a button click, a form submit).
- API routes: `server/api/<name>.get.ts` / `.post.ts` exporting `defineEventHandler(async (event) => { const body = await readBody(event); ... })`. Validate the body and `throw createError({ statusCode: 400, statusMessage: "..." })` on bad input.
- Browser-only code (`window`, `localStorage`) goes in `onMounted`, a `.client.vue` component, or `<ClientOnly>`. At the top of `setup` it crashes the server render (500).
- Components, composables and Vue APIs are auto-imported; don't add imports the project doesn't use.
- Every page answering 500 with "Either manifest or precomputed data must be provided", while API routes work, is a Nuxt 4.6.0 bug on Windows ([nuxt#36467](https://github.com/nuxt/nuxt/issues/36467)), not your code. Tell the user; pinning `nuxt` to 4.5.2 works around it.

## Tests
- Vitest with `@vue/test-utils` or `@testing-library/vue`, whichever the project uses. Component tests need a DOM: `environment: "jsdom"` (or `happy-dom`) in the config, or `// @vitest-environment jsdom` at the top of the file.
- Test Utils updates the DOM asynchronously; `await` every interaction:
  ```ts
  const wrapper = mount(ContactForm);
  await wrapper.find("form").trigger("submit");
  expect(wrapper.text()).toContain("Name is required");
  await wrapper.find("input").setValue("Ada");
  ```
- Components that use Pinia need `global: { plugins: [createTestingPinia()] }` (from `@pinia/testing`) or a real `createPinia()`.
- Vitest 5 (check the installed version): mocks are cleared before every test, `vi.mock()` must sit at the top level of the file, and `expect(...).resolves` / `.rejects` must be awaited or the test fails.
- Test a form like a user: send it empty (errors appear), fix one field and send (the other values are still there), then a valid send (success shown).
