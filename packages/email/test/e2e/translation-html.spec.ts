import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "playwright/test";

declare global {
  /** The module, set on the page by the bundle bundleForBrowser builds. */
  var translationHtml:
    | typeof import("@open-workspace/email/src/mail/translation-html.ts")
    | undefined;
}

// The app does not expose this module, so bundle it for the browser.
function bundleForBrowser() {
  const dir = mkdtempSync(join(tmpdir(), "openworkspace-e2e-"));
  const entry = join(dir, "entry.ts");
  writeFileSync(
    entry,
    `import * as module from ${JSON.stringify(
      fileURLToPath(
        import.meta
          .resolve("@open-workspace/email/src/mail/translation-html.ts")
      )
    )};\n(window as any).translationHtml = module;\n`
  );
  execFileSync(
    "bun",
    ["build", entry, "--target=browser", `--outfile=${join(dir, "out.js")}`],
    { stdio: "ignore" }
  );

  return readFileSync(join(dir, "out.js"), "utf-8");
}

test("translation preserves email elements and treats model output as text", async ({
  page,
}) => {
  await page.goto("/");
  await page.addScriptTag({ content: bundleForBrowser() });

  const result = await page.evaluate(() => {
    const module = window.translationHtml;

    if (!module) throw new Error("The translation-html bundle did not load");
    const { emailHtmlTextSegments, translatedEmailHtml } = module;

    const original = `<!doctype html><html><head><style>table { width: 100%; }</style></head>
      <body><table><tr><td><p>Hello <strong>friend</strong></p>
      <a href="https://example.com/order">Open order</a><img src="/logo.png" alt="Logo"></td></tr></table></body></html>`;

    const segments = emailHtmlTextSegments(original);

    const translated = translatedEmailHtml(
      original,
      ["Привет", "друг", "<script>alert(1)</script>"],
      true
    );

    const document = new DOMParser().parseFromString(
      translated ?? "",
      "text/html"
    );

    return {
      segments,
      paragraph: document.querySelector("p")?.innerHTML,
      linkText: document.querySelector("a")?.textContent,
      linkHref: document.querySelector("a")?.getAttribute("href"),
      imageSrc: document.querySelector("img")?.getAttribute("src"),
      tableCount: document.querySelectorAll("table").length,
      styles: document.querySelector("style")?.textContent,
      scriptCount: document.querySelectorAll("script").length,
    };
  });

  expect(result.segments).toEqual(["Hello", "friend", "Open order"]);
  expect(result.paragraph).toBe("Привет <strong>друг</strong>");
  expect(result.linkText).toBe("<script>alert(1)</script>");
  expect(result.linkHref).toBe("https://example.com/order");
  expect(result.imageSrc).toBe("/logo.png");
  expect(result.tableCount).toBe(1);
  expect(result.styles).toContain("width: 100%");
  expect(result.scriptCount).toBe(0);
});
