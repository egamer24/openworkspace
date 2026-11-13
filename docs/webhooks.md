# Webhooks

Webhooks send an HTTP request to your endpoint when something happens in the
workspace, such as a person joining or an email arriving.

## Add an endpoint

1. Open **Administration → Webhooks**. You need to be an administrator, or have
   the "Manage webhooks" permission.
2. Enter the endpoint's URL and choose its events.
3. For email events, choose which mailboxes to cover. You can pick only
   mailboxes you can open yourself.
4. Save, and copy the signing secret. It's shown only now, or when you rotate
   it.

If the person who saved an endpoint loses access to one of its mailboxes, that
mailbox's mail is skipped until someone who can open it saves the endpoint
again.

Failed deliveries are retried up to five times.

## Events

| Event             | When it's sent                                           |
| ----------------- | -------------------------------------------------------- |
| `user.joined`     | An invited person finishes registering                   |
| `user.updated`    | An administrator changes a person's name, role or status |
| `mailbox.created` | A personal or shared mailbox is added                    |
| `mailbox.updated` | A mailbox's display name or members change               |
| `mailbox.deleted` | A mailbox is permanently removed                         |
| `email.received`  | Mail arrives in a covered mailbox                        |
| `email.sent`      | Mail is sent from a covered mailbox                      |

Email events include the message body and a list of attachments, without
their contents. Modules can add their own events.

## Verify deliveries

Deliveries follow [Standard Webhooks](https://www.standardwebhooks.com/), so
you can verify them with any of its libraries:

```ts
import { Webhook } from "standardwebhooks";

// Throws if the signature is wrong or the timestamp is too old.
const event = new Webhook(secret).verify(rawBody, headers);
```

Each request carries these headers:

```text
webhook-id: whd_…
webhook-timestamp: 1787580000
webhook-signature: v1,<base64 HMAC-SHA256 of "id.timestamp.body">
```

The `webhook-id` stays the same on retries, so use it to skip duplicates. The
event type is in the payload's `type` field.

## Declare endpoints in code

You can declare an endpoint in `alchemy.run.ts` with `Webhook`. Its signing
secret is created on the first deploy, so you can hand it to the receiving
Worker in the same file:

```ts
Effect.gen(function* () {
  const billing = yield* Webhook("Billing", {
    name: "Billing",
    url: "https://billing.acme.com/hooks/workspace",
    events: ["user.joined", "user.updated"],
  });
  yield* OpenWorkspace({
    hostname: "mail.acme.com",
    mailDomains: ["acme.com"],
    webhooks: [billing],
  });
  yield* Cloudflare.Worker("BillingWorker", {
    main: "./billing/worker.ts",
    env: { WORKSPACE_WEBHOOK_SECRET: billing.secret },
  });
});
```

Endpoints declared in code cover every mailbox, and are read-only in the admin
UI.
