import { Replica, ReplicatedText, Sync } from "@jpowersdev/effect-delta"
import { Actor, Collaboration, Document, Documents, DocumentStorage, SqlDocumentStorage } from "@jpowersdev/effect-documents"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"

assert.equal(typeof SqlDocumentStorage.layerStorage, "function")
new DatabaseSync(":memory:").close()

const Live = Documents.layer.pipe(Layer.provide(DocumentStorage.layerMemory))

await Effect.runPromise(Effect.gen(function*() {
  const documents = yield* Documents.Documents
  const id = Document.Id.make("external-consumer")
  const actor = { by: Actor.Id.make("@owner"), via: Option.none() }
  yield* documents.create({ id, actor, title: "Installed package", body: "Before" })
  const command = { _tag: "Edit", oldString: "Before", newString: "After" }
  const after = yield* documents.apply({ id, actor, command })
  assert.equal(after.body, "After")
  assert.equal((yield* documents.read(id, { version: 1 })).body, "Before")
  assert.equal((yield* documents.history(id)).length, 2)
}).pipe(Effect.provide(Live)))

// Someone typing while a command runs, with nothing but the published peers.
const LiveTogether = Collaboration.layer().pipe(
  Layer.provideMerge(DocumentStorage.layerMemory),
  Layer.provideMerge(SecureRandom.layerWebCrypto)
)

await Effect.runPromise(Effect.gen(function*() {
  const documents = yield* Documents.Documents
  const id = Document.Id.make("live-consumer")
  const actor = { by: Actor.Id.make("@agent"), via: Option.none() }
  yield* documents.create({ id, actor, title: "Installed package", body: "Before" })
  const ada = yield* ReplicatedText.makeConfirmed({ document: Replica.DocumentId.make(id) }).pipe(
    Effect.provideService(Sync.CurrentUser, "@ada")
  )
  yield* ada.connection.status.pipe(Stream.filter((status) => status._tag === "Synced"), Stream.runHead)
  yield* ReplicatedText.insert(ada, 0, "Typed. ")
  yield* ada.connection.unconfirmed.pipe(Stream.filter((count) => count === 0), Stream.runHead)
  const after = yield* documents.apply({ id, actor, command: { _tag: "Edit", oldString: "Before", newString: "After" } })
  assert.equal(after.body, "Typed. After")
  assert.deepEqual((yield* documents.history(id)).map(({ action }) => action), ["Create", "Merge", "Edit"])
}).pipe(Effect.scoped, Effect.provide(LiveTogether)))
