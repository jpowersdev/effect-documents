import { assert, describe, it } from "@effect/vitest"
import { Delta, Replica, ReplicatedText } from "@jpowersdev/effect-delta"
import * as Effect from "effect/Effect"
import * as Equal from "effect/Equal"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import { Actor, Document, DocumentStorage, type Revision } from "../../src/index.ts"

const actor: Actor.Actor = { by: Actor.Id.make("@owner"), via: Option.none() }

let documents = 0

/** A document id no other case in the same database uses. */
export const freshId = () => Document.Id.make(`document-${++documents}`)

/** The smallest valid revision at `version` of `id`. */
export const revisionOf = (id: Document.Id, version: number, title = `v${version}`): Revision.Revision => ({
  version,
  action: version === 1 ? "Create" : "Update",
  actors: [actor],
  at: version,
  note: "",
  restoredFrom: Option.none(),
  document: { id, title, body: "", version, threads: [] },
  changes: Delta.empty
})

/** Changes that insert `text`, made by `replica`. */
const deltaOf = (replica: string, text: string) =>
  Effect.gen(function*() {
    const made = yield* ReplicatedText.make({ replica: Replica.makeId(replica) })
    yield* ReplicatedText.insert(made, 0, text)
    return yield* Replica.delta(made, {})
  }).pipe(Effect.orDie)

const reasonOf = <A>(result: Result.Result<A, DocumentStorage.DocumentStorageError>) =>
  Option.getOrThrow(Result.getFailure(result)).reason

/**
 * The guarantees every `DocumentStorage` makes, whatever holds the revisions: an
 * atomic compare-and-append, historical reads, isolated values and unchanged
 * storage after a failure.
 */
