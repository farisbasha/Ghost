import { z } from 'zod';
import * as options from './options.ts';
import * as response from './response.ts';

export const FORMATS = ['mobiledoc', 'lexical'] as const;

export type SnippetFormat = (typeof FORMATS)[number];

const formats = options.formats(FORMATS);

const jsonString = z
  .string()
  .max(1_000_000_000)
  .refine(
    (value) => {
      try {
        JSON.parse(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Invalid JSON string' },
  );

const snippet = z.object({
  name: z.string().min(1).max(191),
  mobiledoc: jsonString,
  lexical: jsonString.nullable().optional(),
});

const body = z.object({ snippets: z.tuple([snippet]) });

export const browse = {
  options: z.object({
    limit: options.limit.optional(),
    order: options.order.optional(),
    page: options.page.optional(),
    formats: formats.optional(),
    filter: options.filter,
  }),
};

export const read = {
  options: z.object({ id: options.id, formats: formats.optional() }),
};

export const add = {
  options: z.object({ formats: formats.optional() }),
  body: body,
};

// Edits replace the whole snippet, so they need the same fields as an add.
export const edit = {
  options: z.object({ id: options.id, formats: formats.optional() }),
  body: body,
};

export const destroy = {
  options: z.object({ id: options.id }),
};

// Responses carry only the requested `formats`, `mobiledoc` by default.

const DEFAULT_FORMATS = ['mobiledoc'] as const;

const content = {
  mobiledoc: z.string(),
  lexical: z.string().nullable(),
};

const base = z.strictObject({
  id: response.id,
  name: z.string(),
  created_at: response.datetime,
  updated_at: response.datetime.nullable(),
});

/** The snippet record returned for the given `formats`. */
export const recordFor = <const Format extends SnippetFormat>(requested: readonly Format[]) =>
  base.extend(
    Object.fromEntries(requested.map((format) => [format, content[format]])) as Pick<
      typeof content,
      Format
    >,
  );

export const record = recordFor(DEFAULT_FORMATS);

const responsesOf = <Item extends z.ZodType>(item: Item) => ({
  browse: response.browse('snippets', item),
  read: response.single('snippets', item),
  add: response.single('snippets', item),
  edit: response.single('snippets', item),
});

export const responses = responsesOf(record);

/** The response schemas for a request's parsed options. */
export const responsesFor = (request: { formats?: readonly SnippetFormat[] }) =>
  responsesOf(recordFor(request.formats ?? DEFAULT_FORMATS));

type Content = z.output<z.ZodObject<typeof content>>;

/** A snippet carrying the `Format` fields it was requested with. */
export type SnippetRecord<Format extends SnippetFormat = 'mobiledoc'> = z.output<typeof base> &
  Pick<Content, Format>;
export type SnippetsBrowseResponse<Format extends SnippetFormat = 'mobiledoc'> = {
  snippets: SnippetRecord<Format>[];
  meta: z.output<typeof response.meta>;
};
/** The body of a `read`, `add` or `edit` response. */
export type SnippetResponse<Format extends SnippetFormat = 'mobiledoc'> = {
  snippets: [SnippetRecord<Format>];
};
