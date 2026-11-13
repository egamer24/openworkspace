export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener(
    "load",
    () => {
      void navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .catch((error) => {
          console.error("Could not register the service worker", error);
        });
    },
    { once: true }
  );
}
