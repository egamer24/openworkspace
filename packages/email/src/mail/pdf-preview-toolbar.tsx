import { Button } from "@open-workspace/core/ui";
import { ChevronLeft, ChevronRight, Minus, Plus, Search } from "lucide-react";
import { useState } from "react";

import type { usePdfViewer } from "./use-pdf-viewer";

export function PdfPreviewToolbar({
  pdf,
}: {
  pdf: Omit<ReturnType<typeof usePdfViewer>, "containerRef" | "pagesRef">;
}) {
  const [pageInput, setPageInput] = useState(() => String(pdf.page));
  const [shownPage, setShownPage] = useState(pdf.page);
  const [query, setQuery] = useState("");

  // Turning the page (scrolling, the arrows) replaces whatever was typed.
  if (shownPage !== pdf.page) {
    setShownPage(pdf.page);
    setPageInput(String(pdf.page));
  }

  const disabled = !pdf.ready || Boolean(pdf.error);
  const pages = pdf.document?.numPages ?? 0;

  function goToPage(page: number) {
    setPageInput(String(pdf.goToPage(page)));
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2">
      <div className="flex items-center gap-1">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Previous page"
          disabled={disabled || pdf.page <= 1}
          onClick={() => goToPage(pdf.page - 1)}
        >
          <ChevronLeft />
        </Button>
        <input
          aria-label="Page number"
          inputMode="numeric"
          className="h-7 w-12 rounded border bg-transparent text-center text-xs tabular-nums"
          value={pageInput}
          disabled={disabled}
          onChange={(event) => setPageInput(event.target.value)}
          onBlur={() => goToPage(Number(pageInput))}
          onKeyDown={(event) => {
            if (event.key === "Enter") goToPage(Number(pageInput));
          }}
        />
        <span className="text-muted-foreground text-xs tabular-nums">
          / {pages || "—"}
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Next page"
          disabled={disabled || pdf.page >= pages}
          onClick={() => goToPage(pdf.page + 1)}
        >
          <ChevronRight />
        </Button>
      </div>
      <div className="flex items-center gap-1">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Zoom out"
          disabled={disabled}
          onClick={pdf.zoomOut}
        >
          <Minus />
        </Button>
        <span
          aria-label="Zoom level"
          className="w-10 text-center text-xs tabular-nums"
        >
          {Math.round(pdf.scale * 100)}%
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Zoom in"
          disabled={disabled}
          onClick={pdf.zoomIn}
        >
          <Plus />
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={disabled}
          onClick={pdf.fitWidth}
        >
          Fit width
        </Button>
      </div>
      <div
        role="search"
        className="flex w-full min-w-0 items-center gap-1 sm:ml-auto sm:w-auto sm:max-w-80 sm:flex-1"
      >
        <Search className="text-muted-foreground size-3.5 shrink-0" />
        <input
          type="search"
          aria-label="Find in PDF"
          placeholder="Find in document"
          className="focus-visible:ring-ring h-7 min-w-0 flex-1 bg-transparent text-xs outline-none focus-visible:ring-2"
          value={query}
          disabled={disabled}
          onChange={(event) => {
            setQuery(event.target.value);
            pdf.find(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              pdf.find(query, true, event.shiftKey);
            }
          }}
        />
        {query && (
          <span
            role="status"
            className="text-muted-foreground text-xs whitespace-nowrap tabular-nums"
          >
            {pdf.matches.current} / {pdf.matches.total}
          </span>
        )}
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Previous match"
          disabled={disabled || !query || !pdf.matches.total}
          onClick={() => pdf.find(query, true, true)}
        >
          <ChevronLeft />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Next match"
          disabled={disabled || !query || !pdf.matches.total}
          onClick={() => pdf.find(query, true)}
        >
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
