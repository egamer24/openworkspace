import { AnnotationMode } from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import type { PDFPageView } from "pdfjs-dist/types/web/pdf_page_view";
import type { PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import { useEffect, useState } from "react";

import type { PdfTranslationLayout } from "./pdf-translation-layout";

export function usePdfTranslationOverlay({
  viewer,
  document,
  page,
  layout,
  language,
}: {
  viewer: PDFViewer | null;
  document: PDFDocumentProxy | null;
  page: number;
  layout: PdfTranslationLayout | null | undefined;
  language: string;
}) {
  // A failure belongs to the page and translation it happened for; another
  // one starts without it.
  const [failure, setFailure] = useState<{
    viewer: PDFViewer;
    document: PDFDocumentProxy;
    page: number;
    layout: PdfTranslationLayout;
    language: string;
  } | null>(null);

  const error =
    failure &&
    failure.viewer === viewer &&
    failure.document === document &&
    failure.page === page &&
    failure.layout === layout &&
    failure.language === language
      ? "Could not render the translated page"
      : null;

  useEffect(() => {
    if (!viewer || !document || !layout) return;
    let disposeRender = () => {};
    const lifetime = new AbortController();

    const render = () => {
      disposeRender();
      const view: PDFPageView | undefined = viewer.getPageView(page - 1);

      if (!view) return;
      let cancelled = false;
      let task: RenderTask | undefined;
      const overlay = window.document.createElement("section");
      overlay.className = "pdf-translation-overlay";
      overlay.setAttribute("aria-label", "PDF translation");
      overlay.lang = language;
      const canvas = window.document.createElement("canvas");
      canvas.setAttribute("aria-hidden", "true");
      overlay.appendChild(canvas);
      disposeRender = () => {
        cancelled = true;
        task?.cancel();
        overlay.remove();
        view.div.classList.remove("pdf-page-translated");
      };

      void (async () => {
        const pdfPage = await document.getPage(page);

        if (cancelled) return;
        const viewport = view.viewport.clone();

        const ratio = Math.min(
          window.devicePixelRatio || 1,
          2,
          Math.sqrt(16_777_216 / (viewport.width * viewport.height))
        );

        canvas.width = Math.ceil(viewport.width * ratio);
        canvas.height = Math.ceil(viewport.height * ratio);
        const omitted = new Set(layout.omittedOperations);
        task = pdfPage.render({
          canvas,
          viewport,
          transform: [ratio, 0, 0, ratio, 0, 0],
          annotationMode: AnnotationMode.DISABLE,
          operationsFilter: (index) => !omitted.has(index),
        });
        await task.promise;

        if (cancelled) return;
        const layer = window.document.createElement("div");
        layer.className = "pdf-translated-text";
        layer.style.width = `${layout.width}px`;
        layer.style.height = `${layout.height}px`;
        // PDF.js rounds page dimensions to device pixels. Match the canvas CSS size.
        layer.style.transform = `scale(${view.div.clientWidth / layout.width}, ${view.div.clientHeight / layout.height})`;

        const measure = window.document
          .createElement("canvas")
          .getContext("2d");

        if (!measure) throw new Error("No 2D canvas to measure text");

        for (const block of layout.blocks) {
          const span = window.document.createElement("span");
          span.textContent = block.text;
          span.dir = "auto";
          const font = `${block.italic ? "italic" : "normal"} ${block.bold ? "bold" : "normal"}`;
          measure.font = `${font} ${block.fontSize}px ${block.fontFamily}`;

          // Stay inside the source line's bounds so a longer translation cannot
          // overwrite neighbouring table cells. Preserve its vertical centre.
          const size =
            block.fontSize *
            Math.min(
              1,
              block.width / Math.max(1, measure.measureText(block.text).width)
            );

          Object.assign(span.style, {
            left: `${block.x}px`,
            top: `${block.y + (block.fontSize - size) / 2}px`,
            width: `${block.width}px`,
            font: `${font} ${size}px / 1 ${block.fontFamily}`,
          });
          layer.appendChild(span);
        }

        overlay.appendChild(layer);
        view.div.appendChild(overlay);
        view.div.classList.add("pdf-page-translated");
        setFailure(null);
      })().catch(() => {
        if (cancelled) return;
        disposeRender();
        setFailure({ viewer, document, page, layout, language });
      });
    };

    const rerender = ({ pageNumber }: { pageNumber: number }) => {
      if (pageNumber === page) render();
    };

    viewer.eventBus.on("pagerendered", rerender, { signal: lifetime.signal });
    render();

    return () => {
      lifetime.abort();
      disposeRender();
    };
  }, [viewer, document, page, layout, language]);

  return error;
}
