/**
 * Reads a body stream to the end, or gives up (cancelling the stream) as soon
 * as it grows past `limit` bytes: a remote server or a client cannot make the
 * Worker buffer more than it allows.
 */
export async function readCappedBody(
  body: ReadableStream<Uint8Array>,
  limit: number
): Promise<Uint8Array | null> {
  let total = 0;
  let exceeded = false;

  const capped = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;

        if (total > limit) {
          exceeded = true;
          controller.error(new Error("The body is over the size limit"));

          return;
        }

        controller.enqueue(chunk);
      },
    })
  );

  try {
    return new Uint8Array(await new Response(capped).arrayBuffer());
  } catch (error) {
    if (exceeded) return null;
    throw error;
  }
}
