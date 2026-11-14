import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { backupItems } from "../../import/backup-source.ts";

const sha256 = (value: string) =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

/** A snapshot as the workspace writes it: backups/<id>/<module>/<folder>/<part>.jsonl next to backups/objects/. */
function snapshot() {
  const root = mkdtempSync(join(tmpdir(), "ow-backup-unit-"));
  const dir = join(root, "backups", "2026-03-03T041700.000Z");
  mkdirSync(join(dir, "email", "ada@example.test"), { recursive: true });
  mkdirSync(join(root, "backups", "objects"));
  writeFileSync(join(dir, "core.json"), "{}");

  const message = "Subject: Kiln\r\n\r\nHello\r\n";
  const good = `${sha256(message)}.eml`;
  const tampered = `${"0".repeat(64)}.eml`;
  writeFileSync(join(root, "backups", "objects", good), message);
  writeFileSync(join(root, "backups", "objects", tampered), "tampered");

  const lines = [
    { id: "eml_1", object: good },
    { id: "eml_2", object: tampered },
    { id: "eml_3", object: `${"f".repeat(64)}.eml` },
    { id: "no_object" },
  ];

  writeFileSync(
    join(dir, "email", "ada@example.test", "000000.jsonl"),
    lines.map((line) => `${JSON.stringify(line)}\n`).join("")
  );

  return { dir, message, good };
}

describe("import backup", () => {
  it("sends each line with its object, and skips damaged or missing objects", () => {
    const { dir, message, good } = snapshot();
    const items = [...backupItems(dir)];
    const base = { module: "email", folder: "ada@example.test" };
    const file = "email/ada@example.test/000000.jsonl";

    expect(items).toEqual([
      {
        ...base,
        sourceId: `${file}:1`,
        body: new TextEncoder().encode(
          `${JSON.stringify({ id: "eml_1", object: good })}\n${message}`
        ),
      },
      { ...base, sourceId: `${file}:2`, skipped: "damaged" },
      { ...base, sourceId: `${file}:3`, skipped: "missing" },
      {
        ...base,
        sourceId: `${file}:4`,
        body: new TextEncoder().encode(JSON.stringify({ id: "no_object" })),
      },
    ]);
  });
});
