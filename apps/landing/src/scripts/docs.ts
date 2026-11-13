// The docs pages' behaviour: the menu drawer on small screens, "On this
// page" following the section in view, and the code blocks' copy buttons.
// Search is in search.ts.

const wide = matchMedia("(min-width: 1024px)");

function setUpDrawer() {
  const drawer = document.querySelector<HTMLDialogElement>("#docs-drawer");
  const openers = document.querySelectorAll<HTMLElement>("[data-drawer-open]");

  if (!drawer) return;

  const setExpanded = (expanded: boolean) => {
    for (const opener of openers) {
      opener.setAttribute("aria-expanded", String(expanded));
    }
  };

  for (const opener of openers) {
    opener.addEventListener("click", () => {
      drawer.showModal();
      setExpanded(true);
    });
  }

  drawer.addEventListener("close", () => setExpanded(false));
  drawer.addEventListener("click", (event) => {
    const { target } = event;

    // A click on the backdrop lands on the dialog itself.
    if (target === drawer) drawer.close();

    if (!(target instanceof Element)) return;

    if (target.closest("[data-drawer-close]") || target.closest("a")) {
      drawer.close();
    }
  });
  wide.addEventListener("change", () => {
    if (wide.matches) drawer.close();
  });
}

/**
 * The section in view is the last heading that has scrolled past the top of
 * the page (below the sticky header), or the last one once the page is
 * scrolled to the bottom.
 */
function setUpScrollSpy() {
  const links = [
    ...document.querySelectorAll<HTMLAnchorElement>("[data-toc-link]"),
  ];

  const label = document.querySelector("[data-toc-current]");

  const ids = [
    ...new Set(links.map((link) => decodeURIComponent(link.hash.slice(1)))),
  ];

  const headings = ids.flatMap((id) => {
    const heading = document.querySelector(`#${CSS.escape(id)}`);

    return heading ? [heading] : [];
  });

  if (headings.length === 0) return;

  let frame = 0;

  const update = () => {
    frame = 0;

    // Where a heading lands when its link is followed: under the header.
    const offset =
      (document.querySelector("header")?.getBoundingClientRect().bottom ?? 0) +
      24;

    const atBottom =
      innerHeight + scrollY >= document.documentElement.scrollHeight - 2;

    const passed = headings.filter(
      (heading) => heading.getBoundingClientRect().top <= offset + 8
    );

    const active = atBottom ? headings.at(-1) : (passed.at(-1) ?? headings[0]);

    for (const link of links) {
      const isActive = link.hash === `#${active?.id ?? ""}`;

      link.toggleAttribute("data-active", isActive);

      if (isActive) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    }

    if (label && active) label.textContent = active.textContent;
  };

  const schedule = () => {
    if (frame === 0) frame = requestAnimationFrame(update);
  };

  addEventListener("scroll", schedule, { passive: true });
  addEventListener("resize", schedule);
  update();
}

async function copyCode(button: HTMLButtonElement) {
  const code = button.closest(".code-block")?.querySelector("pre")?.textContent;

  try {
    await navigator.clipboard.writeText(code ?? "");
  } catch {
    button.textContent = "Couldn’t copy";

    return;
  }

  button.textContent = "Copied";
  button.setAttribute("aria-label", "Copied");
  button.toggleAttribute("data-copied", true);
  setTimeout(() => {
    button.textContent = "Copy";
    button.setAttribute("aria-label", "Copy code");
    button.toggleAttribute("data-copied", false);
  }, 2000);
}

function setUpCopyButtons() {
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    ".code-copy"
  )) {
    button.hidden = false;
    button.addEventListener("click", () => {
      void copyCode(button);
    });
  }
}

export function initDocs() {
  setUpDrawer();
  setUpScrollSpy();
  setUpCopyButtons();
}
