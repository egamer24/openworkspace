import {
  AnnotationMode,
  getDocument,
  GlobalWorkerOptions,
  version,
} from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
// oxlint-disable-next-line import/default -- Vite's ?url import has a default export
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  EventBus,
  PDFViewer,
  PDFLinkService,
  PDFFindController,
  LinkTarget,
} from "pdfjs-dist/web/pdf_viewer.mjs";
import { useEffect, useRef, useState } from "react";

import { pdfjsAssetUrls } from "../../shared/pdfjs-assets";

GlobalWorkerOptions.workerSrc = workerUrl;

export function usePdfViewer(url: string) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<PDFViewer | null>(null);
  const [viewer, setViewer] = useState<PDFViewer | null>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState({ current: 0, total: 0 });

  useEffect(() => {
    const container = containerRef.current;
    const pages = pagesRef.current;

    if (!container || !pages) return;
    const lifetime = new AbortController();
    const eventBus = new EventBus();

    const linkService = new PDFLinkService({
      eventBus,
      externalLinkTarget: LinkTarget.BLANK,
    });

    const findController = new PDFFindController({ eventBus, linkService });

    const options = {
      container,
      viewer: pages,
      eventBus,
      linkService,
      findController,
      // Read-only attachments: no form editing, document scripts, or automatic downloads.
      annotationMode: AnnotationMode.ENABLE,
      maxCanvasPixels: 16_777_216,
      abortSignal: lifetime.signal,
    };

    const pdfViewer = new PDFViewer(options);
    viewerRef.current = pdfViewer;
    linkService.setViewer(pdfViewer);

    // Re-fit when the viewport changes. PDFViewer's
    // own observer updates dimensions, but does not recalculate named zoom levels.
    const resize = new ResizeObserver(() => {
      if (!pdfViewer.pdfDocument) return;

      if (pdfViewer.currentScaleValue === "page-width") {
        pdfViewer.currentScaleValue = "page-width";
      }

      pdfViewer.update();
    });

    resize.observe(container);
    const listenerOptions = { signal: lifetime.signal };
    eventBus.on(
      "pagesinit",
      () => {
        pdfViewer.currentScaleValue = "page-width";
        setReady(true);
      },
      listenerOptions
    );
    eventBus.on(
      "pagechanging",
      ({ pageNumber }: { pageNumber: number }) => setPage(pageNumber),
      listenerOptions
    );
    eventBus.on(
      "scalechanging",
      ({ scale: nextScale }: { scale: number }) => setScale(nextScale),
      listenerOptions
    );

    const updateMatches = ({
      matchesCount,
    }: {
      matchesCount: { current: number; total: number };
    }) => setMatches(matchesCount);

    eventBus.on("updatefindmatchescount", updateMatches, listenerOptions);
    eventBus.on("updatefindcontrolstate", updateMatches, listenerOptions);
    eventBus.on(
      "pagerendered",
      ({ error: renderError }: { error?: Error }) => {
        if (renderError) setError("Could not render this PDF");
      },
      listenerOptions
    );

    const task = getDocument({
      url,
      ...pdfjsAssetUrls(version),
      enableXfa: false,
    });

    void task.promise
      .then(async (pdf) => {
        if (lifetime.signal.aborted) return;
        linkService.setDocument(pdf);
        pdfViewer.setDocument(pdf);
        setViewer(pdfViewer);
        setDocument(pdf);
        // PDFViewer reports initialization failures via its pages promise.
        await pdfViewer.pagesPromise;
      })
      .catch((cause: unknown) => {
        if (lifetime.signal.aborted) return;
        setError(
          cause instanceof Error && cause.name === "PasswordException"
            ? "This PDF requires a password"
            : "Could not open this PDF"
        );
      });

    return () => {
      resize.disconnect();
      lifetime.abort();

      // SAFETY: PDF.js explicitly accepts null to detach (setDocument checks
      // for it); its generated declaration omits null.
      const detach = pdfViewer.setDocument as (
        document: PDFDocumentProxy | null
      ) => void;

      detach.call(pdfViewer, null);
      linkService.setDocument(null);
      viewerRef.current = null;
      void task.destroy();
    };
  }, [url]);

  function find(query: string, again = false, previous = false) {
    viewerRef.current?.eventBus.dispatch("find", {
      source: containerRef.current,
      type: again ? "again" : "",
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: previous,
      matchDiacritics: false,
    });
  }

  /** Moves to a page in range; returns the page shown afterwards. */
  function goToPage(target: number) {
    const { current } = viewerRef;

    if (!current) return 1;

    if (
      Number.isInteger(target) &&
      target >= 1 &&
      target <= current.pagesCount
    ) {
      current.currentPageNumber = target;
    }

    return current.currentPageNumber;
  }

  function zoomIn() {
    viewerRef.current?.increaseScale();
  }

  function zoomOut() {
    viewerRef.current?.decreaseScale();
  }

  function fitWidth() {
    if (viewerRef.current) viewerRef.current.currentScaleValue = "page-width";
  }

  return {
    containerRef,
    pagesRef,
    viewer,
    document,
    page,
    scale,
    ready,
    error,
    matches,
    find,
    goToPage,
    zoomIn,
    zoomOut,
    fitWidth,
  };
}
