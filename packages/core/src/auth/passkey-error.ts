/**
 * What went wrong with a passkey prompt, in words for the person at the
 * screen. The browser's own messages (WebAuthn's spec errors) are written for
 * developers; the server's are already meant for people and pass through.
 */
export function passkeyErrorMessage(cause: unknown, fallback: string) {
  if (!(cause instanceof Error)) return fallback;

  switch (cause.name) {
    case "NotAllowedError":
    case "AbortError": {
      return "The passkey prompt was closed or timed out. Try again when you're ready.";
    }

    case "InvalidStateError": {
      return "This device already has a passkey for this account. Sign in with it instead.";
    }

    case "NotSupportedError": {
      return "This browser or device can't create passkeys. Try another browser, or use your phone.";
    }

    case "SecurityError": {
      return "Passkeys only work on this workspace's own address. Open it from its usual URL and try again.";
    }

    default: {
      return cause.message || fallback;
    }
  }
}
