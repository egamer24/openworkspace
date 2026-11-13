const SKIP_TEXT_IN = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

function textNodes(root: Node): Text[] {
  const nodes: Text[] = [];

  function visit(node: Node) {
    if (node instanceof Text) {
      if (node.data.trim()) nodes.push(node);

      return;
    }

    if (node instanceof Element && SKIP_TEXT_IN.has(node.tagName)) return;

    for (const child of Array.from(node.childNodes)) visit(child);
  }

  visit(root);

  return nodes;
}

export function emailHtmlTextSegments(html: string) {
  const document = new DOMParser().parseFromString(html, "text/html");

  return textNodes(document.body).map((node) => node.data.trim());
}

export function translatedEmailHtml(
  html: string,
  translations: string[],
  fullDocument: boolean
) {
  const document = new DOMParser().parseFromString(html, "text/html");
  const nodes = textNodes(document.body);

  if (nodes.length !== translations.length) return null;
  nodes.forEach((node, index) => {
    const original = node.textContent ?? "";
    const leading = original.match(/^\s*/u)?.[0] ?? "";
    const trailing = original.match(/\s*$/u)?.[0] ?? "";
    // textContent keeps model output inert while the original elements and attributes survive.
    node.textContent = leading + translations[index] + trailing;
  });

  return fullDocument
    ? `<!doctype html>${document.documentElement.outerHTML}`
    : document.body.innerHTML;
}
