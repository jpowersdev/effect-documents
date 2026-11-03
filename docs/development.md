# Development

```sh
pnpm install --ignore-scripts
pnpm exec effect-tsgo patch --typescript
pnpm check
pnpm test
pnpm test-types
pnpm lint
pnpm build
pnpm doctest
pnpm docs:build
pnpm pack-check
```

`pnpm test` starts PostgreSQL in Docker, so it needs Docker running.

`pack-check` installs the packed library in a temporary consumer, type-checks it under NodeNext and runs it with only its
peers, then runs every example in the docs and `examples/` there with Node.js alone. [`releasing.md`](releasing.md) has the release steps.
