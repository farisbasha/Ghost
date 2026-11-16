# @tryghost/admin-api-contracts

Admin API request contracts: the Zod schemas Ghost core validates Admin API
input with.

This is an internal workspace package. See the
[internal package golden path](../../packages/README.md) for its standing
architecture and maintenance rules.

## Usage

Each resource exports one schema set per controller method, shaped for
`defineMethod()` in `@tryghost/api-framework`:

```ts
import { labels } from '@tryghost/admin-api-contracts';

const edit = defineMethod({
  schema: labels.edit,
  permissions: true,
  query(frame) {
    return models.Label.edit(frame.validated.body.labels[0], frame.options);
  },
});
```

`options` exports the shared option primitives (`id`, `slug`, `page`, `limit`,
`order`, `include()`, `formats()`) that resource schemas build on.

## Writing a contract

- Keep schemas plain Zod. `@tryghost/api-framework` compiles them with
  `z.compile()` when it builds a controller, and falls back to Zod's runtime
  parser for any schema the compiler can't model. `test/compile.test.ts`
  fails if a schema can't compile.
- Keep schemas synchronous so they can compile. An async schema needs
  `async: true` in its method's `schema` and is never compiled.
- `z.object()` strips unknown keys, matching the JSON Schema validators this
  package replaces.
- Contracts hold formats, types and validation only: no models, configuration
  or I/O.

## Develop

This is a workspace package in the Ghost monorepo. From the package directory:

```bash
pnpm build   # compile to build/ with tsc (ESM)
pnpm test    # type-check + unit tests
pnpm lint    # lint source and tests
```
