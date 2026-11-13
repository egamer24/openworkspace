import { useCallback, useState } from "react";
import type { RefObject } from "react";

const STORAGE_KEY = "openworkspace.mail.list-width";
const DEFAULT_WIDTH = 608;
const MIN_WIDTH = 320;

// The reading pane keeps at least this much room beside the list.
const READER_MIN_WIDTH = 416;
const KEY_STEP = 32;

function readWidth() {
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY));

    return Number.isFinite(stored) && stored >= MIN_WIDTH
      ? stored
      : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

/** List pane width in pixels, remembered per browser. */
export function useListWidth() {
  const [storedWidth, setStoredWidth] = useState(readWidth);

  const rememberWidth = useCallback((next: number) => {
    setStoredWidth(next);

    try {
      localStorage.setItem(STORAGE_KEY, String(Math.round(next)));
    } catch {
      // Preference only.
    }
  }, []);

  return [storedWidth, rememberWidth] as const;
}

/** Draggable, keyboard-adjustable gap between the list and reading panes. */
export function PaneSplitter({
  containerRef,
  width,
  onWidthChange,
}: {
  containerRef: RefObject<HTMLElement | null>;
  width: number;
  onWidthChange: (width: number) => void;
}) {
  const [dragging, setDragging] = useState(false);

  function clamp(next: number) {
    const containerWidth =
      containerRef.current?.clientWidth ?? next + READER_MIN_WIDTH;

    return Math.max(
      MIN_WIDTH,
      Math.min(next, containerWidth - READER_MIN_WIDTH)
    );
  }

  // The rendered width can be narrower than the stored one on small screens.
  function renderedWidth() {
    const list = containerRef.current?.firstElementChild;

    return list instanceof HTMLElement ? list.offsetWidth : width;
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize conversation list"
      aria-valuemin={MIN_WIDTH}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      data-dragging={dragging || undefined}
      onPointerDown={(event) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = renderedWidth();
        const target = event.currentTarget;
        target.setPointerCapture(event.pointerId);
        setDragging(true);

        const onMove = (moveEvent: PointerEvent) => {
          onWidthChange(clamp(startWidth + moveEvent.clientX - startX));
        };

        const onUp = () => {
          setDragging(false);
          target.removeEventListener("pointermove", onMove);
          target.removeEventListener("pointerup", onUp);
          target.removeEventListener("pointercancel", onUp);
        };

        target.addEventListener("pointermove", onMove);
        target.addEventListener("pointerup", onUp);
        target.addEventListener("pointercancel", onUp);
      }}
      onDoubleClick={() => onWidthChange(clamp(DEFAULT_WIDTH))}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const delta = event.key === "ArrowLeft" ? -KEY_STEP : KEY_STEP;
        onWidthChange(clamp(renderedWidth() + delta));
      }}
      className="group relative z-10 hidden w-2.5 shrink-0 cursor-col-resize touch-none rounded-full outline-none lg:block"
    >
      <span
        aria-hidden="true"
        className="bg-foreground/0 group-hover:bg-foreground/20 group-focus-visible:bg-primary group-data-dragging:bg-primary absolute top-1/2 left-1/2 h-10 w-1 -translate-1/2 rounded-full transition-[height,background-color] group-focus-visible:h-16 group-data-dragging:h-16"
      />
    </div>
  );
}
