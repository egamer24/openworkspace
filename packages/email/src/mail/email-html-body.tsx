import { Skeleton, cn } from "@open-workspace/core/ui";
import { useEffect, useRef, useState } from "react";

import { translatedEmailHtml } from "./translation-html";
import type { MessageDetail } from "./types";
import { useSanitizedEmailHtml } from "./use-sanitized-email-html";

/** Reading measure and rhythm shared by plain-text bodies. */
export const messageTextClassName =
  "max-w-[72ch] whitespace-pre-wrap text-[14.5px] leading-[1.7] [overflow-wrap:anywhere]";

const MIN_FRAME_HEIGHT = 48;

// Bounds a runaway document; real emails render at full height without an
// inner scrollbar.
const MAX_FRAME_HEIGHT = 20_000;

export function EmailHtmlBody({
  mailboxId,
  message,
  translations,
}: {
  mailboxId: string;
  message: MessageDetail;
  translations?: string[];
}) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const frameObserver = useRef<ResizeObserver | null>(null);

  // The document the frame finished loading and laid out, and its height.
  const [loadedFrame, setLoadedFrame] = useState<{
    srcDoc: string;
    height: number;
  } | null>(null);

  const html = useSanitizedEmailHtml(mailboxId, message);

  const composerHtml =
    translations && message.direction === "outgoing" && html.data?.composerHtml
      ? translatedEmailHtml(html.data.composerHtml, translations, false)
      : html.data?.composerHtml;

  const srcDoc =
    translations && message.direction === "incoming" && html.data?.srcDoc
      ? translatedEmailHtml(html.data.srcDoc, translations, true)
      : html.data?.srcDoc;

  // A new document shows the skeleton until it has loaded and been fitted.
  const fitted = srcDoc && loadedFrame?.srcDoc === srcDoc ? loadedFrame : null;
  const frameReady = fitted !== null;
  const height = fitted?.height ?? MIN_FRAME_HEIGHT;

  useEffect(
    () => () => {
      frameObserver.current?.disconnect();
      frameObserver.current = null;
    },
    []
  );

  function observeFrameSize() {
    const frame = iframe.current;
    const document = frame?.contentDocument;

    if (!frame || !document || !srcDoc) return;
    const loadedSrcDoc = srcDoc;

    // Fixed-width newsletters (often 600–700px) are scaled down to the pane,
    // like desktop mail clients do, instead of being clipped on the right.
    let scale = 1;

    const updateHeight = () => {
      const { body } = document;

      if (!body) return;
      const contentHeight = Math.max(body.scrollHeight, body.offsetHeight);
      setLoadedFrame({
        srcDoc: loadedSrcDoc,
        height: Math.min(
          MAX_FRAME_HEIGHT,
          Math.max(MIN_FRAME_HEIGHT, Math.ceil(contentHeight * scale))
        ),
      });
    };

    const updateLayout = () => {
      const { body } = document;

      if (!body) return;

      for (const property of [
        "transform",
        "transform-origin",
        "width",
        "max-width",
      ]) {
        body.style.removeProperty(property);
      }

      const available = frame.clientWidth;
      let natural = body.scrollWidth;

      if (available > 0 && natural > available) {
        // The sanitizer pins the body to 100% with !important, so widen it
        // the same way, then measure again: tables capped at 100% can grow.
        body.style.setProperty("max-width", "none", "important");
        body.style.setProperty("width", `${natural}px`, "important");
        natural = Math.max(natural, body.scrollWidth);
        body.style.setProperty("width", `${natural}px`, "important");
      }

      scale = available > 0 && natural > available ? available / natural : 1;

      if (scale < 1) {
        body.style.setProperty("transform-origin", "0 0");
        body.style.setProperty("transform", `scale(${scale})`);
      }

      updateHeight();
    };

    frameObserver.current?.disconnect();
    updateLayout();
    let lastWidth = frame.clientWidth;
    frameObserver.current = new ResizeObserver((entries) => {
      // A new frame width (pane splitter, window) needs a new fit; content
      // changes inside the body (late images, fonts) only change the height.
      if (
        entries.some((entry) => entry.target === frame) &&
        frame.clientWidth !== lastWidth
      ) {
        lastWidth = frame.clientWidth;
        updateLayout();
      } else {
        updateHeight();
      }
    });
    frameObserver.current.observe(frame);
    frameObserver.current.observe(document.body ?? document.documentElement);
    // Shown now, measured or not (a document without a body has no height yet).
    setLoadedFrame((current) =>
      current?.srcDoc === loadedSrcDoc
        ? current
        : { srcDoc: loadedSrcDoc, height: MIN_FRAME_HEIGHT }
    );
  }

  const fallback = (
    <div className={messageTextClassName}>
      {message.bodyText || message.preview || "No text body"}
    </div>
  );

  if (html.isPending) {
    return <BodySkeleton />;
  }

  if (message.direction === "outgoing") {
    return composerHtml ? (
      <div
        className="composer-message-body max-w-[72ch] text-[14.5px] leading-[1.7]"
        // oxlint-disable-next-line react/no-danger -- composerHtml is sanitized email HTML
        dangerouslySetInnerHTML={{ __html: composerHtml }}
      />
    ) : (
      fallback
    );
  }

  if (!html.data?.renderAsHtml || !srcDoc) return fallback;

  return (
    <div className="relative">
      {frameReady ? null : <BodySkeleton />}
      <iframe
        ref={iframe}
        className={cn(
          "dark:ring-border block w-full overflow-hidden rounded-md bg-white dark:ring-1",
          frameReady
            ? "relative opacity-100"
            : "pointer-events-none absolute inset-x-0 top-0 h-0 opacity-0"
        )}
        style={frameReady ? { height } : undefined}
        title={`HTML body of ${message.subject}`}
        sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
        referrerPolicy="no-referrer"
        srcDoc={srcDoc}
        onLoad={observeFrameSize}
      />
    </div>
  );
}

function BodySkeleton() {
  return (
    <div aria-hidden="true" className="max-w-[72ch] space-y-2.5 py-1">
      <Skeleton className="h-3.5 w-11/12" />
      <Skeleton className="h-3.5 w-full" />
      <Skeleton className="h-3.5 w-4/5" />
      <Skeleton className="h-3.5 w-2/5" />
    </div>
  );
}
