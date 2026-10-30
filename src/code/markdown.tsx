import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, type MouseEvent } from "react";
import { useNavigate } from "react-router";
import { cn } from "@/lib/utils";
import { rawFileUrl } from "./code-api";

/**
 * GitHub-flavored Markdown rendered with `marked` and sanitized with
 * DOMPurify. Inside a repository, relative links open in the code browser
 * and relative images load through the raw endpoint at the same ref.
 */

export type MarkdownContext = {
  repo: string;
  ref: string;
  /** Path of the Markdown file; links resolve relative to its directory. */
  path: string;
};

function encodePath(path: string) {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

function resolvePath(from: string, target: string) {
  const base = target.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const part of target.replace(/^\/+/u, "").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") base.pop();
    else base.push(part);
  }
  return base.join("/");
}

function isRelative(url: string) {
  return !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/iu.test(url);
}

function slug(text: string) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/gu, "-");
}

async function renderMarkdown(source: string, context: MarkdownContext | null) {
  const [{ marked }, { default: DOMPurify }] = await Promise.all([
    import("marked"),
    import("dompurify"),
  ]);
  const html = await marked.parse(source, { gfm: true, breaks: false, async: true });
  const fragment = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form"],
    ADD_ATTR: ["target"],
    RETURN_DOM_FRAGMENT: true,
  });
  const ref = context ? encodeURIComponent(context.ref) : "";
  const query = context ? `?ref=${ref}` : "";
  for (const image of fragment.querySelectorAll("img")) {
    const src = image.getAttribute("src") ?? "";
    image.setAttribute("loading", "lazy");
    if (context && src && isRelative(src)) {
      const path = resolvePath(context.path, src.split(/[?#]/u)[0]!);
      image.setAttribute("src", rawFileUrl(context.repo, context.ref, path, true));
    }
  }
  for (const link of fragment.querySelectorAll("a")) {
    const href = link.getAttribute("href") ?? "";
    if (context && href && isRelative(href)) {
      const [target = "", hash] = href.split("#");
      const path = resolvePath(context.path, target);
      const kind = target.endsWith("/") || !path.split("/").at(-1)?.includes(".")
        ? "tree"
        : "blob";
      link.setAttribute(
        "href",
        `/git/${context.repo}/${kind}/${encodePath(path)}${query}${hash ? `#${hash}` : ""}`,
      );
      link.setAttribute("data-internal", "true");
    } else if (/^https?:/iu.test(href)) {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    }
  }
  for (const input of fragment.querySelectorAll("input")) {
    if (input.getAttribute("type") !== "checkbox") input.remove();
    else input.setAttribute("disabled", "");
  }
  const seen = new Map<string, number>();
  for (const heading of fragment.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    const base = slug(heading.textContent ?? "") || "section";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    heading.id = count ? `${base}-${count}` : base;
  }
  const container = document.createElement("div");
  container.appendChild(fragment);
  return container.innerHTML;
}

export function Markdown({
  source,
  context = null,
  className,
}: {
  source: string;
  context?: MarkdownContext | null;
  className?: string;
}) {
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  const rendered = useQuery({
    queryKey: ["markdown", source, context?.repo, context?.ref, context?.path],
    queryFn: () => renderMarkdown(source, context),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 60_000,
  });

  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (rendered.data && hash) {
      ref.current?.querySelector(`#${CSS.escape(decodeURIComponent(hash))}`)?.scrollIntoView();
    }
  }, [rendered.data]);

  function onClick(event: MouseEvent<HTMLDivElement>) {
    const link = (event.target as HTMLElement).closest("a");
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    const href = link.getAttribute("href") ?? "";
    if (href.startsWith("#")) {
      event.preventDefault();
      ref.current?.querySelector(`#${CSS.escape(decodeURIComponent(href.slice(1)))}`)
        ?.scrollIntoView({ behavior: "smooth" });
      history.replaceState(null, "", href);
    } else if (link.dataset.internal) {
      event.preventDefault();
      navigate(href);
    }
  }

  if (!rendered.data) {
    return <div className={cn("text-sm whitespace-pre-wrap", className)}>{source}</div>;
  }
  return (
    <div
      ref={ref}
      className={cn("markdown-body", className)}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: rendered.data }}
    />
  );
}
