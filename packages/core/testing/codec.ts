import { z } from "zod";

/**
 * JSON with the values RPC arguments and results carry that plain JSON
 * loses: dates, bytes, `undefined`, maps, sets, and bigints. Shared by the
 * Worker's test hooks and the stack suite, so values cross HTTP intact.
 */

const json = z.json();

type Json = z.infer<typeof json>;

type JsonObject = Record<string, Json>;

/** A value as `decode` gives it back. */
export type Decoded =
  | null
  | undefined
  | boolean
  | number
  | string
  | bigint
  | Date
  | Uint8Array
  | Decoded[]
  | Map<Decoded, Decoded>
  | Set<Decoded>
  // oxlint-disable-next-line typescript/consistent-indexed-object-style -- Record<string, Decoded> here would make the alias circular (TS2456)
  | { [key: string]: Decoded };

/** How an extra value travels: an object with its kind under `$t`. */
const tagged = z.discriminatedUnion("$t", [
  z.object({ $t: z.literal("date"), v: z.string() }),
  z.object({ $t: z.literal("bytes"), v: z.string() }),
  z.object({ $t: z.literal("undefined") }),
  z.object({ $t: z.literal("map"), v: z.array(z.tuple([json, json])) }),
  z.object({ $t: z.literal("set"), v: z.array(json) }),
  z.object({ $t: z.literal("bigint"), v: z.string() }),
  z.object({ $t: z.literal("object"), v: z.record(z.string(), json) }),
]);

const scalar = z.union([z.string(), z.number(), z.boolean()]);

function toBase64(bytes: Uint8Array) {
  let binary = "";

  for (let index = 0; index < bytes.length; index += 0x80_00) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x80_00));
  }

  return btoa(binary);
}

function fromBase64(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function tagEntries(entries: [string, Json][]): Json {
  const object: JsonObject = Object.fromEntries(entries);

  // A plain object that happens to have a `$t` key stays an object.
  return "$t" in object ? { $t: "object", v: object } : object;
}

/**
 * The JSON form of any value. Arrays and objects (their own enumerable
 * properties) are walked, so a function is an empty object; what JSON
 * cannot carry and the tags do not cover (symbols, non-finite numbers)
 * becomes null.
 */
function tag<T>(value: T): Json {
  if (value === undefined) return { $t: "undefined" };

  if (value === null) return null;

  if (value instanceof Date) return { $t: "date", v: value.toISOString() };

  if (value instanceof ArrayBuffer) {
    return { $t: "bytes", v: toBase64(new Uint8Array(value)) };
  }

  if (ArrayBuffer.isView(value)) {
    return {
      $t: "bytes",
      v: toBase64(
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      ),
    };
  }

  if (value instanceof Map) {
    return {
      $t: "map",
      v: [...value].map(([key, item]) => [tag(key), tag(item)]),
    };
  }

  if (value instanceof Set) return { $t: "set", v: [...value].map(tag) };

  if (Array.isArray(value)) return value.map(tag);

  // Objects of other realms (and prototype-less ones) are not `instanceof Object`.
  if (value instanceof Object || Object.getPrototypeOf(value) === null) {
    return tagEntries(
      Object.entries(value).map(([key, item]) => [key, tag(item)])
    );
  }

  const bigint = z.bigint().safeParse(value);

  if (bigint.success) return { $t: "bigint", v: bigint.data.toString() };
  const plain = scalar.safeParse(value);

  return plain.success ? plain.data : null;
}

function untag(value: Json): Decoded {
  if (Array.isArray(value)) return value.map(untag);

  if (value === null || !(value instanceof Object)) return value;
  const parsed = tagged.safeParse(value);

  if (!parsed.success) return untagEntries(value);
  const known = parsed.data;

  switch (known.$t) {
    case "date": {
      return new Date(known.v);
    }

    case "bytes": {
      return fromBase64(known.v);
    }

    case "undefined": {
      return undefined;
    }

    case "map": {
      return new Map(known.v.map(([key, item]) => [untag(key), untag(item)]));
    }

    case "set": {
      return new Set(known.v.map(untag));
    }

    case "bigint": {
      return BigInt(known.v);
    }

    case "object": {
      return untagEntries(known.v);
    }

    default: {
      const unexpected: never = known;
      throw new Error(`Unknown codec tag in ${JSON.stringify(unexpected)}`);
    }
  }
}

function untagEntries(object: JsonObject): Record<string, Decoded> {
  return Object.fromEntries(
    Object.entries(object).map(([key, item]) => [key, untag(item)])
  );
}

export function encode<T>(value: T) {
  return JSON.stringify(tag(value));
}

/** The value `encode` gave `text` for (as far as the codec carries it). */
export function decode(text: string): Decoded {
  return untag(json.parse(JSON.parse(text)));
}

/** `decode`, checked against the schema of what the other side sends. */
export function decodeAs<T>(text: string, schema: z.ZodType<T>): T {
  return schema.parse(decode(text));
}
