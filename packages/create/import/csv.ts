/** Minimal RFC 4180 CSV: quoted fields with "" escapes, header row handled by the caller. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);

    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  // Blank rows and # comments are dropped.
  return rows.flatMap((cells) => {
    const trimmed = cells.map((cell) => cell.trim());
    const [first = ""] = trimmed;

    return trimmed.some(Boolean) && !first.startsWith("#") ? [trimmed] : [];
  });
}

function csvField(value: string) {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function toCsv(rows: string[][]) {
  return `${rows.map((row) => row.map(csvField).join(",")).join("\n")}\n`;
}
