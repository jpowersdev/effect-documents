<p align="center">
  <img src="assets/logo.svg" width="128" height="128" alt="">
</p>

<h1 align="center">effect-documents</h1>

<p align="center">
  Versioned Markdown documents with attributed history, anchored review and live editing, built on <a href="https://effect.website">Effect</a> and <a href="https://github.com/jpowersdev/effect-delta">effect-delta</a>.
</p>

<p align="center">
  <a href="https://jpowersdev.github.io/effect-documents/">Documentation</a> ·
  <a href="https://jpowersdev.github.io/effect-documents/api/">API reference</a>
</p>

> Unstable: the API may change in any minor release.

```sh
pnpm add @jpowersdev/effect-documents @jpowersdev/effect-delta effect
```

`effect` is a peer dependency, `^4.1.1`, and `@jpowersdev/effect-delta` one at `^0.1.0`.

## Use

Save this as `main.ts` and run `node main.ts`, on Node.js 24 or later in a package with `"type": "module"`.

```ts import.meta.vitest
import { Actor, Document, Documents, DocumentStorage } from "@jpowersdev/effect-documents"
import { Effect, Layer, Option } from "effect"

const program = Effect.gen(function*() {
  const documents = yield* Documents.Documents
  const actor: Actor.Actor = { by: Actor.Id.make("@owner"), via: Option.none() }
  const id = Document.Id.make("performance-map")
  const first = yield* documents.create({ id, actor, title: "Performance map", body: "Clicks take 40 ms." })
  yield* documents.apply({
    id,
    actor,
    note: "Updated after a paired run.",
    command: { _tag: "Edit", oldString: "40 ms", newString: "32 ms" }
  })
  const now = yield* documents.read(id)
  const original = yield* documents.read(id, { version: first.version })
  const bodies = [now.body, original.body]
  yield* Effect.log(bodies)
  return bodies
})

const DocumentsLive = Documents.layer.pipe(Layer.provide(DocumentStorage.layerMemory))

await Effect.runPromise(program.pipe(Effect.provide(DocumentsLive))) // => ["Clicks take 32 ms.", "Clicks take 40 ms."]
```

The [documentation](https://jpowersdev.github.io/effect-documents/) has guides and the API reference, and
[`examples/`](examples) has fuller programs, including two people typing while an agent edits.

## Modules

| Module               | What it is                                                 |
| -------------------- | ---------------------------------------------------------- |
| `Documents`          | The engine: `create`, `read`, `apply`, `history`, `remove` |
| `Collaboration`      | Live editing alongside commands                            |
| `DocumentStorage`    | The storage service and its contract; `layerMemory`        |
| `SqlDocumentStorage` | Durable storage on SQLite, D1 and PostgreSQL               |
| `Document`           | What a reader sees at one version                          |
| `Revision`           | An immutable history record                                |
| `Thread`             | An anchored discussion                                     |
| `Actor`              | Who a change is attributed to                              |

## Development

See [`docs/development.md`](docs/development.md).

## License

MIT
