import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";

/** How far the fade reaches in from a clipped edge; scrolling keeps the active item clear of it. */
export const SCROLL_FADE = 20;

/**
 * A mask fading whichever end of a horizontal scroller has content out of
 * sight; none when everything fits. It re-measures on scrolling, resizing and
 * items coming or going.
 */
export function useEdgeFade(
  scroller: RefObject<HTMLElement | null>
): CSSProperties | undefined {
  const [edges, setEdges] = useState({ start: false, end: false });
  useEffect(() => {
    const element = scroller.current;

    if (!element) return;

    const update = () => {
      const max = element.scrollWidth - element.clientWidth;
      const start = element.scrollLeft > 1;
      const end = element.scrollLeft < max - 1;
      setEdges((current) =>
        current.start === start && current.end === end
          ? current
          : { start, end }
      );
    };

    update();
    element.addEventListener("scroll", update, { passive: true });
    const resizes = new ResizeObserver(update);
    resizes.observe(element);

    for (const child of element.children) resizes.observe(child);

    const items = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element) resizes.observe(node);
        }
      }

      update();
    });

    items.observe(element, { childList: true });

    return () => {
      element.removeEventListener("scroll", update);
      resizes.disconnect();
      items.disconnect();
    };
  }, [scroller]);

  if (!edges.start && !edges.end) return undefined;
  const mask = `linear-gradient(to right, ${edges.start ? "transparent" : "#000"}, #000 ${SCROLL_FADE}px, #000 calc(100% - ${SCROLL_FADE}px), ${edges.end ? "transparent" : "#000"})`;

  return { maskImage: mask, WebkitMaskImage: mask };
}

/**
 * Brings the item matching `selector` into view, clear of the fades: at once
 * on first layout, smoothly when `key` (which item is active) changes, unless
 * motion is reduced.
 */
export function useActiveInView(
  scroller: RefObject<HTMLElement | null>,
  key: string | number,
  selector = "[data-active]"
) {
  const placedKey = useRef<string | number | null>(null);
  useLayoutEffect(() => {
    const element = scroller.current;
    const active = element?.querySelector<HTMLElement>(selector);

    if (!element || !active) return;
    const left = active.offsetLeft - SCROLL_FADE;

    const right =
      active.offsetLeft +
      active.offsetWidth +
      SCROLL_FADE -
      element.clientWidth;

    const target =
      left < element.scrollLeft
        ? left
        : right > element.scrollLeft
          ? right
          : null;

    const smooth =
      placedKey.current !== null &&
      placedKey.current !== key &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    placedKey.current = key;

    if (target === null) return;
    element.scrollTo({
      left: Math.max(0, target),
      behavior: smooth ? "smooth" : "instant",
    });
  }, [scroller, key, selector]);
}
