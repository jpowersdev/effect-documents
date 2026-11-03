---
title: "Getting started"
description: "Install effect-documents and edit a first document."
---

:::caution
Unstable: the API may change in any minor release.
:::

## Install

```sh
pnpm add @jpowersdev/effect-documents @jpowersdev/effect-delta effect
```

`effect` is a peer dependency, `^4.1.1`, and `@jpowersdev/effect-delta` one at `^0.1.0`.

## A first document

Every example in these docs is a complete program. Save this as `main.ts` and run `node main.ts`, on Node.js 24 or later
in a package with `"type": "module"`. An example that needs another package says so.

```ts import.meta.vitest
import { Actor, Document, Documents, DocumentStorage } from "@jpowersdev/effect-documents"
import { Effect, Layer, Option } from "effect"

const program = Effect.gen(function*() {
  const documents = yield* Documents.Documents
  const actor: Actor.Actor = { by: Actor.Id.make("@owner"), via: Option.none() }
  const id = Document.Id.make("performance-map")

  yield* documents.create({ id, actor, title: "Performance map", body: "Clicks take 40 ms." })
  yield* documents.apply({
    id,
    actor,
    note: "Updated after a paired run.",
    command: { _tag: "Edit", oldString: "40 ms", newString: "32 ms" }
  })

  const history = yield* documents.history(id)
  return history.map(({ action, note }) => `${action}: ${note}`)
})

const DocumentsLive = Documents.layer.pipe(Layer.provide(DocumentStorage.layerMemory))

const history = await Effect.runPromise(program.pipe(Effect.provide(DocumentsLive))) // => ["Create: ", "Edit: Updated after a paired run."]
console.log(history)
```

`Documents` is the engine, and `DocumentStorage` is where it keeps revisions. `layerMemory` is for tests and examples.
[Storage](../guides/storage/) covers databases.

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

Import from the root (`import { Documents } from "@jpowersdev/effect-documents"`) or by module
(`import * as Documents from "@jpowersdev/effect-documents/Documents"`).

## Where to next

- [Commands](../guides/commands/) covers everything that changes a document.
- [What a host owns](../guides/hosting/) covers what this library leaves to your app.
- [Live editing](../guides/live-editing/) adds people typing at the same time.
- The [API reference](../api/) covers every module.
