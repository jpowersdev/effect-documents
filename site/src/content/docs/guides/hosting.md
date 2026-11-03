---
title: "What a host owns"
description: "What this library leaves to your app."
sidebar:
  order: 2
---

- **Identity.** It allocates document and thread ids, and supplies the `actor`.
- **Authorization**, before calling the service.
- **Organization, listing and search**, in its own tables, as a [projection of each revision](../storage/#project-into-your-own-tables).
- **Last-write-wins, if it wants that**, by reading the current version and passing it to `Update`.
- **Transport and UI**, including the editor. A binding loads a client's text and applies each `Remote` and `Rejected`
  patch from `ReplicatedText.subscribe`.
- **A record of removals**, if it needs one.

## Take a command from a client

`Command` has no actor or document id, so it can be an HTTP or RPC payload as is, and a client can't claim to be someone
else. The host decodes it, and supplies who and which document from its own session and route.

```ts import.meta.vitest
import {
  Actor,
  Document,
  Documents,
  DocumentStorage
} from "@jpowersdev/effect-documents"
import { Effect, Layer, Option, Schema } from "effect"

const Payload = Schema.Struct({
  note: Schema.optionalKey(Schema.String),
  command: Documents.Command
})

// What an authenticated request to PATCH /documents/spec might carry
const body = {
  note: "Tightened",
  command: { _tag: "Edit", oldString: "24", newString: "8" }
}

const program = Effect.gen(function*() {
  const documents = yield* Documents.Documents
  const id = Document.Id.make("spec")
  const actor: Actor.Actor = { by: Actor.Id.make("@ada"), via: Option.none() }
  yield* documents.create({ id, actor, title: "Spec", body: "Sessions last 24 hours." })

  const payload = yield* Schema.decodeUnknownEffect(Payload)(body)
  const edited = yield* documents.apply({ id, actor, ...payload })
  const text = edited.body
  yield* Effect.log(text)
  return text
})

const DocumentsLive = Documents.layer.pipe(Layer.provide(DocumentStorage.layerMemory))

await Effect.runPromise(program.pipe(Effect.provide(DocumentsLive))) // => "Sessions last 8 hours."
```
