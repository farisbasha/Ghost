import { z } from 'zod';
import * as options from './options.ts';

const include = options.include(['count.members']);

const label = z.object({
  // A leading comma would split the label when it is written as a list.
  name: z
    .string()
    .min(1)
    .max(191)
    .regex(/^([^,]|$)/),
  slug: z.string().max(191).nullable().optional(),
});

const body = <Item extends z.ZodType>(item: Item) => z.object({ labels: z.tuple([item]) });

export const browse = {
  options: z.object({
    include: include.optional(),
    filter: options.filter,
    fields: options.fields,
    limit: options.limit.optional(),
    order: options.order.optional(),
    page: options.page.optional(),
  }),
};

export const read = {
  options: z.object({
    id: options.id.optional(),
    slug: options.slug.optional(),
    include: include.optional(),
    filter: options.filter,
    fields: options.fields,
  }),
};

export const add = {
  options: z.object({ include: include.optional() }),
  body: body(label),
};

export const edit = {
  options: z.object({ id: options.id, include: include.optional() }),
  body: body(label.partial()),
};

export const destroy = {
  options: z.object({ id: options.id }),
};
