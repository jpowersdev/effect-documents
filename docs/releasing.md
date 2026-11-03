# Releasing

effect-documents needs effect-delta on the registry first. The first release of each
is by hand, because npm's trusted publishing can only be set up for a package that
exists.

## First release

Both packages are at `0.1.0`, which their `@since` tags name, so no changeset is pending.
From a machine logged in to npm, with both repositories on their release commits:

```sh
# Each builds as it packs.
cd effect-delta
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec effect-tsgo patch
pnpm publish

cd ../effect-documents
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec effect-tsgo patch --typescript
pnpm publish
```

Check what would go out first with `pnpm publish --dry-run --no-git-checks` in each repository.

Both repositories must be public for the links in their manifests to work, though a
private one doesn't stop a publish.

## Later releases

Add a changeset to each change. To publish from CI, add a release workflow and configure
trusted publishing on npm; a public repository then gets provenance without any flag in
`publishConfig`.
