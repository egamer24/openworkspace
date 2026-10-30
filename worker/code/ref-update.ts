import { gitUpstream, type ArtifactsBindings } from "./artifacts";
import type { Fetcher } from "./browse";
import { FLUSH_PKT, pktLine, ZERO_OID } from "./pkt-line";

/**
 * Server-side ref updates (merges, branch creation and deletion) sent as a
 * smart HTTP receive-pack request. The objects already exist in the
 * repository, so the request carries an empty pack. Git checks the old value
 * under the ref lock, which makes every update a compare-and-swap: if the
 * branch moved since we looked, the update is refused instead of lost.
 */

const decoder = new TextDecoder();

export class RefUpdateRejectedError extends Error {}

async function emptyPack() {
  const header = new Uint8Array([
    0x50, 0x41, 0x43, 0x4b, // "PACK"
    0, 0, 0, 2, // version 2
    0, 0, 0, 0, // no objects
  ]);
  const checksum = new Uint8Array(await crypto.subtle.digest("SHA-1", header));
  const pack = new Uint8Array(header.byteLength + checksum.byteLength);
  pack.set(header);
  pack.set(checksum, header.byteLength);
  return pack;
}

function readPktLines(body: Uint8Array) {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 4 <= body.byteLength) {
    const length = Number.parseInt(decoder.decode(body.subarray(offset, offset + 4)), 16);
    if (Number.isNaN(length)) break;
    if (length < 4) {
      offset += 4;
      continue;
    }
    lines.push(decoder.decode(body.subarray(offset + 4, offset + length)).replace(/\n$/u, ""));
    offset += length;
  }
  return lines;
}

export async function updateRef(
  env: ArtifactsBindings,
  artifactsName: string,
  update: { ref: string; oldOid: string; newOid: string },
  fetcher: Fetcher,
) {
  const upstream = await gitUpstream(env, artifactsName, "write");
  const command = pktLine(
    `${update.oldOid} ${update.newOid} ${update.ref}\0report-status agent=openworkspace\n`,
  );
  const deleting = ZERO_OID.test(update.newOid);
  const pack = deleting ? new Uint8Array() : await emptyPack();
  const body = new Uint8Array(command.byteLength + FLUSH_PKT.byteLength + pack.byteLength);
  body.set(command);
  body.set(FLUSH_PKT, command.byteLength);
  body.set(pack, command.byteLength + FLUSH_PKT.byteLength);

  const response = await fetcher(`${upstream.remote}/git-receive-pack`, {
    method: "POST",
    headers: {
      authorization: upstream.authorization,
      "content-type": "application/x-git-receive-pack-request",
      accept: "application/x-git-receive-pack-result",
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`Ref update failed (${response.status})`);
  }
  const lines = readPktLines(new Uint8Array(await response.arrayBuffer()));
  const unpack = lines.find((line) => line.startsWith("unpack "));
  if (unpack && unpack !== "unpack ok") {
    throw new RefUpdateRejectedError(unpack.slice("unpack ".length));
  }
  const status = lines.find((line) => line.endsWith(` ${update.ref}`) || line.includes(` ${update.ref} `));
  if (status?.startsWith(`ok ${update.ref}`)) return;
  const reason = status?.startsWith("ng ")
    ? status.slice(`ng ${update.ref} `.length) || "rejected"
    : "no status reported";
  throw new RefUpdateRejectedError(reason);
}
