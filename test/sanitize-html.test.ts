import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "../worker/lib/sanitize-html";

describe("sanitizeHtml", () => {
  it("keeps formatting and safe links, stripping every attribute", async () => {
    expect(await sanitizeHtml(
      '<p class="x" style="color:red" onclick="alert(1)"><strong>Ilya</strong> <em>Morozov</em><br>'
      + '<a href="https://example.com" onmouseover="x()" style="y">site</a> · '
      + '<a href="mailto:ilya@example.com">mail</a> · <a href="tel:+15551234">call</a></p>',
    )).toBe(
      '<p><strong>Ilya</strong> <em>Morozov</em><br>'
      + '<a href="https://example.com" rel="noopener noreferrer" target="_blank">site</a> · '
      + '<a href="mailto:ilya@example.com" rel="noopener noreferrer" target="_blank">mail</a> · '
      + '<a href="tel:+15551234" rel="noopener noreferrer" target="_blank">call</a></p>',
    );
  });

  it.each([
    ['<a href="javascript:alert(1)">x</a>', "x"],
    ['<a href=" JaVaScRiPt:alert(1)">x</a>', "x"],
    ['<a href="jav&#x09;ascript:alert(1)">x</a>', "x"],
    ['<a href="data:text/html,<script>alert(1)</script>">x</a>', "x"],
    ['<a href="vbscript:msgbox(1)">x</a>', "x"],
    ['<a href="//evil.example">x</a>', "x"],
    ['<a href="https://ok.example/" onclick="x">x</a>', '<a href="https://ok.example/" rel="noopener noreferrer" target="_blank">x</a>'],
  ])("only keeps http(s), mailto and tel links: %s", async (input, output) => {
    expect(await sanitizeHtml(input)).toBe(output);
  });

  it.each([
    ["<script>alert(1)</script>ok", "ok"],
    ["<style>body{display:none}</style>ok", "ok"],
    ['<iframe src="https://evil.example"></iframe>ok', "ok"],
    ['<img src=x onerror="alert(1)">ok', "ok"],
    ['<svg><script>alert(1)</script></svg>ok', "ok"],
    ['<object data="x"></object><embed src="y">ok', "ok"],
    ["<!-- hidden --><p>ok</p>", "<p>ok</p>"],
    ['<form action="x"><input value="y"><button>go</button></form>ok', "ok"],
    ['<table><tr><td>cell</td></tr></table>', "cell"],
    ['<font color="red">kept text</font>', "kept text"],
  ])("removes dangerous or unknown markup: %s", async (input, output) => {
    expect(await sanitizeHtml(input)).toBe(output);
  });

  it.each([
    "<<x></x>script>alert(1)<<x></x>/script>",
    "<scr<b>ipt>alert(1)</scr</b>ipt>",
    "<<img src=x onerror=alert(1)>",
    "&lt;script&gt;alert(1)&lt;/script&gt;",
    "<p>1 < 2 > 0</p>",
  ])("cannot be tricked into producing a tag: %s", async (input) => {
    const output = await sanitizeHtml(input);
    expect(output).not.toMatch(/<\s*(script|img|svg|iframe)/iu);
    expect(output).not.toMatch(/on\w+\s*=/iu);
  });

  it("keeps entities and text as written", async () => {
    expect(await sanitizeHtml("<p>Fish &amp; Chips &lt;tm&gt; 1 &lt; 2</p>"))
      .toBe("<p>Fish &amp; Chips &lt;tm&gt; 1 &lt; 2</p>");
    expect(await sanitizeHtml("<p>1 < 2</p>")).toBe("<p>1 &lt; 2</p>");
  });
});
