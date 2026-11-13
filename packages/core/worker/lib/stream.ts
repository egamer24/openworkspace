/**
 * The first `maxBytes` of a body, and whether that was all of it. Reading
 * stops, and the stream is cancelled, once it runs past `maxBytes`.
 */
export async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number
) {
  if (!body) return { bytes: new Uint8Array(0), complete: true };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let complete = true;

  try {
    for (;;) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- a stream is read one chunk after another
      const chunk = await reader.read();

      if (chunk.done) break;
      const kept = chunk.value.subarray(0, maxBytes - length);
      chunks.push(kept);
      length += kept.byteLength;

      if (kept.byteLength < chunk.value.byteLength) {
        complete = false;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const bytes = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { bytes, complete };
}
