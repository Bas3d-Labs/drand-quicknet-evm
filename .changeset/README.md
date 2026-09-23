# Package release notes

Changesets records release intent for the public packages:

- `@based-labs/drand-quicknet`
- `@based-labs/drand-quicknet-registry`

## Describe a package change

From the repository root, run:

```bash
pnpm changeset
```

Select the affected public packages, choose each version bump, and write
a summary of the user-facing changes.

Commit the generated `.changeset/*.md` file alongside the implementation.
Describe what changed and any migration steps consumers need.

Follow the repository's versioning policy when choosing a bump. Changesets
records your selection; it does not determine compatibility automatically.

## Independent package versions

The packages are versioned independently:

- A Quicknet release also schedules at least a patch release of the
  registry SDK because the SDK depends on Quicknet through `workspace:*`.
- An SDK-only release does not require a Quicknet release.
- Private workspace packages are not versioned or tagged by Changesets.

When packing the SDK, pnpm replaces `workspace:*` with the exact Quicknet
version. Keep the workspace dependency declaration unchanged in source.

## Changes that do not require a release

For changes that intentionally require no public package release, you may
record that decision with an empty changeset:

```bash
pnpm changeset --empty
```

Edit the generated file to explain the decision below its empty frontmatter:

```markdown
---
---

No package release: updates contributor documentation only.
```

Commit that file with the change. Use an empty changeset only when no
public package release is needed.

## Inspect pending releases

```bash
pnpm changeset:status
```

Review the complete plan, including automatic dependency bumps.

Creating a changeset or inspecting its status does not change package
versions or publish packages.

## Release workflow

After changesets merge into `main`, GitHub Actions creates or updates a
release PR containing version, changelog, and lockfile changes.

New release PRs start as drafts. Updating an existing release PR does not
return it to draft status.

Maintainers review release intent and version-bump choices. CI does not
require every package change to include a changeset.

Package publishing and release tagging remain manual after the release
PR is merged.

See [the release guide](../docs/releasing.md) for review and CI approval
instructions.