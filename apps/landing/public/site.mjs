// Copy buttons, and the setup console that plays once when it scrolls into view.

const status = document.querySelector(".sr-status");

function announce(message) {
  if (status) status.textContent = message;
}

async function copyCommand(button) {
  const source = button.dataset.copy
    ? document.querySelector(button.dataset.copy)
    : null;

  const text = button.dataset.copyText ?? source?.textContent ?? "";
  const label = button.textContent;

  try {
    await navigator.clipboard.writeText(text);
  } catch {
    announce("Couldn’t copy. Select the command and copy it yourself.");

    return;
  }

  button.textContent = "Copied";
  announce("Command copied.");
  setTimeout(() => {
    button.textContent = label;
    announce("");
  }, 2000);
}

document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest("[data-copy], [data-copy-text]");

  if (button instanceof HTMLElement) copyCommand(button);
});

const term = document.querySelector(".term");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

if (term && "IntersectionObserver" in window && !reducedMotion) {
  term.classList.add("wait");

  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      term.classList.add("play");
      observer.disconnect();
    },
    { threshold: 0.35 }
  );

  observer.observe(term);
}

// Hero showcase: screens of the app as tabs. With motion allowed, the screens
// advance on their own until someone picks one.

const showcase = document.querySelector(".showcase");

function loadDeferred(root) {
  for (const element of root.querySelectorAll("[data-srcset]")) {
    element.setAttribute("srcset", element.dataset.srcset ?? "");
    delete element.dataset.srcset;
  }
}

function setupShowcase(root) {
  const tablist = root.querySelector('[role="tablist"]');
  const tabs = [...root.querySelectorAll('[role="tab"]')];

  const views = tabs.map((tab) =>
    root.querySelector(`#${tab.getAttribute("aria-controls") ?? ""}`)
  );

  const state = {
    current: 0,
    chosen: false,
    paused: false,
    visible: true,
    layer: 1,
  };

  // Only the screens under the newest one are hidden, and only once it is
  // fully shown, so quick switching never flashes the empty frame.
  function hideAllBut(keep) {
    for (const [position, view] of views.entries()) {
      if (position !== keep) view?.classList.remove("is-shown");
    }
  }

  async function fadeIn(view, index) {
    const fade = view.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 450,
      easing: "cubic-bezier(0.4, 0, 0.2, 1)",
    });

    try {
      await fade.finished;
    } catch {
      // Cancelled: whatever is current now settles the stack.
    }

    if (state.current === index) hideAllBut(index);
  }

  function select(index, focus) {
    const next = (index + tabs.length) % tabs.length;

    if (next === state.current) {
      if (focus) tabs[next]?.focus();

      return;
    }

    state.current = next;

    for (const [position, tab] of tabs.entries()) {
      const active = position === next;

      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      views[position]?.toggleAttribute("hidden", !active);
    }

    const view = views[next];

    if (view) {
      state.layer += 1;
      view.style.zIndex = String(state.layer);
      view.classList.add("is-shown");

      if (reducedMotion || !view.animate) {
        hideAllBut(next);
      } else {
        fadeIn(view, next);
      }
    }

    if (focus) tabs[next]?.focus();
  }

  tablist?.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const tab = event.target.closest('[role="tab"]');
    const index = tabs.indexOf(tab);

    if (index === -1) return;
    state.chosen = true;
    select(index, false);
  });

  tablist?.addEventListener("keydown", (event) => {
    const last = tabs.length - 1;

    const moves = new Map([
      ["ArrowRight", state.current + 1],
      ["ArrowLeft", state.current - 1],
      ["Home", 0],
      ["End", last],
    ]);

    const target = moves.get(event.key);

    if (target === undefined) return;
    event.preventDefault();
    state.chosen = true;
    select(target, true);
  });

  const idle =
    window.requestIdleCallback ?? ((callback) => setTimeout(callback, 1200));

  idle(() => loadDeferred(root));
  root.classList.add("is-ready");

  if (reducedMotion) return;

  root.addEventListener("pointerenter", () => {
    state.paused = true;
  });
  root.addEventListener("pointerleave", () => {
    state.paused = false;
  });
  root.addEventListener("focusin", () => {
    state.paused = true;
  });
  root.addEventListener("focusout", () => {
    state.paused = false;
  });

  if ("IntersectionObserver" in window) {
    new IntersectionObserver((entries) => {
      state.visible = entries.some((entry) => entry.isIntersecting);
    }).observe(root);
  }

  setInterval(() => {
    if (state.chosen || state.paused || !state.visible || document.hidden) {
      return;
    }

    // Wait for the next screen's image, so it never fades in half-drawn.
    const next =
      views[(state.current + 1) % views.length]?.querySelector("img");

    if (next && !next.complete) return;
    select(state.current + 1, false);
  }, 6000);
}

if (showcase) setupShowcase(showcase);
