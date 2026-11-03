# effect-documents

An independent Effect-native document library built on effect-delta. Consumers are
never dependencies, and work here doesn't change them. The API is unstable until its
first integrations settle the contract. Do not publish or commit unless asked;
`docs/releasing.md` has the steps.

Read `README.md` and the guides in `site/src/content/docs/guides/` for the public contract,
`how-it-works.md` there for how its guarantees are kept, and `docs/conventions.md` before
changing Effect code.

## Layout

- `src/`: namespace modules for the document engine, its storage service and SQL
  implementation, live editing, history, actors and anchored review. Internal implementation belongs
  in `src/internal/`. Built the way Effect's own packages are: match how a package in
  Effect's repository is laid out, named and documented.
- `test/`: behavior tests, and `test/utils/storageContract.ts`, which memory, SQLite,
  PostgreSQL (PGlite) and D1 (miniflare) all run. `test/consumer/` is also installed
  outside this repository by the package check.
- `typetest/`: compiler behavior of the public API, with tstyche.
- `examples/`: type-checked consumer examples.
- `site/`: the docs site. Guides are written by hand and the API reference is generated from
  doc comments (`pnpm docs:build`). `pnpm doctest` runs every example in the guides, the README
  and doc comments, and `pnpm pack-check` runs them again against the packed library.
- `scripts/pack-check.sh`: builds and packs the library and effect-delta, installs
  them in an isolated consumer, checks NodeNext types and runs the JavaScript.

The local effect-delta development dependency is a directory package at
`../effect-delta`. Use `file:`, not `link:`, so its Effect peer resolves
to the same runtime. The packed library depends on ordinary peers, not that path. A
worktree whose parent has no `effect-delta` needs a symlink there before installing.

## Validation

Use pnpm from this repository. `pnpm test` runs once, never in watch mode.

- Source or types: `pnpm check`, `pnpm test`, `pnpm test-types`, `pnpm lint`.
- Package exports or dependencies: also `pnpm build` and `pnpm pack-check`.
- Documentation only: `pnpm lint`, `pnpm doctest` and `pnpm docs:build`.
- Before a requested commit: run all of the above and report any unavailable check.

A consumer's concepts don't belong here. If an integration seems to need one, find the
general capability underneath it, as `commit` is for a host's projection.

Dependencies are pinned in development. Keep install scripts disabled unless the
user authorizes them; the project's own Effect compiler patch is documented in
the README and may be run directly. Never suppress a diagnostic to hide a failure.

Every behavior change needs a regression test. Storage changes must preserve
atomic compare-and-append, historical reads, isolated values and failure atomicity,
and a record's size must not grow with the history before it.
Concurrency tests use controlled synchronization, never sleeps or retries. Merge and
sync changes keep the convergence property tests in `test/Collaboration.test.ts` passing,
on a store that answers at once and one that takes its time: timing bugs hide on the first.
