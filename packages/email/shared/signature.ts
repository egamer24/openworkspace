/**
 * A signature's HTML with `{name}` replaced by the sender's display name,
 * escaped, so a team inbox's replies all read alike. The composer fills it in
 * when it inserts a signature; the Worker when an API caller asks for one.
 */
export function signatureHtmlWithName(html: string, name: string) {
  const escaped = name
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  return html.replaceAll("{name}", escaped);
}
