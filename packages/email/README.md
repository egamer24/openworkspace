# @open-workspace/email

Team mail for [OpenWorkspace](https://openworkspace.dev): personal and shared
inboxes, mailing lists, delivery status, attachment and Office previews, PDF
translation, sender checks, AI filing, realtime updates and web push.

```ts
// alchemy.run.ts
OpenWorkspace({
  hostname: "mail.acme.com",
  mailDomains: ["acme.com"],
  modules: [Email()],
});
```

`Email()` turns on Email Routing and Email Sending for each of the workspace's
`mailDomains`. Email Routing adds the zone's MX and SPF records and locks them,
so a zone with another provider's MX records must have them removed first, or
the deploy fails.

It takes two options. `pushContact` is the `mailto:` or `https:` contact push
services see; without it they see the app's URL. `retention` is how many days
a conversation stays in Trash or Spam before it is deleted, as
`{ trash, spam }`: Spam defaults to 30, and Trash (or a folder set to `null`)
keeps mail until someone empties it.

The module adds two permissions administrators can give to members: "Block
senders" and "Import mail". It reads one optional secret, `SPAMHAUS_DQS_KEY`,
for Spamhaus blocklist checks.

## Documentation

- [Using mail](https://openworkspace.dev/docs/mail)
- [Migrating mail and people](https://openworkspace.dev/docs/migration)
- [MCP and JMAP](https://openworkspace.dev/docs/mcp-and-jmap)
- [Development](https://openworkspace.dev/docs/development)
