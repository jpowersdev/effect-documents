# Development

Development expects an effect-delta checkout beside this one, used as a directory package (`file:`, not `link:`) so both
share one Effect runtime. Reinstall after changing it.

```sh
pnpm install --ignore-scripts
pnpm exec effect-tsgo patch --typescript
pnpm check
pnpm test
pnpm test-types
pnpm lint
pnpm build
pnpm pack-check
```

`pack-check` installs the packed library in a temporary consumer, type-checks it under NodeNext and runs it with only its
peers. [`releasing.md`](releasing.md) has the release steps.
