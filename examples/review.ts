/**
 * A document with an anchored discussion that follows its text through an edit, and an
 * earlier version read back.
 *
 *   pnpm add @jpowersdev/effect-documents @jpowersdev/effect-delta effect
 *   node review.ts
 */
import { Actor, Document, Documents, DocumentStorage, Thread } from "@jpowersdev/effect-documents"
import { Effect, Layer, Option } from "effect"

const program = Effect.gen(function*() {
  const documents = yield* Documents.Documents
  const actor: Actor.Actor = { by: Actor.Id.make("@owner"), via: Option.none() }
  const id = Document.Id.make("performance-map")
  const first = yield* documents.create({ id, actor, title: "Performance map", body: "Clicks take 40 ms." })
  yield* documents.apply({
    id,
    actor,
    command: {
      _tag: "Open",
      thread: Thread.Id.make("measurement"),
      start: 12,
      quote: "40 ms",
      body: "Which browser and benchmark?"
    }
  })
  const third = yield* documents.apply({
    id,
    actor,
    note: "Updated after a paired run.",
    command: { _tag: "Edit", oldString: "40 ms", newString: "32 ms in the Chromium fixture" }
  })
  yield* Effect.log(third.body)
  yield* Effect.log((yield* documents.read(id, { version: first.version })).body)
})

const DocumentsLive = Documents.layer.pipe(Layer.provide(DocumentStorage.layerMemory))
await Effect.runPromise(program.pipe(Effect.provide(DocumentsLive)))
