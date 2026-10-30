/**
 * Minimal Git pkt-line support for the smart HTTP receive-pack request head.
 * We only need the ref update commands, which arrive before the packfile, to
 * authorize a push before any object reaches Artifacts.
 */

export const ZERO_OID = /^0+$/u;

export type RefUpdateCommand = {
  oldOid: string;
  newOid: string;
  ref: string;
};

export type ReceivePackHead = {
  commands: RefUpdateCommand[];
  capabilities: Set<string>;
  /** Bytes consumed from the request stream, including the flush packet. */
  head: Uint8Array;
  /** Bytes read past the head; they belong to the packfile. */
  rest: Uint8Array;
};

export class PktLineError extends Error {}

const MAX_HEAD_BYTES = 4 * 1024 * 1024;
const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function concat(chunks: Uint8Array[]) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

type HeadScan =
  | { done: false }
  | { done: true; end: number; lines: string[] };

function scanHead(buffer: Uint8Array): HeadScan {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.byteLength) {
    const lengthText = decoder.decode(buffer.subarray(offset, offset + 4));
    if (!/^[0-9a-f]{4}$/u.test(lengthText)) {
      throw new PktLineError("Malformed pkt-line length");
    }
    const length = Number.parseInt(lengthText, 16);
    if (length === 0) return { done: true, end: offset + 4, lines };
    if (length < 4) throw new PktLineError("Unexpected special packet");
    if (offset + length > buffer.byteLength) return { done: false };
    lines.push(decoder.decode(buffer.subarray(offset + 4, offset + length)));
    offset += length;
  }
  return { done: false };
}

function parseCommands(lines: string[]) {
  const commands: RefUpdateCommand[] = [];
  let capabilities = new Set<string>();
  for (const [index, rawLine] of lines.entries()) {
    let line = rawLine.endsWith("\n") ? rawLine.slice(0, -1) : rawLine;
    if (index === 0 && line.startsWith("push-cert")) {
      throw new PktLineError("Signed pushes are not supported");
    }
    if (line.startsWith("shallow ")) continue;
    const nul = line.indexOf("\0");
    if (nul >= 0) {
      if (commands.length > 0) {
        throw new PktLineError("Capabilities must follow the first command");
      }
      capabilities = new Set(line.slice(nul + 1).split(" ").filter(Boolean));
      line = line.slice(0, nul);
    }
    const [oldOid, newOid, ref, ...extra] = line.split(" ");
    if (
      extra.length > 0
      || !oldOid || !OID_PATTERN.test(oldOid)
      || !newOid || !OID_PATTERN.test(newOid)
      || !ref
    ) {
      throw new PktLineError("Malformed ref update command");
    }
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) throw new PktLineError("Push contains no commands");
  return { commands, capabilities };
}

/** Reads ref update commands and leaves the remaining stream untouched. */
export async function readReceivePackHead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReceivePackHead> {
  let buffer = new Uint8Array(0);
  for (;;) {
    const scan = scanHead(buffer);
    if (scan.done) {
      return {
        ...parseCommands(scan.lines),
        head: buffer.subarray(0, scan.end),
        rest: buffer.subarray(scan.end),
      };
    }
    if (buffer.byteLength > MAX_HEAD_BYTES) {
      throw new PktLineError("Push command list is too large");
    }
    const { done, value } = await reader.read();
    if (done) throw new PktLineError("Push request ended before commands");
    buffer = concat([buffer, value]);
  }
}

export function pktLine(payload: string | Uint8Array) {
  const bytes = typeof payload === "string" ? encoder.encode(payload) : payload;
  const length = (bytes.byteLength + 4).toString(16).padStart(4, "0");
  return concat([encoder.encode(length), bytes]);
}

export const FLUSH_PKT = encoder.encode("0000");

/**
 * Builds a receive-pack result that rejects every command, so the client
 * prints a per-ref reason instead of a bare HTTP failure. Returns null when
 * the client did not ask for a status report.
 */
export function rejectedReceivePackResult(
  commands: RefUpdateCommand[],
  capabilities: Set<string>,
  reasons: Map<string, string>,
) {
  if (!capabilities.has("report-status") && !capabilities.has("report-status-v2")) {
    return null;
  }
  const report = concat([
    pktLine("unpack ok\n"),
    ...commands.map((command) =>
      pktLine(`ng ${command.ref} ${reasons.get(command.ref) ?? "push rejected"}\n`)
    ),
    FLUSH_PKT,
  ]);
  // Side-band packets carry at most 65520 (or 1000) bytes including the
  // 4-byte length and the band byte.
  const sideBand = capabilities.has("side-band-64k")
    ? 65_515
    : capabilities.has("side-band") ? 995 : 0;
  if (!sideBand) return report;

  const packets: Uint8Array[] = [];
  for (let offset = 0; offset < report.byteLength; offset += sideBand) {
    packets.push(pktLine(concat([
      Uint8Array.of(1),
      report.subarray(offset, offset + sideBand),
    ])));
  }
  packets.push(FLUSH_PKT);
  return concat(packets);
}
