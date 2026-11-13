import { z } from "zod";

import type { Decoded } from "./codec.ts";

/**
 * What the test routes (test-hooks.ts) take and answer, after codec.ts has
 * decoded it: the test client (client.ts) sends these and parses the answers,
 * and the Worker parses what it was sent.
 */

/** Any value the codec carries. */
export const decoded: z.ZodType<Decoded> = z.lazy(() =>
  z.union([
    z.null(),
    z.undefined(),
    z.boolean(),
    z.number(),
    z.string(),
    z.bigint(),
    z.date(),
    z.instanceof(Uint8Array),
    z.array(decoded),
    z.map(decoded, decoded),
    z.set(decoded),
    z.record(z.string(), decoded),
  ])
);

const headerList = z.array(z.tuple([z.string(), z.string()]));

/** Work a hook awaited from `ctx.waitUntil`; non-empty when some of it failed. */
const background = { background: z.array(z.string()) };

/** A value D1 binds to a statement parameter. */
const d1Value = z.union([
  z.null(),
  z.number(),
  z.bigint(),
  z.string(),
  z.boolean(),
  z.instanceof(Uint8Array),
]);

export type D1Value = z.infer<typeof d1Value>;

export const d1Call = z.object({
  sql: z.string(),
  params: z.array(d1Value).optional(),
  method: z.enum(["all", "first", "run", "raw"]).optional(),
  column: z.string().optional(),
  columnNames: z.boolean().optional(),
});

export type D1Call = z.infer<typeof d1Call>;

export const d1Input = z.union([z.array(d1Call), d1Call]);

const r2HttpMetadata = z.object({
  contentType: z.string().optional(),
  contentLanguage: z.string().optional(),
  contentDisposition: z.string().optional(),
  contentEncoding: z.string().optional(),
  cacheControl: z.string().optional(),
  cacheExpiry: z.date().optional(),
});

/** The R2 put options the test routes carry (not Headers, conditions or checksums). */
export const r2PutOptions = z
  .object({
    httpMetadata: r2HttpMetadata.strict().optional(),
    customMetadata: z.record(z.string(), z.string()).optional(),
    storageClass: z.string().optional(),
  })
  .strict();

export type R2TestPutOptions = z.infer<typeof r2PutOptions>;

export const r2ListOptions = z
  .object({
    limit: z.number().optional(),
    prefix: z.string().optional(),
    cursor: z.string().optional(),
    delimiter: z.string().optional(),
    startAfter: z.string().optional(),
    include: z.array(z.enum(["httpMetadata", "customMetadata"])).optional(),
  })
  .strict();

export type R2TestListOptions = z.infer<typeof r2ListOptions>;

export const r2Call = z.intersection(
  z.object({ binding: z.string() }),
  z.discriminatedUnion("op", [
    z.object({
      op: z.literal("put"),
      key: z.string(),
      body: z.union([z.instanceof(Uint8Array), z.string()]),
      options: r2PutOptions.optional(),
    }),
    z.object({ op: z.enum(["get", "head", "delete"]), key: z.string() }),
    z.object({ op: z.literal("list"), options: r2ListOptions.optional() }),
  ])
);

export type R2Call = z.infer<typeof r2Call>;

export const r2ObjectInfo = z.object({
  key: z.string(),
  size: z.number(),
  etag: z.string(),
  uploaded: z.date(),
  httpMetadata: r2HttpMetadata.optional(),
  customMetadata: z.record(z.string(), z.string()).optional(),
});

export type R2ObjectInfo = z.infer<typeof r2ObjectInfo>;

export const r2ObjectWithBody = r2ObjectInfo.extend({
  body: z.instanceof(Uint8Array),
});

export const r2Listing = z.object({
  objects: z.array(r2ObjectInfo),
  truncated: z.boolean(),
  cursor: z.string().optional(),
  delimitedPrefixes: z.array(z.string()),
});

export const envNames = z.array(z.string());

export const envValues = z.record(z.string(), z.string().optional());

export const queueMessage = z.object({
  id: z.string().optional(),
  body: decoded,
  attempts: z.number().optional(),
  timestamp: z.date().optional(),
});

export const queueCall = z.object({
  role: z.string(),
  messages: z.array(queueMessage),
});

export const queueResult = z.object({
  ...background,
  outcomes: z.array(
    z.object({
      ack: z.boolean(),
      retry: z.boolean(),
      retryDelaySeconds: z.number().optional(),
    })
  ),
  error: z.string().optional(),
});

export const emailCall = z.object({
  from: z.string(),
  to: z.string(),
  raw: z.string(),
  headers: headerList.optional(),
});

export type EmailCall = z.infer<typeof emailCall>;

export const emailResult = z.object({
  ...background,
  rejection: z.string().optional(),
  forwarded: z.array(
    z.object({ to: z.string(), headers: headerList.optional() })
  ),
});

export const scheduledCall = z
  .object({
    cron: z.string().optional(),
    scheduledTime: z.number().optional(),
  })
  .nullish();

export type ScheduledCall = NonNullable<z.infer<typeof scheduledCall>>;

export const scheduledResult = z.object(background);

export const fetchCall = z.object({
  url: z.string(),
  method: z.string(),
  headers: headerList,
  body: z.instanceof(Uint8Array).optional(),
});

export const fetchResult = z.object({
  ...background,
  status: z.number(),
  headers: headerList,
  body: z.instanceof(Uint8Array),
});

export const hookCall = z.object({ args: z.array(decoded) });

export const hookResult = z.object({ ...background, result: decoded });
