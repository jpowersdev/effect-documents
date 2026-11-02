# Releasing

effect-documents needs effect-delta on the registry first. The first release of each
is by hand, because npm's trusted publishing can only be set up for a package that
exists. Both names are unscoped on purpose: see "The library name is the only namespace
token" in effect-delta's `docs/research/effect-fit.md`.

## First release

Both packages are at `0.1.0`, which their `@since` tags name, so no changeset is pending.
From a machine logged in to npm, with both repositories on their release commits:

```sh
# effect-delta. Its script builds with stripInternal, which edits tsconfig.base.json.
cd effect-delta
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec effect-tsgo patch
pnpm changeset-publish
git checkout tsconfig.base.json

# effect-documents, which builds as it packs.
cd ../effect-documents
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec effect-tsgo patch --typescript
pnpm publish
```

Check what would go out first with `pnpm publish --dry-run --no-git-checks` in each package.

Both repositories must be public for the links in their manifests to work, though a
private one doesn't stop a publish.

## Using a release

Replace the `file:` development dependency with the released version, and run the checks.
A consumer with a minimum release age needs the new versions in its
`minimumReleaseAgeExclude`:

```yaml
minimumReleaseAgeExclude:
  - "effect-delta@0.1.0"
  - "effect-documents@0.1.0"
```

## Later releases

Add a changeset to each change. To publish from CI, copy `effect-agent`'s
`.github/workflows/release.yml` and configure trusted publishing on npm; a public
repository then gets provenance without any flag in `publishConfig`.
