# OpenWorkspace

Self-hosted team mail on Cloudflare — personal and shared inboxes, passkey-only access, no passwords to manage.

One Worker, your domains, your data. Invite people with a link, grant mailbox access, and send and receive mail without running an MTA.

## Highlights

- **Passkeys only** — no passwords, invitations and recovery via one-time links
- **Personal and shared mailboxes** — multiple owned addresses plus read-only or read-and-send access per member
- **Multiple domains** — accept provisioned addresses across manually configured Cloudflare mail zones
- **Delivery status** — bounces, deferrals, and complaints surface in the app
- **Local spam filter** — every incoming message is scored inside its mailbox's Durable Object; no content leaves the Worker
- **Attachment previews** — PDF, images, text, and background PDF conversion for Office documents
- **Realtime and push** — mailbox-scoped WebSockets plus optional PWA notifications
- **Signed webhooks** — account-wide email and administration events with retry history
- **Scheduled backups** — optional daily `.eml` + manifest snapshots in a separate R2 bucket with retention
- **JMAP** — native mail clients over HTTPS with personal tokens, including change sync, push, sending with attachments, and import
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

#### Automatic (recommended)

Administration → Domains can configure steps 1 to 3 below through the Cloudflare API.

1. Create a [User API token](https://dash.cloudflare.com/profile/api-tokens) (**Create Token → Custom token**) with:
   - **Zone → Zone → Read**, **Zone → DNS → Edit**, **Zone → Zone Settings → Edit**, and **Zone → Email Routing Rules → Edit**, scoped to the mail domains' zones.
   - **Account → Email Sending → Edit** for the account that owns them.
   - Optional: **Account → Email Routing Addresses → Edit** to manage forwarding destinations from Administration → Addresses (this also needs `CLOUDFLARE_ACCOUNT_ID`).
2. Store it, and optionally the account ID to limit the zone list to one account:

   ```bash
   bunx wrangler secret put CLOUDFLARE_API_TOKEN
   bunx wrangler secret put CLOUDFLARE_ACCOUNT_ID
   ```

   If you renamed the Worker, set the `WORKER_NAME` var in `wrangler.jsonc` to its script name. This token is separate from `CLOUDFLARE_ANALYTICS_TOKEN`.
3. Under **Connect via Cloudflare**, choose a zone and an optional subdomain, then **Preview**. The preview is read-only. If the hostname has MX records for another mail provider, they are listed and are only deleted after you tick **Replace these MX records**.
4. **Connect** enables Email Routing, points the catch-all at this Worker, onboards the hostname for Email Sending, and saves the Zone ID (which also enables Show original authentication once `CLOUDFLARE_ANALYTICS_TOKEN` is set). Steps already in place are skipped. If a step fails, only the changes made by that run are undone, including restoring deleted MX records and the previous catch-all rule.

Each domain then shows the status of every step. **Check** re-reads them from Cloudflare, and **Repair** re-runs the steps that failed or drifted. Admin MCP clients can call the same actions with `check_domain_cloudflare` and `connect_domain_cloudflare`.

Step 4 (delivery events) remains manual: Cloudflare's API does not yet document an Email Sending source for queue event subscriptions.

#### Manual

Without `CLOUDFLARE_API_TOKEN`, configure steps 1 to 4 manually for every domain used by a mailbox. The remaining steps apply to both setups:

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

### Backups and restore

OpenWorkspace has two layers of recovery.

**Portable snapshots (optional).** Create a separate bucket so a mistake in the mail bucket cannot take the backups with it, then uncomment the `BACKUP_STORAGE` binding in `wrangler.jsonc` and deploy:

```bash
bunx wrangler r2 bucket create openworkspace-backups
```

An hourly cron tick starts one snapshot per UTC day and continues an unfinished one in bounded batches (50 messages per step, 20 steps per invocation), so large installs never approach Worker limits; the cursor lives in D1 and an interrupted batch is retried. Each snapshot writes:

- `backups/<date>/account.json` — users, domains, mailboxes and members. Sessions, API tokens, passkeys and other secrets are never exported.
- `backups/<date>/<mailbox-address>/manifest.jsonl` — one line per message: `file`, `sha256`, `mailbox_address`, `folder_role` (`inbox`, `sent`, `archive`, `spam`, `trash`, `custom`), `folder_name`, `seen` (read by any member), `received_at`, `size`, `subject`.
- `backups/objects/<sha256>.eml` — the raw message. `file` in the manifest is relative to the manifest (`../../objects/<sha256>.eml`). Objects are content-addressed, so unchanged mail is uploaded once and every manifest is still complete. Outgoing mail has no stored MIME and is serialized from its stored fields, body and attachments.

The job keeps the newest 14 daily and the newest snapshot of each of the last 8 weeks, deletes older dated folders, and removes objects no snapshot still references. **Administration → Backups** shows the last run, size, errors, and a **Run now** button. To keep a copy outside Cloudflare, sync the bucket with any S3-compatible client (for example `rclone sync`) using an R2 API token scoped to the backup bucket. Scheduled backups need the Workers Paid plan (the Free plan allows 50 subrequests per invocation).

**Point-in-time recovery (built in).** Cloudflare keeps 30 days of history for both stores on the Workers Paid plan (D1 keeps 7 days on Free):

- **D1** (accounts, domains, mailboxes, permissions) — restore with [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/). Restores overwrite the database in place and print a bookmark that undoes them.

  ```bash
  bunx wrangler d1 time-travel info openworkspace --timestamp=2026-03-10T03:00:00Z
  bunx wrangler d1 time-travel restore openworkspace --timestamp=2026-03-10T03:00:00Z
  ```

- **Mailbox Durable Objects** (message metadata, folders, read state) — SQLite-backed Durable Objects support [point-in-time recovery](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) through `ctx.storage.getBookmarkForTime()` and `onNextSessionRestoreBookmark()` from inside the object. There is no Wrangler command for it and OpenWorkspace does not expose it yet. R2 objects are not versioned, so a restored mailbox can reference raw messages or attachments that were permanently deleted afterwards; prefer the portable snapshots for message content.

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
- **Rules** — under **Settings → Rules**, members with send access add ordered rules per mailbox. Conditions: sender (address or domain), To/Cc, subject, mailing list, attachment, combined with all or any. Actions: move to a custom folder, archive, Trash, Spam, never Spam, mark read, and forward. Rules run on new mail after spam classification, can stop later rules, and can be tested against the latest 500 messages before saving. Forwards are new messages from the mailbox with `Reply-To` set to the original sender (so they pass DMARC), marked `Auto-Submitted: auto-forwarded` with a hop counter; spam, mail already forwarded three times, and mail from the destination itself are never forwarded. "Forward only" moves the original to Trash once every forward was accepted.
- **Addresses** — under Administration → Addresses an admin can add aliases (extra addresses that deliver into an existing mailbox), forward-only addresses with no mailbox, and forwards on a mailbox's own address (optionally without keeping a copy), and choose per domain whether unknown recipients are rejected (default) or delivered to a catch-all mailbox. Forwarding uses Email Routing's unchanged forward, so it only goes to verified destination addresses. With `CLOUDFLARE_API_TOKEN` (plus **Account → Email Routing Addresses → Edit**) and `CLOUDFLARE_ACCOUNT_ID`, adding a destination creates it in Cloudflare, which emails a verification link, and **Refresh** reads its status. Without them, add the destination in the dashboard under **Email Routing → Destination addresses** and mark it verified once confirmed. Forwards add an `X-OpenWorkspace-Forwarded` hop count and are skipped after 3 hops or when the destination is the sender; if a forward is skipped, the mailbox keeps the message. Admin MCP tools: `get_mail_routing`, `add_forwarding_destination`, `refresh_forwarding_destination`, `set_forwarding_destination_verified`, `delete_forwarding_destination`, `create_routing_address`, `delete_routing_address`, `set_unknown_recipient_mailbox`.
- **PWA notifications** — desktop and Android browsers can subscribe from Settings. On iPhone and iPad, first add OpenWorkspace to the Home Screen, then enable notifications from the installed app.
- **Spam filter** — incoming mail gets a local 0–100 score from Cloudflare's `Authentication-Results` header (DMARC, SPF, DKIM; only the one with authserv-id `mx.cloudflare.net` is trusted), whether the mailbox has written to the sender or their domain, structure checks (display names showing another address, mismatched link domains, HTML-only bodies, long recipient lists), and risky attachments. By default a score of 70 or more moves the conversation to Spam and 40–69 marks the message as suspicious in Inbox; each message lists its reasons under its details. Members with send access set the thresholds and sender allow and block lists (address or domain) under **Settings → Spam filter**, or with **Always allow** / **Always block** on a message. Allowed senders never go to Spam, blocked senders always do, and optional AI classification can only add a spam decision on top. The filter also learns per mailbox: **Report spam** trains a conversation's incoming messages as spam and **Not spam** (back to Inbox, Archive or a folder) trains them as not spam, replacing any earlier decision for the same message. Once a mailbox has at least 20 of each, a naive Bayes score over subject and body words, link hosts and the sender domain adds −20 to +35 points. Filter, AI and list moves never train. The token table is capped at 50,000 rows (least-used, then oldest, pruned to 45,000); counts and **Reset learning** are under **Settings → Spam filter**.

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

### Connect a JMAP client

OpenWorkspace speaks JMAP ([RFC 8620](https://www.rfc-editor.org/rfc/rfc8620) core, [RFC 8621](https://www.rfc-editor.org/rfc/rfc8621) mail and submission) for native mail clients. Point the client at `https://mail.example.com/.well-known/jmap` and authenticate with a personal token from **Settings → MCP**, either as `Authorization: Bearer mcp_…` or as the password of HTTP Basic auth (the username is ignored). Tokens are checked on every request, so revoking one cuts the client off immediately.

How OpenWorkspace maps onto JMAP:

- **One account per user.** Every mailbox the user can access is a top-level Mailbox named by its address, with Inbox, Sent, Archive, Spam (`role: junk`), Trash, and custom folders as children. `maySubmit` reflects read-and-send membership; read-only members can still read, mark read, move, and manage folders, as in the app.
- **Thread** = conversation, **Email** = message. Folder placement belongs to the conversation, so `mailboxIds` is derived: Inbox/Archive/Spam/Trash and custom folders from the conversation, Sent from the message direction, and a custom folder also implies Inbox. Setting `mailboxIds` on one message moves the whole conversation; every affected message appears in `Email/changes`. Combinations that cannot be stored (for example Archive and Trash, or a mailbox of another address) are rejected with `invalidProperties`.
- **Keywords**: `$seen` is the caller's own read state (sent messages are always seen). Other keywords are accepted and ignored.
- **Destroy** moves a conversation to Trash; destroying from Trash deletes the conversation permanently and needs send access, matching the app.
- **Blobs**: the raw MIME of received mail, each attachment, and the text and HTML bodies download from `/jmap/download/…`, always as attachments with `nosniff`. `POST /jmap/upload/{accountId}` (with `Content-Length`, up to 50 MB) stores a blob for the uploading user under the `composer-uploads/` prefix, so the attachment cleanup rule (`bun run r2:lifecycle:setup`) expires unused uploads after seven days.
- **Sending**: create the message with `Email/set` and submit it with `EmailSubmission/set` (`emailId: "#creationId"`) in the same request; drafts are not stored between requests. Uploaded blobs referenced from `attachments` or `bodyStructure` are sent through the composer's attachment path and limits (inline parts need a `cid` and an image type). Submission goes through the same send path and permission checks as the composer. `onSuccessDestroyEmail` and `onSuccessUpdateEmail` report the transient draft as destroyed.
- **Import**: `Email/import` parses an uploaded RFC 5322 blob with the inbound parser into one mailbox's Inbox, Archive, Spam, Trash, or custom folder (`$seen` is honored). Imports skip AI classification, webhooks, and push notifications. The same bytes are imported only once per mailbox (`alreadyExists`).
- **Push**: `GET /jmap/eventsource?types=…&closeafter=state|no&ping=N` streams `StateChange` events. The Worker subscribes to each mailbox's realtime updates, the same ones the web app uses, and sends an event when the account state changes; `ping` is clamped to 10–600 seconds. The stream holds one connection per mailbox while it is open, and a revoked token ends it at the next change. If the stream drops, clients reconnect and catch up with `*/changes`.
- **Changes**: each mailbox Durable Object keeps a modification sequence and a change log written by SQLite triggers, so inbound delivery, sending, moves, read state, permanent deletes, and folder edits are all tracked. The state string lists one sequence per mailbox (`<mailbox>.<seq>.<r|w>,…`); the last 50,000 changes per mailbox are retained, and older states (or a changed set of mailboxes) return `cannotCalculateChanges`. `Email/queryChanges` reports every changed message as removed and re-adds the ones that still match.

Limits are advertised in the session (32 calls and 10 MB per request, 500 objects per get/set, 600 requests per minute per token). Not supported yet: attaching blobs of stored messages (forwarding attachments), stored drafts, WebSocket push, `header:*` properties, `Email/copy`, `Email/parse`, `VacationResponse`, `Mailbox/queryChanges`, and CORS for browser-based clients.

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
