# OpenWorkspace

Self-hosted team mail on Cloudflare — personal and shared inboxes, passkey-only access, no passwords to manage.

One Worker, your domains, your data. Invite people with a link, grant mailbox access, and send and receive mail without running an MTA.

## Highlights

- **Passkeys only** — no passwords, invitations and recovery via one-time links
- **Personal and shared mailboxes** — multiple owned addresses plus read-only or read-and-send access per member
- **Multiple domains** — accept provisioned addresses across manually configured Cloudflare mail zones
- **Delivery status** — bounces, deferrals, and complaints surface in the app
- **Attachment previews** — PDF, images, text, and background PDF conversion for Office documents
- **Realtime and push** — mailbox-scoped WebSockets plus optional PWA notifications
- **Signed webhooks** — account-wide email and administration events with retry history
- **Runs on Cloudflare** — Workers, D1, Durable Objects, R2, Images, Email Service, and Queues

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/iivankin/openworkspace)

Or clone and deploy from your machine (requires [Bun](https://bun.sh), Docker, and a Cloudflare Workers Paid account):

```bash
git clone git@github.com:iivankin/openworkspace.git
cd openworkspace
bun install
bun run deploy
```

Cloudflare provisions D1, R2, and the Images binding from `wrangler.jsonc`. Domain mail setup is manual — complete it once after the first deploy.

### Attachment previews

PDF attachments open in an on-demand PDF.js viewer with page navigation, zoom,
text selection, and search. The Translate button uses the existing mail translation
API for the current page; navigating with translation enabled translates each new
page on demand. Results are cached in browser memory. Translated text replaces
the page text in place, preserving the PDF background and table lines. Longer
translations shrink to fit the original line bounds; browser fonts and black text
approximate the original typography. Show original restores the
source page; searching also switches to the original text. Rotated text and special
text rendering modes retain the original page instead of an inaccurate overlay. Image-only scans can be viewed but need
OCR before their text can be translated; OCR is not included.

PDF.js workers, fonts, CMaps, and image codecs are served by the app itself.
The viewer also displays the PDFs generated from Office attachments below.

New incoming and sent Word (`doc`, `docx`, `docm`), Excel (`xls`, `xlsx`, `xlsm`),
PowerPoint (`ppt`, `pptx`, `pptm`), OpenDocument, and RTF attachments up to 20 MiB
are converted to PDF in the background. Existing stored messages are not backfilled.
Original files remain unchanged and are used for downloads and forwarding.

The `office-preview` Cloudflare Container uses Gotenberg 8.37.0 with LibreOffice.
Wrangler builds its Docker image on deployment; Docker must also be running for
local development and the Office browser test. The configured queue runs at most
two conversions concurrently. A container starts for a conversion and is destroyed
after its PDF is saved to R2, including on failure; subsequent previews use R2 only.
Outbound Internet access is disabled for the converter. Conversion failures retry
up to three attempts, after which the original remains downloadable.

Preview jobs are committed with message metadata before being dispatched to
`openworkspace-office-previews`. A ready preview is announced through the mailbox's
existing realtime connection. Permanent message deletion also removes the generated PDF.

Run the real Word/Excel/PowerPoint conversion check with Docker running:

```bash
bunx playwright test e2e/office-preview.spec.ts --project=desktop
```

### Pull updates from upstream

The Deploy button creates a copy of this repo on your GitHub account. To take template updates later:

```bash
bun run sync:upstream
```

The script asks whether to run `bun install` and push to `origin`.
The script merges upstream (`main` or `master`) and keeps your Cloudflare-provisioned D1/R2 identifiers in `wrangler.jsonc`. Deploy-button copies often have no shared git history with this repo; the first sync allows unrelated histories and prefers upstream on conflicts, then restores your local D1/R2 ids. If a merge conflict remains, resolve it manually and keep your local `database_id` / `bucket_name`.

### Connect mail domains

For every domain used by a mailbox, configure Cloudflare manually:

1. **Email Routing** — In **Compute → Email Service → Email Routing**, enable Email Routing for the domain.
2. **Catch-all** — Under **Routing Rules**, enable **Catch-all**, choose **Send to a Worker**, and select this Worker.
3. **Outbound sending** — Under **Email Sending**, onboard the domain. Cloudflare adds SPF, DKIM, return-path, and DMARC records.
4. **Delivery events** — Open **Queues → openworkspace-delivery-events → Subscriptions**, subscribe to **Email Sending** for the domain, and select all six `message.*` events.
5. **First admin** — Open the app. With an empty database, the first-run screen creates your personal mailbox and registers you as administrator with a passkey.
6. **Profile photos** — Enable **Images** for the account if prompted. Create a public delivery variant named `public` (or `avatar`). Uploaded avatars use custom ids `avatars/<userId>` and are served from `https://imagedelivery.net/<account_hash>/avatars/<userId>/public` (not your Worker domain). Optional later: a custom Images delivery hostname in the dashboard.
7. **Attachment upload cleanup** — Run `bun run r2:lifecycle:setup` once to expire abandoned composer uploads after seven days. If the provisioned bucket is not named `openworkspace`, run `R2_BUCKET_NAME=<bucket> bun run r2:lifecycle:setup`.
8. **Direct attachment transfers** — Optional for the browser and required for MCP attachment transfers. Create an R2 API token (Object Read & Write) for the mail bucket and set `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_ACCOUNT_ID`. In the R2 bucket **Settings → CORS**, allow your app origin with methods `GET`, `PUT`, and `HEAD` and headers `Content-Type`. Without these secrets, browser uploads still work through the Worker, but MCP attachment upload and download links are unavailable.
9. **Show original authentication** — Optional.
   1. Open [Cloudflare User API Tokens](https://dash.cloudflare.com/profile/api-tokens) (**My Profile → API Tokens**, not **Account API Tokens**) and choose **Create Token → Custom token**.
   2. Grant **Zone → Analytics → Read** and scope the token to every mail domain used by OpenWorkspace. Copy the token when Cloudflare shows it; the value is displayed only once.
   3. Store the token on the deployed Worker. Wrangler prompts without putting it in shell history:

      ```bash
      bunx wrangler secret put CLOUDFLARE_ANALYTICS_TOKEN
      ```

   4. For each domain, copy **Zone ID** from its Cloudflare **Overview → API** section and enter it under **Administration → Domains**.

   Show original will display Cloudflare's SPF, DKIM, DMARC, and spam results for incoming messages. Analytics can only be fetched during Cloudflare's 31-day retention window; fetched results are retained with the message.
10. **AI mail processing** — Optional. Before enabling it, open **AI → AI Gateway → Credits Available → Manage** in the Cloudflare dashboard and top up the account's AI Gateway credits. An admin then enables OpenAI classification globally under **Administration → Mailboxes**. Mailbox members configure folders, the shared confidence threshold, and classification rules from the folder-management button beside that mailbox's folders. The original raw message is sent to the third-party `openai/gpt-6-luna` model as an `.eml` file without separately extracting images. Large messages use an estimate of three raw bytes per token and are truncated at 540 KB by omitting the end of the `.eml`; the 180,000-token target leaves a 20,000-token margin below the requested limit. The model checks for spam and selects one existing custom folder before realtime updates and push delivery. After two failed inference attempts, mail falls back to Inbox. Calls use Cloudflare Unified Billing, including local development, and fail when no AI Gateway credits are available; review the applicable Cloudflare and OpenAI data-retention terms before enabling it.
11. **Push notifications** — Generate one persistent VAPID key pair with `bun run push:keygen`. Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and a contact such as `mailto:admin@example.com` in `VAPID_SUBJECT` with `wrangler secret put`. Users can then enable the current browser and choose mailboxes under **Settings → Notifications**. Each browser endpoint belongs directly to the current account and is rebound idempotently when the app starts. Natural session expiry and remote session revocation do not affect push; explicit logout detaches the current endpoint, while disabling notifications unsubscribes it from the browser.

Unknown catch-all recipients are rejected permanently. Only addresses you create in the app accept mail.

### Enable the OIDC identity provider

Each deployment can act as one OpenID Connect issuer for its existing users.
Configure the canonical public origin and an RSA signing key:

```bash
bun run oidc:keygen
wrangler secret put IDENTITY_PROVIDER_ORIGIN
wrangler secret put OIDC_SIGNING_PRIVATE_JWK
```

Use the exact HTTPS origin (for example `https://mail.example.com`) as
`IDENTITY_PROVIDER_ORIGIN`, and paste the generated JSON as
`OIDC_SIGNING_PRIVATE_JWK`. The same origin is used by SAML when both identity
providers are enabled.
Then open **Administration → OIDC applications** to register each relying
party's exact redirect URI, scopes, client type, and assigned users. A
confidential client secret is displayed once.

Clients discover the provider at:

```text
https://mail.example.com/.well-known/openid-configuration
```

The provider supports Authorization Code with mandatory PKCE S256, public and
confidential clients, `openid profile email groups offline_access`, rotating
refresh tokens, revocation, UserInfo, and RP-initiated logout. Group membership
never grants application access; the client only receives group slugs selected
in its claim allowlist.

For signing-key rotation, retain the previous public JWK in a
`{"keys":[...]}` value under `OIDC_PREVIOUS_PUBLIC_JWKS`, deploy the new private
key, and keep the previous public key published until old ID tokens and JWKS
caches have expired.

### Enable the SAML identity provider

The same deployment can issue SAML 2.0 assertions for configured service
providers. Generate a dedicated RSA key and X.509 certificate, then configure
the canonical public origin:

```bash
bun run saml:keygen
wrangler secret put IDENTITY_PROVIDER_ORIGIN
wrangler secret put SAML_SIGNING_PRIVATE_KEY < .saml/private-key.pem
wrangler secret put SAML_SIGNING_CERTIFICATE < .saml/certificate.pem
```

Open **Administration → SAML applications** to register each service
provider's Entity ID, exact ACS URL, NameID format, released attributes, user
assignments, and optional AuthnRequest signing certificate. The IdP metadata is
published at:

```text
https://mail.example.com/saml/metadata
```

The provider accepts SP-initiated AuthnRequest messages over HTTP-Redirect and
returns signed responses and assertions over HTTP-POST. Per-application launch
URLs provide IdP-initiated sign-in. Assertion encryption and Single Logout are
not enabled.

For signing-key rotation, first publish the next certificate in the
`SAML_ADDITIONAL_SIGNING_CERTIFICATES` PEM bundle. After service providers have
refreshed metadata, switch the private key and primary certificate, keep the old
certificate in that bundle, and remove it after metadata caches have expired.

Docs: [Deploy buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/) · [Catch-all](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/#catch-all-rule) · [Email Sending](https://developers.cloudflare.com/email-service/get-started/send-emails/) · [Event subscriptions](https://developers.cloudflare.com/email-service/platform/event-subscriptions/)

## Local development

Requires [Bun](https://bun.sh).

```bash
bun install
cp .dev.vars.example .dev.vars
```

Uncomment `ALLOW_MOCK_AUTH=true` in `.dev.vars` (dev only), then:

```bash
bun run db:setup:local
bun run dev
```

Open [http://localhost:5173](http://localhost:5173). Local seed includes an admin, a member, mailboxes, and sample messages. With mock auth enabled, **Open seeded local demo** skips WebAuthn.

| Fixture | Path |
| --- | --- |
| Invitation | `/invite/demo-invitation-token` (while signed out) |
| Passkey recovery | `/recover/demo-recovery-token` |

Outbound mail is logged locally instead of sent. To test push locally, add a key pair from `bun run push:keygen` and `VAPID_SUBJECT` to `.dev.vars`. Useful checks: `bun run typecheck`, `bun run test`, `bun run build`.

## Using the app

- **Empty install** — first visitor sets a name and personal email, registers a passkey, and becomes admin.
- **Invite users** — admin creates a person with a personal mailbox and shares the one-time invitation link. They register a passkey to join.
- **Recover access** — admin issues a one-hour recovery link; redeeming it replaces all passkeys and removes existing sessions and push registrations.
- **Settings** — each person manages their avatar, appearance, current-device push subscription, and per-mailbox notification preferences.
- **Mailboxes** — an admin can create multiple personal addresses for a user or shared addresses with read-only or read-and-send members. Each user has one primary personal mailbox for identity and recovery.
- **Signatures** — under **Settings → Signatures**, each person formats a signature (bold, italics, links, lists) per mailbox they can send from, and chooses whether it's added to new messages, replies and forwards. API and MCP sends add it only when the request sets `"includeSignature": true`, so automated mail is unchanged by default. Signature HTML is sanitized on save with an allowlist built on the Workers `HTMLRewriter`: only basic formatting tags survive, every attribute is removed, links keep only `http`, `https`, `mailto` and `tel` targets, and images are not allowed.
- **Drafts** — the composer and inline reply save to the server about two seconds after you stop typing, and when you close them. Drafts are private to their author, even in shared mailboxes, and listed under **Drafts** for each mailbox you can send from. Their attachments are kept outside the seven-day upload cleanup until the draft is sent or discarded. If the same draft is edited in two windows, the second save is rejected instead of overwriting the first.
- **Auto-replies** — under **Settings → Auto-replies**, owners and members with send access set an out-of-office reply per mailbox, optionally between a start and end time; admins can see and change every mailbox's auto-reply under **Administration → Auto-replies**, or through the API and MCP. Replies follow RFC 3834: they go to the envelope sender, carry `Auto-Submitted: auto-replied`, are not stored in Sent, and are never sent for spam, mailing lists (`List-Id`, `List-Unsubscribe`, `Precedence`), bounces, other auto-replies, `X-Auto-Response-Suppress`, mail the mailbox received by Bcc, calendar invitations and responses (`text/calendar` or `.ics` parts), or system senders such as `noreply@`. Each sender gets at most one reply per interval (default four days), with a cap of 50 replies per hour per mailbox.
- **Trash and Spam** — members with send access can empty Trash or Spam from the folder header, and choose to delete conversations automatically after they have been there for 7, 30 or 90 days (any 1–365 through the API or MCP). Each mailbox remembers when a conversation entered its current folder, and cleanup runs on the mailbox's own alarm in batches of 100, so no cron job is needed. Conversations already in Trash or Spam when this was deployed count from the deploy time.
- **PWA notifications** — desktop and Android browsers can subscribe from Settings. On iPhone and iPad, first add OpenWorkspace to the Home Screen, then enable notifications from the installed app.

### Connect an MCP client

Open **Settings → MCP**, create a named personal token, and copy it immediately; the full secret is shown once. Configure the client with:

```text
Server URL: https://mail.example.com/mcp
Authorization: Bearer mcp_…
```

The token acts as its owner: mailbox access, send permission, account status, and role are checked on every operation. Mail tools can read raw messages in bounded chunks and issue 15-minute private R2 attachment links. To attach a file, call `create_attachment_upload`, PUT the exact declared bytes to the returned URL using the returned headers, then call `complete_attachment_upload` and pass its upload id to the send, reply, or forward tool. Administrator tokens additionally expose domains, mailbox ownership, user roles, destructive mailbox cleanup, Workers AI, group, and OIDC administration tools. Revoke a token from the same settings page to stop it immediately.

The endpoint supports both current MCP requests and stateless clients using the 2024–2025 protocol revisions.

### Send mail from other apps

For apps that only need to send mail, such as invoicing tools or an SMTP-to-HTTP relay, create a token with **Send only** access under **Settings → MCP**. A send-only token cannot use MCP or read mail. It can only call these endpoints, with the same mailbox permission checks as the web app:

| Request | Purpose |
| --- | --- |
| `GET /api/mail/mailboxes` | List mailboxes; use the `id` of one with `canSend: true` |
| `POST /api/mail/uploads?mailboxId=…`, then PUT to the returned `uploadUrl`, then `POST /api/mail/uploads/{id}/complete?mailboxId=…` | Upload an attachment (`DELETE /api/mail/uploads/{id}?mailboxId=…` discards it) |
| `POST /api/mail/messages` | Send a new message |

```bash
curl https://mail.example.com/api/mail/messages \
  -H "Authorization: Bearer mcp_…" \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b",
    "mailboxId": "<mailbox id>",
    "to": ["customer@example.net"],
    "subject": "Invoice 1042",
    "bodyText": "Your invoice is attached.",
    "attachments": [{ "uploadId": "upl_…" }]
  }'
```

`requestId` is a UUID idempotency key: retrying with the same id and body returns the original message (`200`) instead of sending twice, and reusing it with a different body returns `409`. A new message returns `201` with `messageId` and `transportState`. The message is stored in the mailbox's Sent folder and emits the `email.sent` webhook like any other send. Errors return `400` (validation), `401` (missing or revoked token), or `403` (no send access, or a request outside the token's scope).

### Configure outgoing webhooks

Administrators manage account-wide endpoints under **Administration → Webhooks**. Each endpoint chooses from email received/sent, user joined/updated, and mailbox lifecycle events. Email events include both the stored text and HTML bodies plus attachment metadata; attachment contents are not embedded.

Secrets are displayed only when an endpoint is created or rotated. OpenWorkspace signs the exact request body with HMAC-SHA256 and sends:

```text
x-openworkspace-delivery: whd_…
x-openworkspace-event: email.received
x-openworkspace-timestamp: 1787580000
x-openworkspace-signature: sha256=…
```

Verify the signature over `<timestamp>.<raw request body>`, reject stale timestamps, and deduplicate retries with `x-openworkspace-delivery`. Delivery runs asynchronously through Cloudflare Queues, retries up to five times, and retains the latest delivery status for 30 days. Administrator MCP tokens can also create, update, test, rotate, and delete webhook endpoints.

### Import existing mail

Administrators can import historical messages into any mailbox, one raw RFC 822 message per request, with an administrator API token:

```bash
curl "https://mail.example.com/api/admin/mailboxes/<mailbox id>/import?state=archive&seen=1" \
  -H "Authorization: Bearer mcp_…" \
  -H "Content-Type: message/rfc822" \
  --data-binary @message.eml
```

| Parameter | Values | Default |
| --- | --- | --- |
| `state` | `active`, `archive`, `spam`, `trash` | `active` |
| `direction` | `incoming`, `outgoing`, `auto` (outgoing when From is the mailbox address) | `auto` |
| `seen` | `1` marks an incoming message read for every current mailbox member | `0` |
| `folder` | Custom folder name; created if missing (only applies with `state=active`) | none |
| `receivedAt` | ISO 8601 timestamp for the message's position in the timeline | the `Date` header, then now |

Imported messages are threaded and indexed like live mail, but they never trigger AI classification, push notifications, webhooks, or Office previews, and outgoing messages are never sent. A thread lives where its newest message says, so the order you import in doesn't matter. Importing the same bytes again returns `{"status":"duplicate"}`, which makes interrupted or overlapping runs safe to repeat. Responses are `200` with `status` `imported` or `duplicate`, `400` for invalid parameters or an unreadable message, `404` for an unknown mailbox, `413` above 25 MiB, and `429` above 600 imports per minute per administrator.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
