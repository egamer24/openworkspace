import { Languages, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PdfPreviewToolbar } from "./pdf-preview-toolbar";
import { usePdfViewer } from "./use-pdf-viewer";
import { usePdfTranslationOverlay } from "./use-pdf-translation-overlay";
import { usePdfTranslation } from "./use-pdf-translation";
import { browserLanguage, COMMON_LANGUAGES } from "./translation-language";
import "pdfjs-dist/web/pdf_viewer.css";
import "./pdf-preview.css";

/** Translation is offered only for mail attachments, through the message's mailbox. */
export default function PdfPreview({ url, filename, messageId, mailboxId }: {
  url: string;
  filename: string;
  messageId?: string;
  mailboxId?: string;
}) {
  const pdf = usePdfViewer(url);
  const { visible, setVisible, language, setLanguage, translation } = usePdfTranslation({
    document: pdf.document, page: pdf.page, url, messageId: messageId ?? "", mailboxId: mailboxId ?? "",
  });
  const overlayError = usePdfTranslationOverlay({
    viewer: pdf.viewerRef.current, document: pdf.document, page: pdf.page,
    layout: visible ? translation.data : null, language,
  });
  const languages = COMMON_LANGUAGES.includes(language) ? COMMON_LANGUAGES : [language, ...COMMON_LANGUAGES];
  const displayNames = new Intl.DisplayNames([browserLanguage()], { type: "language" });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PdfPreviewToolbar pdf={{ ...pdf, find: (...args) => { setVisible(false); pdf.find(...args); } }} />
      {messageId && <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5">
        <Button size="xs" variant="ghost" disabled={!pdf.ready || Boolean(pdf.error)} onClick={() => setVisible(!visible)}>
          {visible && translation.isFetching ? <LoaderCircle className="animate-spin" /> : <Languages />}
          {visible ? "Show original" : "Translate"}
        </Button>
        <select
          aria-label="PDF translation language" value={language}
          className="h-7 max-w-40 rounded-md border bg-transparent px-1.5 text-xs"
          onChange={(event) => setLanguage(event.target.value)}
        >
          {languages.map((code) => <option key={code} value={code}>{displayNames.of(code) ?? code}</option>)}
        </select>
        {visible && (translation.isError || overlayError) && (
          <div role="alert" className="flex items-center gap-2 text-xs">
            {overlayError ?? translation.error?.message}
            {translation.isError && <Button size="xs" variant="outline" disabled={translation.isFetching} onClick={() => void translation.refetch()}>Retry</Button>}
          </div>
        )}
        {visible && translation.data === null && <span role="status" className="text-xs text-muted-foreground">No selectable text on this page</span>}
      </div>}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="relative min-h-0 min-w-0 flex-1 bg-surface-sunken">
          <div ref={pdf.containerRef} className="attachment-pdf-container absolute inset-0 overflow-auto" role="region" aria-label={`PDF: ${filename}`} tabIndex={0}>
            <div ref={pdf.pagesRef} className="pdfViewer" />
          </div>
          {(!pdf.ready || pdf.error) && (
            <div role="status" className="absolute inset-0 grid place-content-center justify-items-center gap-3 bg-surface-sunken p-6 text-muted-foreground">
              {pdf.error ?? <><LoaderCircle className="size-6 animate-spin" /><span className="sr-only">Loading PDF</span></>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
