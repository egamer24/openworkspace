/**
 * The resources PDF.js requests by filename (CMaps for CJK text, standard
 * fonts, the JPEG 2000 decoder, ICC profiles): `Email()` copies each folder
 * of pdfjs-dist into the browser app at `pdfjsAssetPath(version, folder)`,
 * and the PDF viewer asks for them there.
 */
export const pdfjsAssetFolders = {
  cMapUrl: "cmaps",
  standardFontDataUrl: "standard_fonts",
  wasmUrl: "wasm",
  iccUrl: "iccs",
} as const;

export type PdfjsAssetFolder =
  (typeof pdfjsAssetFolders)[keyof typeof pdfjsAssetFolders];

/** Where a folder of PDF.js `version`'s resources is served, relative to the app's root. */
export function pdfjsAssetPath(version: string, folder: PdfjsAssetFolder) {
  return `pdfjs/${version}/${folder}`;
}

/** `getDocument`'s options that point PDF.js at its resources. */
export function pdfjsAssetUrls(
  version: string
): Record<keyof typeof pdfjsAssetFolders, string> {
  const url = (folder: PdfjsAssetFolder) =>
    `/${pdfjsAssetPath(version, folder)}/`;

  return {
    cMapUrl: url(pdfjsAssetFolders.cMapUrl),
    standardFontDataUrl: url(pdfjsAssetFolders.standardFontDataUrl),
    wasmUrl: url(pdfjsAssetFolders.wasmUrl),
    iccUrl: url(pdfjsAssetFolders.iccUrl),
  };
}
