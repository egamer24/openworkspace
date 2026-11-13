import { ApiError } from "@open-workspace/core/ui";
import { useEffect, useRef } from "react";
import type { RefObject } from "react";

const READ_VISIBILITY_DELAY_MS = 400;
const READ_RETRY_DELAY_MS = 2000;
const MAX_READ_ATTEMPTS = 2;
const MIN_VISIBLE_HEIGHT_PX = 120;

/** Marks a message only after a meaningful part of it remains on screen. */
export function useVisibleMessageRead({
  enabled,
  messageId,
  onVisible,
}: {
  enabled: boolean;
  messageId: string;
  onVisible: () => Promise<void>;
}): RefObject<HTMLElement | null> {
  const element = useRef<HTMLElement>(null);
  const onVisibleRef = useRef(onVisible);
  const reportedMessageId = useRef<string | null>(null);

  useEffect(() => {
    onVisibleRef.current = onVisible;
  }, [onVisible]);

  useEffect(() => {
    if (!enabled || reportedMessageId.current === messageId) return;
    const target = element.current;

    if (!target) return;

    let intersecting = false;
    let pending = false;
    let attempts = 0;
    let stopped = false;
    let visibleTimer: ReturnType<typeof setTimeout> | undefined;

    const isVisible = () =>
      intersecting && document.visibilityState === "visible";

    const scheduleRead = (delay: number) => {
      clearTimeout(visibleTimer);

      if (!isVisible() || pending || stopped) return;
      visibleTimer = setTimeout(async () => {
        visibleTimer = undefined;

        if (!isVisible() || stopped) return;
        pending = true;
        attempts += 1;

        try {
          await onVisibleRef.current();

          if (stopped) return;
          reportedMessageId.current = messageId;
          observer.disconnect();
        } catch (error) {
          pending = false;
          const retryable = !(error instanceof ApiError) || error.status >= 500;

          if (
            retryable &&
            attempts < MAX_READ_ATTEMPTS &&
            isVisible() &&
            !stopped
          ) {
            scheduleRead(READ_RETRY_DELAY_MS);
          }

          return;
        }

        pending = false;
      }, delay);
    };

    const targetHeight = Math.max(target.getBoundingClientRect().height, 1);

    const visibilityThreshold = Math.min(
      0.5,
      MIN_VISIBLE_HEIGHT_PX / targetHeight
    );

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;

        const requiredHeight = Math.min(
          MIN_VISIBLE_HEIGHT_PX,
          entry.boundingClientRect.height * 0.5
        );

        intersecting =
          entry.isIntersecting &&
          entry.intersectionRect.height >= requiredHeight;

        if (!isVisible()) {
          clearTimeout(visibleTimer);
          visibleTimer = undefined;

          return;
        }

        if (!visibleTimer && !pending) scheduleRead(READ_VISIBILITY_DELAY_MS);
      },
      {
        rootMargin: "-8% 0px -8% 0px",
        threshold: [0, visibilityThreshold],
      }
    );

    observer.observe(target);

    const handleDocumentVisibility = () => {
      clearTimeout(visibleTimer);
      visibleTimer = undefined;

      if (isVisible() && !pending) scheduleRead(READ_VISIBILITY_DELAY_MS);
    };

    document.addEventListener("visibilitychange", handleDocumentVisibility);

    return () => {
      stopped = true;
      clearTimeout(visibleTimer);
      document.removeEventListener(
        "visibilitychange",
        handleDocumentVisibility
      );
      observer.disconnect();
    };
  }, [enabled, messageId]);

  return element;
}
