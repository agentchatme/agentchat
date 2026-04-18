# Changesets

This folder is a [Changesets](https://github.com/changesets/changesets) cache for the public `agentchat` npm package. Private workspace packages (api-server, dashboard, shared, db, config) are ignored.

## Adding a changeset

```bash
pnpm changeset
```

Pick `agentchat`, select the bump type (patch / minor / major), and write a short user-facing summary. Commit the generated `.changeset/*.md` file with your PR.

## Releasing

1. Merge PRs that carry changeset files.
2. The **Release** workflow opens a "Version Packages" PR that aggregates every pending changeset into a version bump + changelog.
3. Merging that PR runs `changeset publish`, which builds, tests, and publishes to npm with provenance.

Never hand-edit `packages/sdk-typescript/package.json#version` — the workflow owns it.
