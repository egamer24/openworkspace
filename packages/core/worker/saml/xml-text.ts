/** XML text helpers; parsing is in xml.ts. */

const XML_1_0_CHARACTERS =
  // oxlint-disable-next-line no-control-regex -- XML 1.0's Char production lists these control characters
  /^[\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]*$/u;

export function isValidXmlCharacters(value: string) {
  return XML_1_0_CHARACTERS.test(value);
}

export function escapeXml(value: string) {
  if (!isValidXmlCharacters(value)) {
    throw new TypeError("XML value contains invalid characters");
  }

  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
