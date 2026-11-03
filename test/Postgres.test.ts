import { assert, describe, it } from "@effect/vitest"
import { Replica, ReplicatedText, Sync } from "@jpowersdev/effect-delta"
import * as Context from "effect/Context"
import { SecureRandom } from "effect/crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Stream from "effect/Stream"
import { Actor, Collaboration, Document, Documents, DocumentStorage, SqlDocumentStorage } from "../src/index.ts"
import { database, layerClient } from "./utils/postgres.ts"
import { freshId, revisionOf } from "./utils/storageContract.ts"

// What PGlite, with its one connection, can't show: several connections at once, the way
// several processes would use one database.

const actor: Actor.Actor = { by: Actor.Id.make("@agent"), via: Option.none() }

const storageOn = (url: string) => SqlDocumentStorage.layer.pipe(Layer.provideMerge(layerClient(url)), Layer.orDie)

const serviceOf = <I, S>(layer: Layer.Layer<I>, key: Context.Key<I, S>) =>
  Effect.map(Layer.build(layer), Context.get(key))

describe("PostgreSQL", () => {
  it.effect("processes creating the tables at once all succeed", () =>
    Effect.gen(function*() {
      const url = yield* database
      const created = yield* Effect.all(
        Array.from({ length: 8 }, () => Effect.exit(Layer.build(Layer.fresh(storageOn(url))))),
        { concurrency: "unbounded" }
      )
      assert.deepStrictEqual(created.map((exit) => exit._tag), Array.from({ length: 8 }, () => "Success"))
    }).pipe(Effect.scoped), { timeout: 20_000 })

  it.effect("of many processes racing for one version, exactly one commits", () =>
    Effect.gen(function*() {
      const url = yield* database
      const first = yield* serviceOf(Layer.fresh(storageOn(url)), DocumentStorage.DocumentStorage)
      const second = yield* serviceOf(Layer.fresh(storageOn(url)), DocumentStorage.DocumentStorage)
      const id = freshId()
      yield* first.append(revisionOf(id, 1))
      const results = yield* Effect.all(
        Array.from({ length: 16 }, (_, index) =>
          Effect.result((index % 2 === 0 ? first : second).append(revisionOf(id, 2, `writer ${index}`)))),
        { concurrency: "unbounded" }
      )
      assert.strictEqual(results.filter(Result.isSuccess).length, 1)
      for (const result of results.filter(Result.isFailure)) {
        assert.strictEqual(Option.getOrThrow(Result.getFailure(result)).reason._tag, "Conflict")
      }
      assert.deepStrictEqual(
        (yield* first.history(id)).map(({ version }) =>
          version
        ),
        [1, 2]
      )
    }).pipe(Effect.scoped), { timeout: 20_000 })

  it.effect("commands from two processes both land, with no version skipped", () =>
    Effect.gen(function*() {
      const url = yield* database
      const on = () => serviceOf(Documents.layer.pipe(Layer.provide(Layer.fresh(storageOn(url)))), Documents.Documents)
      const first = yield* on()
      const second = yield* on()
      const id = Document.Id.make("spec")
      yield* first.create({ id, actor, title: "Spec", body: "one two three four five six" })
      const words = ["one", "two", "three", "four", "five", "six"]
      yield* Effect.forEach(
        words,
        (word, index) =>
          (index % 2 === 0 ? first : second).apply({
            id,
            actor,
            command: { _tag: "Edit", oldString: word, newString: word.toUpperCase() }
          }),
        { concurrency: "unbounded", discard: true }
      )
      assert.strictEqual((yield* first.read(id)).body, "ONE TWO THREE FOUR FIVE SIX")
      assert.deepStrictEqual(
        (yield* second.history(id)).map(({ version }) => version),
        [1, 2, 3, 4, 5, 6, 7]
      )
    }).pipe(Effect.scoped), { timeout: 20_000 })

  it.effect("what one process saved live, the next picks up", () =>
    Effect.gen(function*() {
      const url = yield* database
      const id = Document.Id.make("spec")
      const session = Collaboration.layer().pipe(
        Layer.provideMerge(Layer.fresh(storageOn(url))),
        Layer.provideMerge(SecureRandom.layerWebCrypto)
      )
      // The first process stops without gathering: everything it saved is staged.
      const storage = yield* serviceOf(Layer.fresh(storageOn(url)), DocumentStorage.DocumentStorage)
      yield* Effect.gen(function*() {
        const documents = yield* Documents.Documents
        yield* documents.create({ id, actor, title: "Spec", body: "Sessions last 24 hours." })
        const ada = yield* ReplicatedText.makeConfirmed({ room: Replica.makeRoom(id) }).pipe(
          Effect.provideService(Sync.CurrentUser, "@ada")
        )
        yield* ada.connection.status.pipe(Stream.filter(({ _tag }) => _tag === "Synced"), Stream.runHead)
        yield* ReplicatedText.insert(ada, 0, "Draft: ")
        yield* ada.connection.unconfirmed.pipe(Stream.filter((count) => count === 0), Stream.runHead)
        assert.strictEqual((yield* storage.staged(id)).length, 1)
      }).pipe(Effect.scoped, Effect.provide(session))

      const documents = yield* serviceOf(
        Documents.layer.pipe(Layer.provide(Layer.fresh(storageOn(url)))),
        Documents.Documents
      )
      const history = yield* documents.history(id)
      assert.strictEqual(history.at(-1)!.action, "Merge")
      assert.deepStrictEqual(yield* storage.staged(id), [])
    }).pipe(Effect.scoped), { timeout: 20_000 })
})
