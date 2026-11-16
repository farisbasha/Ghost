# @tryghost/admin-api-contracts

Admin API contracts: the Zod schemas Ghost core validates Admin API input
with, and the shapes of the responses it sends back.

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

### Responses

Each resource also exports the response it returns: a `record` schema, and
`responses.browse`, `.read`, `.add` and `.edit` envelopes (`{ labels: [...],
meta }` for browse, `{ labels: [record] }` otherwise). Requests change the
shape, so pick the schemas with `responsesFor()` and the parsed options:

```ts
import { labels, snippets } from '@tryghost/admin-api-contracts';

labels.responsesFor({ include: ['count.members'] }).browse; // records carry `count.members`
snippets.responsesFor({ formats: ['lexical'] }).read; // `lexical` only, no `mobiledoc`
```

Types are exported from the root for `import type`:

```ts
import type { LabelRecord, SnippetRecord } from '@tryghost/admin-api-contracts';

type LexicalSnippet = SnippetRecord<'lexical'>;
```

Core does not parse responses at runtime. The e2e suites check every
successful response body against its schema with
`assertions.bodyMatchesSchema()`, so serializer drift fails tests. `fields`
narrows records to the requested columns and isn't modelled; `.pick()` from
`record` when using it.

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
  or I/O. Browser consumers such as Admin import the root entry, so keep it to
  plain Zod.
- Response schemas are strict: a new field in a serialized response should
  fail the e2e checks until the contract is updated.

## Develop

This is a workspace package in the Ghost monorepo. From the package directory:

```bash
pnpm build   # compile to build/ with tsc (ESM)
pnpm test    # type-check + unit tests
pnpm lint    # lint source and tests
```
