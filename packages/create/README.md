# @open-workspace/create

Creates and deploys an [OpenWorkspace](https://openworkspace.dev) in one run.

```sh
bun create @open-workspace
```

It signs you in to Cloudflare, lets you pick the account, the mail domains and
the hostname from your zones, writes the project, starts a git repository and
deploys. It ends with the address to open and create the first administrator.
`--help` lists the flags for scripted runs.

## Adding a module

```sh
bunx @open-workspace/create module time-off
```

Writes a module skeleton to `modules/time-off/` in a deployment's directory and
adds it to `alchemy.run.ts`.

## Importing mail and people

```sh
bunx @open-workspace/create import mbox ~/Takeout/Mail --workspace https://mail.acme.com --into ada@acme.com
```

Imports mail from an mbox file, a Google Takeout export or an IMAP account, and
people and teams from a Google Workspace directory.

## Documentation

- [Deploying](https://openworkspace.dev/docs/deploy)
- [Writing a module](https://openworkspace.dev/docs/modules)
- [Migration](https://openworkspace.dev/docs/migration)
