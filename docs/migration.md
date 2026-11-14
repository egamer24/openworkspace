# Migrate to OpenWorkspace

The `import` command moves an existing organization into your workspace:
people and groups from Google Workspace, and mail from Google Takeout, any mbox
file, or any IMAP account. It runs on your computer, so your old provider's
passwords never reach the workspace.

## Choose a source

| Source                                               | Command         | Who runs it                                         |
| ---------------------------------------------------- | --------------- | --------------------------------------------------- |
| Google Takeout, or any mbox file                     | `import mbox`   | Each person, or an administrator with the exports   |
| IMAP (Gmail, Microsoft 365, Zoho, Fastmail, iCloud…) | `import imap`   | Each person, or an administrator with app passwords |
| Google Workspace people, aliases and groups          | `import people` | An administrator                                    |
| A backup snapshot of this or another workspace       | `import backup` | An administrator                                    |

Contacts, calendars and files can't be imported yet. Restoring a backup is
described under [Backups](configuration.md#restore).

## Cutover steps

1. Run `import people`, and send each person their invitation link. Their old
   mail keeps working for now.
2. Import everyone's mail with `import mbox` or `import imap`.
3. Remove your old provider's MX records and deploy with your domains in
   `mailDomains`. See [Mail domains](deploy.md#mail-domains).
4. Run the same mail imports again. Messages you already imported are skipped,
   so only mail that arrived during the switch is added.

## Signing in to the workspace

Each command opens your browser to sign in to the workspace, and you approve it
like any other app. You stay signed in for later runs; pass `--login` to sign
in again.

Tell the command which workspace to use with `--workspace https://mail.acme.com`
or the `OPENWORKSPACE_URL` variable.

Where you can import depends on your permissions:

- People with the "Import mail" permission, which all administrators have, can
  import into any personal mailbox or shared inbox.
- Everyone else can import only into their own personal mailboxes.

Pick the target mailbox with `--into`. If you pick one you can't use, the
command lists the ones you can.

## Google Takeout and mbox files

```sh
bunx @open-workspace/create import mbox ~/Downloads/Takeout/Mail \
  --workspace https://mail.acme.com --into ada@acme.com
```

To get a Takeout export:

1. Go to [takeout.google.com](https://takeout.google.com) and choose
   **Deselect all**.
2. Tick **Mail**, and keep all of its data included.
3. Choose **Next step**, then **Export once**. Pick `.zip` or `.tgz` and the
   largest file size.
4. Wait for Google's email with the download link, which can take hours or
   days. Unpack the archive.

Pass the `.mbox` file, or the `Takeout` folder to import every `.mbox` file in
it. A Google Workspace administrator may have turned Takeout off.

Mbox files from elsewhere, such as Thunderbird, have no Gmail labels. All of
their mail goes to Archive, or to the place you choose with `--placement`
(`inbox`, `archive`, `spam`, `trash` or `sent`). With `--placement inbox` you
can add `--folder Name`.

Other options for `import mbox`:

| Option                     | What it does                                                      |
| -------------------------- | ----------------------------------------------------------------- |
| `--dry-run`                | Shows what would go where, without importing                      |
| `--skip spam,trash`        | Leaves those messages out                                         |
| `--archived-labels folder` | Keeps labelled mail that's not in the Inbox in its label's folder |
| `--folder-priority "A,B"`  | Which labels win when a thread has several                        |
| `--map jobs.csv`           | Imports many files at once, with rows of `mbox path,target`       |

## IMAP

```sh
GMAIL_APP_PASSWORD=… bunx @open-workspace/create import imap \
  --host imap.gmail.com --user ada@acme.com --password-env GMAIL_APP_PASSWORD \
  --workspace https://mail.acme.com --into ada@acme.com
```

Sign in to the old server with either:

- a password, from the variable named by `--password-env`, or typed when the
  command asks, or
- an OAuth access token with `--access-token`. Microsoft 365 requires this.
  You get the token yourself.

To import many accounts at once, pass `--map accounts.csv` with rows of
`user,target[,password]`.

### Gmail app passwords

Gmail doesn't accept your normal password over IMAP. Create an app password:

1. Turn on 2-Step Verification at
   [myaccount.google.com/security](https://myaccount.google.com/security).
2. Create an app password at
   [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
   and copy the 16 characters.
3. In Gmail, open **Settings → See all settings → Forwarding and POP/IMAP**
   and check that IMAP is on. Under **Labels**, keep **Show in IMAP** on for
   **All Mail**.

If app passwords are turned off for your account, use `--access-token` or
Takeout instead.

Over IMAP, Gmail's Spam and Trash aren't imported. Use Takeout if you want
them. Gmail also limits downloads to about 2.5 GB a day, so a large mailbox
takes more than one day: run the command again each day.

### Other IMAP servers

Inbox, Sent, Spam, Trash and Archive go to the matching places. Other folders
go to Archive, or keep their own folder with `--archived-labels folder`.
Drafts are skipped.

## People and teams from Google Workspace

```sh
bunx @open-workspace/create import people --google-credentials key.json --admin admin@acme.com \
  --workspace https://mail.acme.com --dry-run
```

The command reads your Google directory with credentials from your own Google
Cloud project. Set them up one of two ways.

### A service account

This needs no browser.

1. In [console.cloud.google.com](https://console.cloud.google.com), create a
   project and enable the **Admin SDK API**. To use `--group-settings`, also
   enable the **Groups Settings API**.
2. Under **IAM & Admin → Service accounts**, create an account, then add a
   JSON key under **Keys**. Newer Google organizations block key creation by
   default; allow it for this project.
3. In the [Admin console](https://admin.google.com), open **Security → Access
   and data control → API controls → Domain-wide delegation → Add new**. Enter
   the service account's client ID and these scopes:
   `https://www.googleapis.com/auth/admin.directory.user.readonly,https://www.googleapis.com/auth/admin.directory.group.readonly,https://www.googleapis.com/auth/admin.directory.group.member.readonly`.
   For `--group-settings`, add `https://www.googleapis.com/auth/apps.groups.settings`.
4. Run the command with `--google-credentials key.json --admin <a super administrator>`.
5. Delete the key when you're done.

### Your own OAuth client

You sign in as a Google Workspace administrator.

1. In a Google Cloud project, enable the same APIs.
2. Set up the **OAuth consent screen** as **Internal**.
3. Create **Credentials → OAuth client ID → Desktop app** and download the
   JSON.
4. Run the command with `--google-credentials client.json`. A browser opens
   for the Google sign-in.

If you manage several Google Workspace customers, pass `--customer <id>` to
read another one.

### What carries over

- Each active user becomes an invited person with the same address. Their
  aliases on your mail domains become extra addresses.
- Suspended and archived users are skipped, unless you pass
  `--include-suspended`.
- Each group becomes a team. Its addresses become mailing lists, or shared
  inboxes with `--groups inbox`. With `--group-settings`, collaborative inboxes
  become shared inboxes and the group's posting rules carry over.
- Google administrators are listed for you to promote by hand.
- Anything that already exists is left alone, so you can run it again.

Invitation links are saved to `openworkspace-invitations.csv`. Each link works
once. Passwords don't carry over, because the workspace uses passkeys.

## Gmail labels and threads

A Gmail message can have many labels. In the workspace, each conversation is in
one place: Inbox, Archive, Spam or Trash. In the Inbox, it can also be in one
custom folder.

| Gmail                          | In the workspace                          |
| ------------------------------ | ----------------------------------------- |
| A thread                       | One conversation                          |
| Inbox                          | Inbox                                     |
| No Inbox label                 | Archive                                   |
| Spam, Trash                    | Spam, Trash                               |
| Sent                           | Sent mail                                 |
| Your labels                    | One custom folder per thread in the Inbox |
| Read and unread                | Read and unread                           |
| Drafts, Chats                  | Skipped                                   |
| Starred, Important, Categories | Dropped                                   |

When a thread has several labels, it goes to the first one listed in
`--folder-priority`, otherwise the label on most of its messages. A mailbox can
have up to 100 custom folders.

Gmail filters often skip the Inbox and add a label. That mail goes to Archive,
without the label. With `--archived-labels folder` it goes to the label's
folder in the Inbox instead.

## Limits and storage

- Messages larger than 25 MiB are skipped.
- Imported mail isn't AI-sorted and doesn't trigger webhooks or notifications.
  It's searchable, and Office attachments get previews.
- Storage is about twice the size of the mailbox.
- To import several mailboxes in parallel, run a separate command for each.

## Resuming

If an import stops, run the same command again. It picks up where it left off
and retries any messages that failed. Progress is saved in
`.openworkspace-import/` in the folder you ran it from, or in the folder you
give with `--state-dir`.

Even without that folder, for example on another computer, the workspace skips
messages it already has. So the same mail imported from Takeout and then over
IMAP is stored once.