export const storageContract = <E>(name: string, layer: Layer.Layer<DocumentStorage.DocumentStorage, E>) =>
  describe(name, () => {
    it.layer(layer)((it) => {
      it.effect("creating needs an absent document and reads back as version one", () =>
        Effect.gen(function*() {
          const storage = yield* DocumentStorage.DocumentStorage
          const id = freshId()
          yield* storage.append(revisionOf(id, 1))
          const stored = yield* storage.read(id)
          assert.strictEqual(stored.version, 1)
          assert.strictEqual(stored.document.title, "v1")
          const again = yield* Effect.result(storage.append(revisionOf(id, 1, "overwritten")))
          assert.deepStrictEqual(
            reasonOf(again),
            new DocumentStorage.Conflict({ id, expected: 0, actual: 1 })
          )
          assert.strictEqual((yield* storage.read(id)).document.title, "v1")
        }))

      it.effect("rejects a stale version and a skipped version, and changes nothing", () =>
        Effect.gen(function*() {
          const storage = yield* DocumentStorage.DocumentStorage
          const id = freshId()
          yield* storage.append(revisionOf(id, 1))
          yield* storage.append(revisionOf(id, 2))
          const stale = reasonOf(yield* Effect.result(storage.append(revisionOf(id, 2, "stale"))))
          assert.deepStrictEqual(stale, new DocumentStorage.Conflict({ id, expected: 1, actual: 2 }))
          const skipped = reasonOf(yield* Effect.result(storage.append(revisionOf(id, 4))))
          assert.deepStrictEqual(skipped, new DocumentStorage.Conflict({ id, expected: 3, actual: 2 }))
          assert.deepStrictEqual((yield* storage.history(id)).map((entry) => entry.version), [1, 2])
          assert.strictEqual((yield* storage.read(id)).document.title, "v2")
        }))

      it.effect("a version past a document that doesn't exist conflicts with zero", () =>
        Effect.gen(function*() {
          const storage = yield* DocumentStorage.DocumentStorage
          const id = freshId()
          const failed = reasonOf(yield* Effect.result(storage.append(revisionOf(id, 2))))
          assert.deepStrictEqual(failed, new DocumentStorage.Conflict({ id, expected: 1, actual: 0 }))
        }))

      it.effect("lets exactly one of two racing appends commit", () =>
        Effect.gen(function*() {
          const storage = yield* DocumentStorage.DocumentStorage
          const id = freshId()
          yield* storage.append(revisionOf(id, 1))
          const results = yield* Effect.all([
            Effect.result(storage.append(revisionOf(id, 2, "A"))),
            Effect.result(storage.append(revisionOf(id, 2, "B")))
          ], { concurrency: "unbounded" })
          assert.strictEqual(results.filter(Result.isSuccess).length, 1)
          assert.strictEqual(reasonOf(results.find(Result.isFailure)!)._tag, "Conflict")
          assert.strictEqual((yield* storage.history(id)).length, 2)
        }))

      it.effect("reads current and historical versions", () =>
        Effect.gen(function*() {
          const storage = yield* DocumentStorage.DocumentStorage
          const id = freshId()
          yield* storage.append(revisionOf(id, 1))
          yield* storage.append(revisionOf(id, 2))
          assert.strictEqual((yield* storage.read(id)).version, 2)
          assert.strictEqual((yield* storage.read(id, { version: 1 })).document.title, "v1")
          const missing = reasonOf(yield* Effect.result(storage.read(id, { version: 3 })))
          assert.deepStrictEqual(missing, new DocumentStorage.NotFound({ id, version: Option.some(3) }))
        }))

      it.effect("every read of an unknown document fails with NotFound", () =>
        Effect.gen(function*() {
          const storage = yield* DocumentStorage.DocumentStorage
          const id = freshId()
          const notFound = new DocumentStorage.NotFound({ id, version: Option.none() })
          assert.deepStrictEqual(reasonOf(yield* Effect.result(storage.read(id))), notFound)
          assert.deepStrictEqual(reasonOf(yield* Effect.result(storage.history(id))), notFound)
          assert.deepStrictEqual(reasonOf(yield* Effect.result(storage.changes(id, { through: 1 }))), notFound)
          assert.deepStrictEqual(reasonOf(yield* Effect.result(storage.remove(id))), notFound)
        }))

      it.effect("changes stop at the version asked for", () =>
        Effect.gen(function*() {
          const storage = yield* DocumentStorage.DocumentStorage
          const id = freshId()
          yield* storage.append(revisionOf(id, 1))
          yield* storage.append(revisionOf(id, 2))
          yield* storage.append(revisionOf(id, 3))
          assert.strictEqual((yield* storage.changes(id, { through: 2 })).length, 2)
        }))

      it.effect("returns values isolated from what it holds", () =>
        Effect.gen(function*() {
          const storage = yield* DocumentStorage.DocumentStorage
          const id = freshId()
          yield* storage.append(revisionOf(id, 1))
          Object.assign((yield* storage.read(id)).document, { title: "mutated" })
          Object.assign((yield* storage.history(id))[0]!.actors[0]!, { by: "@someone-else" })
          assert.strictEqual((yield* storage.read(id)).document.title, "v1")
          assert.deepStrictEqual((yield* storage.history(id))[0]!.actors[0], actor)
        }))

      it.effect("staged changes come back in order until they're unstaged", () =>
        Effect.gen(function*() {
          const storage = yield* DocumentStorage.DocumentStorage
          const id = freshId()
          yield* storage.append(revisionOf(id, 1))
          assert.deepStrictEqual(yield* storage.staged(id), [])
          const first = yield* deltaOf("a", "one")
          const second = yield* deltaOf("b", "two")
          const third = yield* deltaOf("c", "three")
          yield* storage.stage(id, first)
          yield* storage.stage(id, second)
          yield* storage.stage(id, third)
          const staged = yield* storage.staged(id)
          assert.isTrue(staged[0]!.position < staged[1]!.position && staged[1]!.position < staged[2]!.position)
          assert.isTrue(Equal.equals(staged[1]!.changes, second))

          yield* storage.unstage(id, { through: staged[1]!.position })
          const left = yield* storage.staged(id)
          assert.strictEqual(left.length, 1)
          assert.isTrue(Equal.equals(left[0]!.changes, third))

          // Positions keep rising while anything is staged.
          yield* storage.stage(id, first)
          const later = yield* storage.staged(id)
          assert.isTrue(later[0]!.position < later[1]!.position)
          assert.deepStrictEqual(yield* storage.read(id).pipe(Effect.map((revision) => revision.version)), 1)
        }))

      it.effect("keeps any text exactly, including what a database might mishandle", () =>
        Effect.gen(function*() {
          const storage = yield* DocumentStorage.DocumentStorage
          const id = freshId()
          const text = "NUL \u0000, emoji 😀, quotes ' \" \\, placeholders $1 ? %s, newline \n."
          const revision = revisionOf(id, 1, text)
          yield* storage.append({ ...revision, document: { ...revision.document, body: text } })
          const stored = yield* storage.read(id)
          assert.strictEqual(stored.document.title, text)
          assert.strictEqual(stored.document.body, text)

          const changes = yield* deltaOf("a", text)
          yield* storage.stage(id, changes)
          assert.isTrue(Equal.equals((yield* storage.staged(id))[0]!.changes, changes))
        }))

      it.effect("a replica keeps its first owner", () =>
        Effect.gen(function*() {
          const storage = yield* DocumentStorage.DocumentStorage
          const id = freshId()
          assert.deepStrictEqual(yield* storage.writers(id), {})
          yield* storage.addWriter(id, "replica", "@first")
          yield* storage.addWriter(id, "replica", "@second")
          yield* storage.addWriter(id, "constructor", "@other")
          assert.deepStrictEqual(yield* storage.writers(id), { replica: "@first", constructor: "@other" })
        }))

      it.effect("removing also forgets staged changes and writers", () =>
        Effect.gen(function*() {
          const storage = yield* DocumentStorage.DocumentStorage
          const id = freshId()
          yield* storage.append(revisionOf(id, 1))
          yield* storage.stage(id, yield* deltaOf("a", "one"))
          yield* storage.addWriter(id, "a", "@owner")
          yield* storage.remove(id)
          assert.deepStrictEqual(yield* storage.staged(id), [])
          assert.deepStrictEqual(yield* storage.writers(id), {})
        }))

      it.effect("removing deletes the whole history and frees the id", () =>
        Effect.gen(function*() {
          const storage = yield* DocumentStorage.DocumentStorage
          const id = freshId()
          const other = freshId()
          yield* storage.append(revisionOf(id, 1))
          yield* storage.append(revisionOf(id, 2))
          yield* storage.append(revisionOf(other, 1))
          yield* storage.remove(id)
          assert.strictEqual(reasonOf(yield* Effect.result(storage.read(id)))._tag, "NotFound")
          assert.strictEqual((yield* storage.read(other)).version, 1)
          yield* storage.append(revisionOf(id, 1, "again"))
          assert.strictEqual((yield* storage.read(id)).document.title, "again")
        }))
    })
  })
