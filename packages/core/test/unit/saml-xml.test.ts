import { describe, expect, it } from "bun:test";

import { escapeXml } from "../../worker/saml/xml-text.ts";

describe("SAML XML escaping", () => {
  it("escapes markup while preserving valid XML characters", () => {
    expect(escapeXml("A&B <tag> \"quoted\" 'value'\n\t😀")).toBe(
      `A&amp;B &lt;tag&gt; &quot;quoted&quot; &apos;value&apos;\n\t😀`
    );
  });

  it.each(["value\0", "value\u0001", "value\uD800"])(
    "rejects XML 1.0-invalid input %#",
    (value) => {
      expect(() => escapeXml(value)).toThrow(
        "XML value contains invalid characters"
      );
    }
  );
});
