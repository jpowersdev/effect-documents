# Effect conventions

Use the installed Effect version's `AGENTS.md`, `ai-docs/src` and `src` as the API
reference. This library targets Effect 4; do not assume Effect 3 names or behavior.

- Modules are namespaces: `import { Documents, DocumentStorage } from "effect-documents"`.
  Public modules use PascalCase names; implementation files live under `internal/`
  and are not exported. Keep application concepts out of the library.
- Source imports each module on its own: `import * as Effect from "effect/Effect"`,
  `import * as Delta from "effect-delta/Delta"`. Tests and examples may use the barrels.
- The library name is the only namespace token: replacing `effect-documents` with
  `effect/documents` must give the core form of every service key and identifier. It
  never appears in anything encoded, so stored data outlives a move into Effect. The manifest, `sideEffects`, build and test
  layout follow a package in the Effect repository; check there before inventing one.
- Follow an Effect precedent for a new concept. Storage follows `effect/cluster`:
  `RunnerStorage` beside `SqlRunnerStorage`, with `make`, `layer`, `layerWith`,
  `layerStorage` and `layerMigrations`.
- Use `Effect.fnUntraced` for reusable library functions and `Effect.gen` for inline
  composition. Use `Effect.fn("name")` when a tracing span serves the consumer.
  Give exported functions accurate result, error and requirement types.
- Functions over values support data-first and data-last forms with `dual` when
  appropriate. Services are `Context.Service` classes with package-qualified keys;
  layers wire dependencies at the application boundary.
- Boundary data has a Schema. Expected failures are one tagged error with a `reason`
  union of tagged classes that have messages, as `SqlError` does; a message names the
  value that failed and quotes input. Let a `SchemaError` through rather than wrapping
  it. Defects indicate broken invariants. A command that names a version is never applied
  to newer content; any other is worked out again from the current text.
- Decide from values rather than driver error classes where you can: D1 reports every
  SQL failure as `UnknownError`, so a conflict is told apart by reading the version.
- A SQL client can defer every call, as a proxied D1 client does. Don't branch on
  `sql.onDialect*` in a statement passed to `commit`, whose callback's result a deferred
  client can't resolve inside a batch. Prefer one statement that's valid on each dialect.
- Use Effect services for clocks, randomness, cryptography, filesystem and other
  platform operations. A test can supply its own clock and dependencies.
- Keep mutable text replicas private to one command, except a collaboration session's,
  which every command on that document shares under its lock. Content, attribution and
  revision history commit as one atomic store operation. Failed or interrupted
  preparation must not change later reads.
- Read a shared replica's text, anchors and changes together with `consistent`, because
  another replica's changes can arrive between any two reads.
- Public declarations have a multiline JSDoc block with `@stability`, `@category` and
  `@since`, and sections in Effect's order: `**When to use**`, `**Details**`,
  `**Gotchas**`. Write options inline unless several APIs share them. The explicit
  allow-lists permit intentional use of unstable and experimental APIs; API stability
  checks remain enabled for source.
- Tests use `@effect/vitest`, deterministic synchronization and the smallest case
  that demonstrates the behavior. Compiler behavior belongs in `typetest/` with tstyche.
  Run the packaged-consumer check to catch hidden workspace dependencies and export
  problems. Add to the storage contract rather than to one store's tests.

Format with dprint: two spaces, no semicolons, double quotes, 120 columns. Prefer
Effect's `Option` and `Result` for modeled absence and synchronous failure. Options
are trailing optional objects. Defaults and caller-visible guarantees belong in
the API documentation.
