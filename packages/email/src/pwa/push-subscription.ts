import type { PushSubscriptionData } from "@mmmike/web-push/client";
import { responseJson } from "@open-workspace/core/ui";

import { mailApi } from "../lib/mail-api";

const SERVICE_WORKER_READY_TIMEOUT_MS = 10_000;

function pushIsSupported() {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

async function activeServiceWorkerRegistration() {
  const current = await navigator.serviceWorker.getRegistration();

  if (current?.active) return current;

  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("The notification service is unavailable"));
        }, SERVICE_WORKER_READY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function createPushSubscription(
  registration: ServiceWorkerRegistration,
  publicKey: string
) {
  const { urlBase64ToUint8Array } = await import("@mmmike/web-push/vapid");

  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
}

async function currentBrowserPushSubscription() {
  if (!pushIsSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration();

  return registration?.pushManager.getSubscription() ?? null;
}

async function serializedSubscription(subscription: PushSubscription) {
  const client = await import("@mmmike/web-push/client");

  return client.serializeSubscription(subscription);
}

async function bindPushSubscription(subscription: PushSubscriptionData) {
  await responseJson(
    await mailApi.api.notifications.subscriptions.$put({ json: subscription })
  );
}

async function removeServerPushSubscription(endpoint: string) {
  await responseJson(
    await mailApi.api.notifications.subscriptions.$delete({
      json: { endpoint },
    })
  );
}

/**
 * Before sign-out, stops this device getting the account's notifications.
 * The browser keeps its subscription, so the next person to sign in on this
 * device can claim it.
 */
export async function removePushSubscriptionForSignOut() {
  let endpoint: string | undefined;

  try {
    endpoint = (await currentBrowserPushSubscription())?.endpoint;
  } catch {
    // Sign-out must not depend on browser push APIs being healthy; the
    // session is revoked even when this device cannot identify itself.
    return;
  }

  if (endpoint) await removeServerPushSubscription(endpoint);
}

export async function syncCurrentPushSubscription() {
  const subscription = await currentBrowserPushSubscription();

  if (!subscription) return;
  await bindPushSubscription(await serializedSubscription(subscription));
}

export async function currentPushRegistrationStatus() {
  if (!pushIsSupported()) return "unsupported" as const;
  const subscription = await currentBrowserPushSubscription();

  if (Notification.permission === "denied") {
    if (subscription) await removeServerPushSubscription(subscription.endpoint);

    return "denied" as const;
  }

  if (!subscription) return "prompt" as const;
  await bindPushSubscription(await serializedSubscription(subscription));

  return "enabled" as const;
}

export async function enableCurrentPushSubscription(publicKey: string) {
  if (!pushIsSupported()) {
    throw new Error("Push is not supported on this device");
  }

  if ((await Notification.requestPermission()) !== "granted") {
    throw new Error("Notification permission was denied");
  }

  const registration = await activeServiceWorkerRegistration();

  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await createPushSubscription(registration, publicKey));

  await bindPushSubscription(await serializedSubscription(subscription));
}

export async function disableCurrentPushSubscription() {
  const subscription = await currentBrowserPushSubscription();

  if (!subscription) return { browserUnsubscribed: true };

  await removeServerPushSubscription(subscription.endpoint);
  let browserUnsubscribed = false;

  try {
    browserUnsubscribed = await subscription.unsubscribe();
  } catch {
    // The account mapping is already gone, which is the security boundary.
  }

  return { browserUnsubscribed };
}
