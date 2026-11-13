// Docs search: a dialog over Pagefind's static index (dist/pagefind/, built
// by src/integrations/pagefind.ts). It opens with the header's search
// button, Ctrl K or ⌘ K, or "/"; the arrow keys move through the results and
// Enter opens one.

type Result = { url: string; title: string; excerpt: string };

type PagefindData = {
  url: string;
  excerpt: string;
  meta: { title?: string };
  sub_results?: { url: string; title: string; excerpt: string }[];
};

type SearchOptions = { verbose?: boolean };

type Pagefind = {
  debouncedSearch: (
    query: string,
    options: SearchOptions,
    wait: number
  ) => Promise<{ results: { data: () => Promise<PagefindData> }[] } | null>;
};

const indexUrl = "/pagefind/pagefind.js";
const maxPages = 8;
const maxSections = 3;

let pagefind: Promise<Pagefind | undefined> | undefined;

async function importPagefind(): Promise<Pagefind | undefined> {
  try {
    // Pagefind's own module, which the build writes next to the pages.
    const module: Pagefind = await import(/* @vite-ignore */ indexUrl);

    return module;
  } catch {
    return undefined;
  }
}

function loadPagefind() {
  pagefind ??= importPagefind();

  return pagefind;
}

/** Pagefind's URLs end in .html; the site serves its pages without it. */
function pageUrl(url: string) {
  return url.replace(/\.html(?=$|#)/u, "");
}

/** An excerpt as nodes: its text, with Pagefind's <mark>s kept as marks. */
function excerptNodes(html: string): Node[] {
  const parsed = new DOMParser().parseFromString(html, "text/html");

  return [...parsed.body.childNodes].map((node) => {
    if (node instanceof HTMLElement && node.tagName === "MARK") {
      const mark = document.createElement("mark");

      mark.textContent = node.textContent;

      return mark;
    }

    return document.createTextNode(node.textContent ?? "");
  });
}

function flatten(data: PagefindData): (Result & { section: boolean })[] {
  const page = {
    url: pageUrl(data.url),
    title: data.meta.title ?? data.url,
    excerpt: data.excerpt,
    section: false,
  };

  const sections = (data.sub_results ?? [])
    .flatMap((sub) => {
      const url = pageUrl(sub.url);

      // The page's own title is its first section.
      return url === page.url || sub.title === page.title
        ? []
        : [{ url, title: sub.title, excerpt: sub.excerpt, section: true }];
    })
    .slice(0, maxSections);

  // The sections' excerpts say where the matches are; the page's would
  // repeat the first.
  return [
    { ...page, excerpt: sections.length > 0 ? "" : page.excerpt },
    ...sections,
  ];
}

function setUpSearch() {
  const dialog = document.querySelector<HTMLDialogElement>("#search");
  const input = dialog?.querySelector<HTMLInputElement>("[data-search-input]");
  const list = dialog?.querySelector<HTMLUListElement>("[data-search-results]");
  const status = dialog?.querySelector<HTMLElement>("[data-search-status]");

  if (!(dialog && input && list && status)) return;

  let active = -1;

  const options = () => [
    ...list.querySelectorAll<HTMLAnchorElement>("[role='option']"),
  ];

  const setActive = (index: number) => {
    const all = options();

    active = all.length === 0 ? -1 : (index + all.length) % all.length;

    for (const [position, option] of all.entries()) {
      option.setAttribute("aria-selected", String(position === active));
    }

    const current = all[active];

    if (current) {
      input.setAttribute("aria-activedescendant", current.id);
      current.scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  };

  const showStatus = (message: string) => {
    status.textContent = message;
    status.hidden = message === "";
  };

  const render = (results: (Result & { section: boolean })[]) => {
    list.replaceChildren(
      ...results.map((result, index) => {
        const item = document.createElement("li");
        const link = document.createElement("a");
        const title = document.createElement("span");
        const excerpt = document.createElement("span");

        link.id = `search-option-${index}`;
        link.href = result.url;
        link.setAttribute("role", "option");
        link.setAttribute("aria-selected", "false");
        link.className = [
          "flex flex-col gap-0.5 rounded-md px-3 py-2 text-sm outline-none aria-selected:bg-muted",
          result.section ? "ml-4 border-l pl-3" : "",
        ].join(" ");
        title.className = result.section
          ? "font-medium text-foreground/90"
          : "font-semibold text-foreground";
        title.textContent = result.title;
        excerpt.className =
          "search-excerpt line-clamp-2 text-[0.8125rem] text-muted-foreground";
        excerpt.replaceChildren(...excerptNodes(result.excerpt));
        link.append(title);

        if (result.excerpt !== "") link.append(excerpt);
        link.addEventListener("mousemove", () => {
          if (active !== index) setActive(index);
        });
        item.append(link);

        return item;
      })
    );
    input.setAttribute("aria-expanded", String(results.length > 0));
    setActive(0);
  };

  const search = async () => {
    const query = input.value.trim();

    if (query === "") {
      render([]);
      showStatus("Type to search the docs.");

      return;
    }

    const index = await loadPagefind();

    if (!index) {
      render([]);
      showStatus("Search works on the built site (bun run build:site).");

      return;
    }

    const response = await index.debouncedSearch(query, {}, 120);

    // A newer query superseded this one.
    if (response === null || input.value.trim() !== query) return;

    const pages = await Promise.all(
      response.results.slice(0, maxPages).map((result) => result.data())
    );

    const results = pages.flatMap(flatten);

    render(results);
    showStatus(results.length === 0 ? `No results for “${query}”.` : "");
  };

  const open = () => {
    if (dialog.open) return;
    dialog.showModal();
    input.select();
    void loadPagefind();
  };

  for (const button of document.querySelectorAll("[data-search-open]")) {
    button.addEventListener("click", open);
  }

  input.addEventListener("input", () => {
    void search();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive(active + (event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Enter") {
      const current = options()[active];

      if (current) {
        event.preventDefault();
        dialog.close();
        location.assign(current.href);
      }
    }
  });
  dialog.addEventListener("click", (event) => {
    // A click on the backdrop lands on the dialog itself.
    if (event.target === dialog) dialog.close();
  });
  list.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("a")) {
      dialog.close();
    }
  });

  document.addEventListener("keydown", (event) => {
    const shortcut =
      event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey);

    const slash =
      event.key === "/" &&
      !(
        event.target instanceof HTMLElement && event.target.isContentEditable
      ) &&
      !(event.target instanceof HTMLInputElement) &&
      !(event.target instanceof HTMLTextAreaElement);

    if (!(shortcut || slash)) return;
    event.preventDefault();

    if (dialog.open && shortcut) dialog.close();
    else open();
  });

  // The shortcut as this platform writes it.
  if (/Mac|iPhone|iPad/u.test(navigator.platform)) {
    for (const kbd of document.querySelectorAll("[data-search-shortcut]")) {
      kbd.textContent = "⌘K";
    }
  }
}

export function initSearch() {
  setUpSearch();
}
