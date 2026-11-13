// The workspace's logo when it has one: the Worker redirects this stable URL
// to the current logo's versioned icon, or to the OpenWorkspace icon, so the
// worker never needs the app's state or an update when the logo changes.
const NOTIFICATION_ICON = "/api/workspace-logo/icon/192";

// The small status-bar badge stays the OpenWorkspace icon: platforms reduce it
// to a silhouette, which a full-color logo doesn't survive.
const NOTIFICATION_BADGE = "/icons/app-icon-192.png";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim())
);

self.addEventListener("push", (event) => {
  let payload = { title: "New email", url: "/" };

  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    // A visible fallback is required even if a provider delivered bad data.
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      icon: NOTIFICATION_ICON,
      badge: NOTIFICATION_BADGE,
      data: { url: payload.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const target = new URL(
    event.notification.data?.url || "/",
    self.location.origin
  );

  if (target.origin !== self.location.origin) return;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      const existing = windows.find(
        (client) => new URL(client.url).origin === target.origin
      );

      if (existing) {
        if ("navigate" in existing) await existing.navigate(target.href);

        return existing.focus();
      }

      return self.clients.openWindow(target.href);
    })()
  );
});
