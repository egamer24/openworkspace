// Light, dark, or the system's theme. The head script in layout.astro sets
// the .dark class before the first paint; this keeps it up to date when the
// toggle is pressed or the system's theme changes, and makes the pictures
// that come in a light and a dark version follow it too.

type Theme = "light" | "dark";

const storageKey = "openworkspace-theme";
const system = matchMedia("(prefers-color-scheme: dark)");
const schemeQuery = /\(prefers-color-scheme:\s*(light|dark)\)/gu;

function stored(): Theme | undefined {
  try {
    const value = localStorage.getItem(storageKey);

    return value === "light" || value === "dark" ? value : undefined;
  } catch {
    return undefined;
  }
}

function store(theme: Theme | undefined) {
  try {
    if (theme === undefined) localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, theme);
  } catch {
    // Private windows may refuse storage; the theme still changes for this page.
  }
}

function systemTheme(): Theme {
  return system.matches ? "dark" : "light";
}

/** A picture's <source media> follows the page's theme, not the system's. */
function syncPictures(theme: Theme, chosen: boolean) {
  const changed = new Set<HTMLPictureElement>();

  for (const source of document.querySelectorAll<HTMLSourceElement>(
    "source[media*='prefers-color-scheme']"
  )) {
    source.dataset.media ??= source.media;

    const original = source.dataset.media;

    const media = chosen
      ? original.replaceAll(schemeQuery, (_match, scheme) =>
          scheme === theme ? "(min-width: 0px)" : "(max-width: -1px)"
        )
      : original;

    if (source.media === media) continue;
    source.media = media;

    if (source.parentElement instanceof HTMLPictureElement) {
      changed.add(source.parentElement);
    }
  }

  // Safari doesn't pick a picture's source again when a <source> media
  // changes; a fresh <img> makes every browser choose anew.
  for (const picture of changed) {
    const image = picture.querySelector("img");

    if (image) image.replaceWith(image.cloneNode(true));
  }
}

function apply() {
  const choice = stored();
  const theme = choice ?? systemTheme();
  const root = document.documentElement;

  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;

  for (const meta of document.querySelectorAll<HTMLMetaElement>(
    "meta[name='theme-color']"
  )) {
    meta.media = "";
    meta.content = getComputedStyle(document.body).backgroundColor;
  }

  for (const button of document.querySelectorAll("[data-theme-toggle]")) {
    button.setAttribute("aria-pressed", String(theme === "dark"));
  }

  syncPictures(theme, choice !== undefined);
}

/**
 * The toggle switches to the other theme. Landing on the system's own theme
 * forgets the choice, so the page follows the system again.
 */
function switchTheme() {
  const next: Theme = document.documentElement.classList.contains("dark")
    ? "light"
    : "dark";

  store(next === systemTheme() ? undefined : next);
  apply();
}

function onClick(event: MouseEvent) {
  if (
    event.target instanceof Element &&
    event.target.closest("[data-theme-toggle]")
  ) {
    switchTheme();
  }
}

/** Applies the theme and keeps it applied; layout.astro calls it once. */
export function initTheme() {
  document.addEventListener("click", onClick);
  system.addEventListener("change", apply);
  // Another tab changed the theme.
  addEventListener("storage", (event) => {
    if (event.key === storageKey) apply();
  });
  apply();
}
