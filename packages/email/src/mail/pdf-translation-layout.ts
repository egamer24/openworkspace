import { AnnotationMode, OPS, Util } from "pdfjs-dist";
import type { PDFPageProxy } from "pdfjs-dist";
import { z } from "zod";

type PdfTextBlock = {
  text: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  translate: boolean;
};

/** A PDF.js font object; only its name is read. */
const namedFont = z.object({ name: z.string() });

const textOperations = new Set<number>([
  OPS.showText,
  OPS.showSpacedText,
  OPS.nextLineShowText,
  OPS.nextLineSetSpacingShowText,
]);

export async function getPdfTranslationLayout(page: PDFPageProxy) {
  const [content, operators] = await Promise.all([
    page.getTextContent(),
    page.getOperatorList({ annotationMode: AnnotationMode.DISABLE }),
  ]);

  // Text used as a clipping path cannot be removed without changing the graphics.
  // Invisible OCR text also needs a different approach: the scan already contains text.
  if (
    operators.fnArray.some(
      (op, i) =>
        op === OPS.setTextRenderingMode && operators.argsArray[i][0] !== 0
    )
  ) {
    throw new Error(
      "Inline translation is unavailable for this page's text rendering"
    );
  }

  const viewport = page.getViewport({ scale: 1 });
  const blocks: PdfTextBlock[] = [];

  for (const item of content.items) {
    if (!("str" in item) || !item.str.trim()) continue;
    const style = content.styles[item.fontName];
    const transform = Util.transform(viewport.transform, item.transform);

    if (
      style.vertical ||
      Math.abs(transform[1]) > 0.01 ||
      Math.abs(transform[2]) > 0.01 ||
      transform[0] <= 0 ||
      transform[3] >= 0
    ) {
      throw new Error("Inline translation is unavailable for rotated text");
    }

    const fontSize = Math.abs(transform[3]);
    const font = namedFont.safeParse(page.commonObjs.get(item.fontName));
    const fontName = font.success ? font.data.name : "";

    blocks.push({
      text: item.str,
      x: transform[4],
      y: transform[5] - (style.ascent ?? 0.8) * fontSize,
      width: Math.max(item.width, 1),
      fontSize,
      fontFamily: style.fontFamily,
      bold: /bold|black|heavy/iu.test(fontName),
      italic: /italic|oblique/iu.test(fontName),
      translate: /\p{L}/u.test(item.str),
    });
  }

  return {
    width: viewport.width,
    height: viewport.height,
    blocks,
    // Use the public render filter instead of covering glyphs with rectangles;
    // PDF backgrounds, logos and table rules retain their original paint order.
    omittedOperations: operators.fnArray.flatMap((op, i) =>
      textOperations.has(op) ? [i] : []
    ),
  };
}

export type PdfTranslationLayout = Awaited<
  ReturnType<typeof getPdfTranslationLayout>
>;
