/**
 * Allowlist sanitizer for small pieces of user-authored HTML (signatures),
 * built on the Workers runtime's HTMLRewriter. Formatting tags survive with
 * every attribute removed; links keep only an http(s), mailto or tel href.
 * Everything else is unwrapped, or dropped with its content when the content
 * itself is executable or invisible. Images are not allowed.
 */

const ALLOWED_TAGS = new Set([
  "p", "br", "div", "span", "b", "strong", "i", "em", "u", "s",
  "a", "ul", "ol", "li", "blockquote",
]);

const DROPPED_WITH_CONTENT = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed",
  "applet", "template", "noscript", "noembed", "noframes", "svg", "math",
  "head", "title", "textarea", "select", "option", "button", "form",
  "input", "xmp", "plaintext", "base", "meta", "link",
]);

const SAFE_HREF = /^(?:https?:\/\/|mailto:|tel:)[^\s"'<>`\\]+$/iu;

export const MAX_SANITIZED_HTML_LENGTH = 20_000;

export async function sanitizeHtml(html: string): Promise<string> {
  const rewriter = new HTMLRewriter()
    .on("*", {
      element(element) {
        const tag = element.tagName.toLowerCase();
        if (DROPPED_WITH_CONTENT.has(tag)) {
          element.remove();
          return;
        }
        if (!ALLOWED_TAGS.has(tag)) {
          element.removeAndKeepContent();
          return;
        }
        const href = tag === "a" ? element.getAttribute("href")?.trim() : undefined;
        // The worker tsconfig also loads DOM types, which mistype this as Attr.
        const attributes = element.attributes as unknown as Iterable<[string, string]>;
        for (const [name] of [...attributes]) element.removeAttribute(name);
        if (tag !== "a") return;
        if (href && SAFE_HREF.test(href)) {
          element.setAttribute("href", href);
          element.setAttribute("rel", "noopener noreferrer");
          element.setAttribute("target", "_blank");
        } else {
          element.removeAndKeepContent();
        }
      },
    })
    .onDocument({
      doctype() {},
      comments(comment) {
        comment.remove();
      },
      text(chunk) {
        // Removing a tag can splice neighbouring text into new markup
        // ("<<x></x>script>" -> "<script>"), so bare angle brackets in text
        // are always escaped. Existing entities pass through unchanged.
        if (/[<>]/u.test(chunk.text)) {
          chunk.replace(chunk.text.replaceAll("<", "&lt;").replaceAll(">", "&gt;"), { html: true });
        }
      },
    });
  const output = await rewriter.transform(new Response(html)).text();
  return output.trim();
}
