import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@open-workspace/core/ui";
import { ChevronDown, Languages, LoaderCircle } from "lucide-react";

import { languageName } from "./message-translation";
import { PdfPreviewToolbar } from "./pdf-preview-toolbar";
import { COMMON_LANGUAGES } from "./translation-language";
import { usePdfTranslation } from "./use-pdf-translation";
import { usePdfTranslationOverlay } from "./use-pdf-translation-overlay";
import { usePdfViewer } from "./use-pdf-viewer";

import "pdfjs-dist/web/pdf_viewer.css";
import "./pdf-preview.css";

export default function PdfPreview({
  url,
  filename,
  messageId,
  mailboxId,
}: {
  url: string;
  filename: string;
  messageId: string;
  mailboxId: string;
}) {
  const { containerRef, pagesRef, ...pdf } = usePdfViewer(url);

  const { visible, setVisible, language, setLanguage, translation } =
    usePdfTranslation({
      document: pdf.document,
      page: pdf.page,
      url,
      messageId,
      mailboxId,
    });

  const overlayError = usePdfTranslationOverlay({
    viewer: pdf.viewer,
    document: pdf.document,
    page: pdf.page,
    layout: visible ? translation.data : null,
    language,
  });

  const languages = COMMON_LANGUAGES.includes(language)
    ? COMMON_LANGUAGES
    : [language, ...COMMON_LANGUAGES];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PdfPreviewToolbar
        pdf={{
          ...pdf,
          find: (...args) => {
            setVisible(false);
            pdf.find(...args);
          },
        }}
      />
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5">
        <Button
          size="xs"
          variant="ghost"
          disabled={!pdf.ready || Boolean(pdf.error)}
          onClick={() => setVisible(!visible)}
        >
          {visible && translation.isFetching ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <Languages />
          )}
          {visible ? "Show original" : "Translate"}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button size="xs" variant="outline" className="max-w-40" />}
            aria-label={`PDF translation language: ${languageName(language)}`}
          >
            <span className="truncate">{languageName(language)}</span>
            <ChevronDown data-icon="inline-end" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 w-48">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Translation language</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={language}
                onValueChange={(code: string) => setLanguage(code)}
              >
                {languages.map((code) => (
                  <DropdownMenuRadioItem key={code} value={code} closeOnClick>
                    {languageName(code)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {visible && (translation.isError || overlayError) && (
          <div role="alert" className="flex items-center gap-2 text-xs">
            {overlayError ?? translation.error?.message}
            {translation.isError && (
              <Button
                size="xs"
                variant="outline"
                disabled={translation.isFetching}
                onClick={() => void translation.refetch()}
              >
                Retry
              </Button>
            )}
          </div>
        )}
        {visible && translation.data === null && (
          <span role="status" className="text-muted-foreground text-xs">
            No selectable text on this page
          </span>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="bg-surface-sunken relative min-h-0 min-w-0 flex-1">
          <div
            ref={containerRef}
            className="attachment-pdf-container absolute inset-0 overflow-auto"
            role="region"
            aria-label={`PDF: ${filename}`}
            // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the scroll region takes focus for keyboard scrolling
            tabIndex={0}
          >
            <div ref={pagesRef} className="pdfViewer" />
          </div>
          {(!pdf.ready || pdf.error) && (
            <div
              role="status"
              className="bg-surface-sunken text-muted-foreground absolute inset-0 grid place-content-center justify-items-center gap-3 p-6"
            >
              {pdf.error ?? (
                <>
                  <LoaderCircle className="size-6 animate-spin" />
                  <span className="sr-only">Loading PDF</span>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
