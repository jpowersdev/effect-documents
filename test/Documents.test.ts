import { assert, describe, it } from "@effect/vitest"
import { Delta } from "@jpowersdev/effect-delta"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { Actor, Document, Documents, DocumentStorage, Revision, Thread } from "../src/index.ts"

const id = Document.Id.make("investigation")
const actor: Actor.Actor = {
  by: Actor.Id.make("@owner"),
  via: Option.some({ harness: "test-agent", model: Option.some("test-model"), session: Option.some("session") })
}
const thread = Thread.Id.make("question")
const initial = { id, actor, title: "Investigation", body: "First old. Keep this passage. Second old." }
const Live = Documents.layer.pipe(Layer.provideMerge(DocumentStorage.layerMemory))

/** A command as a caller writes it, with the version it read given separately. */
type Unversioned = Documents.Command extends infer C ? C extends unknown ? Omit<C, "version"> : never : never

const withVersion = (version: number, command: Unversioned) =>
  (command._tag === "Update" || command._tag === "Resolve" || command._tag === "Restore"
    ? { ...command, version }
    : command) as Documents.Command

const run = (version: number, command: Unversioned, note?: string) =>
  Effect.flatMap(
    Documents.Documents,
    (documents) =>
      documents.apply({
        id,
        actor,
        command: withVersion(version, command),
        ...(note === undefined ? {} : { note })
      })
  )

// Few distinct tokens, so generated texts share lines and prefixes worth keeping.
const lines = Schema.Array(Schema.Literals(["a", "b", "\n", "\r\n", "😀", "same line\n"]))

const open = (version: number, start: number, quote: string) =>
  run(version, { _tag: "Open", thread, start, quote, body: "Why?" })

/** The reason a command was rejected, asserting that it changed nothing. */
const rejected = (version: number, command: Unversioned) =>
  Effect.gen(function*() {
    const documents = yield* Documents.Documents
    const before = yield* documents.read(id)
    const history = (yield* documents.history(id)).length
    const failure = Option.getOrThrow(Result.getFailure(yield* Effect.result(run(version, command))))
    assert.deepStrictEqual(yield* documents.read(id), before)
    assert.strictEqual((yield* documents.history(id)).length, history)
    return "reason" in failure ? failure.reason : failure
  })

/** The same engine, with one of its storage's operations replaced. */
const withStorage = <A, E>(
  change: (base: DocumentStorage.DocumentStorage["Service"]) => Partial<DocumentStorage.DocumentStorage["Service"]>,
  body: Effect.Effect<A, E, Documents.Documents>
) =>
  Effect.gen(function*() {
    const base = yield* DocumentStorage.DocumentStorage
    return yield* body.pipe(
      Effect.provide(Documents.layer),
      Effect.provideService(
        DocumentStorage.DocumentStorage,
        DocumentStorage.DocumentStorage.of({
          ...base,
          ...change(base)
        })
      )
    )
  }).pipe(Effect.provide(DocumentStorage.layerMemory))

describe("Documents", () => {
  describe("history", () => {
    it.effect("keeps attributed revisions and reads earlier content", () =>
      Effect.gen(function*() {
        const documents = yield* Documents.Documents
        const first = yield* documents.create(initial)
        const second = yield* run(first.version, {
          _tag: "Edit",
          oldString: "First old",
          newString: "First new"
        }, "Measured it.")
        assert.strictEqual(second.version, 2)
        assert.strictEqual(second.body, "First new. Keep this passage. Second old.")
        assert.deepStrictEqual(yield* documents.read(id, { version: 1 }), first)
        const history = yield* documents.history(id)
        assert.deepStrictEqual(history.map((entry) => entry.action), ["Create", "Edit"])
        assert.deepStrictEqual(history[1]!.actors[0], actor)
        assert.strictEqual(history[0]!.note, "")
        assert.strictEqual(history[1]!.note, "Measured it.")
      }).pipe(Effect.provide(Live)))

    it.effect("a record holds only its own text changes, so it doesn't grow with history", () =>
      Effect.gen(function*() {
        const documents = yield* Documents.Documents
        const storage = yield* DocumentStorage.DocumentStorage
        const size = () =>
          storage.read(id).pipe(
            Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(Revision.Revision))),
            Effect.map((encoded) => encoded.length)
          )
        yield* documents.create({ ...initial, body: "a b" })
        yield* run(1, { _tag: "Update", body: "c b" })
        const first = yield* size()
        let version = 2
        for (const body of ["d b", "e b", "f b", "g b", "h b", "i b", "j b", "k b"]) {
          yield* run(version++, { _tag: "Update", body })
        }
        assert.approximately(yield* size(), first, 16)
      }).pipe(Effect.provide(Live)))

    it.effect("restores content as a new revision and keeps newer discussions", () =>
      Effect.gen(function*() {
        const documents = yield* Documents.Documents
        yield* documents.create(initial)
        yield* run(1, { _tag: "Edit", oldString: "First old", newString: "First new" })
        yield* open(2, 11, "Keep this passage")
        const restored = yield* run(3, { _tag: "Restore", from: 1 }, "Reconsidering.")
        assert.strictEqual(restored.version, 4)
        assert.strictEqual(restored.body, initial.body)
        assert.deepStrictEqual(restored.threads[0]!.range, Option.some({ start: 11, end: 28 }))
        assert.deepStrictEqual((yield* documents.history(id))[3]!.restoredFrom, Option.some(1))
        assert.strictEqual(
          (yield* documents.read(id, { version: 2 })).body,
          "First new. Keep this passage. Second old."
        )
      }).pipe(Effect.provide(Live)))

    it.effect("a fresh engine over stored revisions has the same anchors and attribution", () =>
      Effect.gen(function*() {
        const json = Schema.fromJsonString(Revision.Revision)
        const saved = yield* Effect.gen(function*() {
          const documents = yield* Documents.Documents
          const storage = yield* DocumentStorage.DocumentStorage
          yield* documents.create(initial)
          yield* open(1, 11, "Keep this passage")
          return {
            view: yield* documents.read(id),
            revisions: [
              yield* Schema.encodeEffect(json)(yield* storage.read(id, { version: 1 })),
              yield* Schema.encodeEffect(json)(yield* storage.read(id, { version: 2 }))
            ]
          }
        }).pipe(Effect.provide(Live))
        yield* Effect.gen(function*() {
          const storage = yield* DocumentStorage.DocumentStorage
          const documents = yield* Documents.Documents
          for (const entry of saved.revisions) yield* storage.append(yield* Schema.decodeEffect(json)(entry))
          assert.deepStrictEqual(yield* documents.read(id), saved.view)
          const shifted = yield* run(2, { _tag: "Edit", oldString: "First", newString: "A longer first" })
          assert.deepStrictEqual(shifted.threads[0]!.range, Option.some({ start: 20, end: 37 }))
        }).pipe(Effect.provide(Live))
      }))

    it.effect("removing deletes a document and frees its id", () =>
      Effect.gen(function*() {
        const documents = yield* Documents.Documents
        yield* documents.create(initial)
        yield* run(1, { _tag: "Update", title: "Findings" })
        yield* documents.remove(id)
        const gone = Option.getOrThrow(Result.getFailure(yield* Effect.result(documents.read(id))))
        assert.strictEqual("reason" in gone ? gone.reason._tag : gone._tag, "NotFound")
        assert.strictEqual((yield* documents.create(initial)).version, 1)
        assert.strictEqual((yield* documents.history(id)).length, 1)
      }).pipe(Effect.provide(Live)))

    it.effect("reading an invalid version is a schema failure, and a missing one NotFound", () =>
      Effect.gen(function*() {
        const documents = yield* Documents.Documents
        yield* documents.create(initial)
        const invalid = Option.getOrThrow(Result.getFailure(yield* Effect.result(documents.read(id, { version: 0 }))))
        assert.strictEqual(invalid._tag, "SchemaError")
        const missing = Option.getOrThrow(Result.getFailure(yield* Effect.result(documents.read(id, { version: 2 }))))
        assert.strictEqual("reason" in missing ? missing.reason._tag : missing._tag, "NotFound")
      }).pipe(Effect.provide(Live)))
  })

  describe("Edit", () => {
    it.effect("needs a unique match unless replaceAll is set", () =>
      Effect.gen(function*() {
        const documents = yield* Documents.Documents
        yield* documents.create(initial)
        assert.deepStrictEqual(
          yield* rejected(1, { _tag: "Edit", oldString: "old", newString: "new" }),
          new Documents.AmbiguousOldString({ oldString: "old", occurrences: 2 })
        )
        const replaced = yield* run(1, { _tag: "Edit", oldString: "old", newString: "new", replaceAll: true })
        assert.strictEqual(replaced.body, "First new. Keep this passage. Second new.")
      }).pipe(Effect.provide(Live)))

    it.effect("rejects a missing match and an edit that changes nothing", () =>
      Effect.gen(function*() {
        const documents = yield* Documents.Documents
        yield* documents.create(initial)
        assert.deepStrictEqual(
          yield* rejected(1, { _tag: "Edit", oldString: "missing", newString: "new" }),
          new Documents.OldStringNotFound({ oldString: "missing" })
        )
        assert.deepStrictEqual(
          yield* rejected(1, { _tag: "Edit", oldString: "First", newString: "First" }),
          new Documents.Unchanged()
        )
      }).pipe(Effect.provide(Live)))

    it.effect("rejects an empty search as a schema failure", () =>
      Effect.gen(function*() {
        const documents = yield* Documents.Documents
        yield* documents.create(initial)
        const failure = yield* rejected(1, { _tag: "Edit", oldString: "", newString: "new" })
        assert.strictEqual(failure._tag, "SchemaError")
      }).pipe(Effect.provide(Live)))

    it.effect("keeps anchors between separate replacements and treats its text literally", () =>
      Effect.gen(function*() {
        const documents = yield* Documents.Documents
        yield* documents.create(initial)
        yield* open(1, 11, "Keep this passage")
        const edited = yield* run(2, { _tag: "Edit", oldString: "old", newString: "$&", replaceAll: true })
        assert.strictEqual(edited.body, "First $&. Keep this passage. Second $&.")
        assert.deepStrictEqual(edited.threads[0]!.range, Option.some({ start: 10, end: 27 }))
        const removed = yield* run(3, { _tag: "Edit", oldString: "Keep this passage", newString: "" })
        assert.deepStrictEqual(removed.threads[0]!.range, Option.none())
        assert.strictEqual(removed.threads[0]!.thread.quote, "Keep this passage")
      }).pipe(Effect.provide(Live)))

    it.effect("rejects an edit that splits a character", () =>
      Effect.gen(function*() {
        const documents = yield* Documents.Documents
        yield* documents.create({ ...initial, body: "Hello 😀 world" })
        const failure = yield* rejected(1, { _tag: "Edit", oldString: "\ud83d", newString: "x" })
        assert.strictEqual(failure._tag, "SplitsSurrogatePair")
      }).pipe(Effect.provide(Live)))
  })

  describe("Update", () => {
    it.effect("changes title and body in one revision", () =>
      Effect.gen(function*() {
        const documents = yield* Documents.Documents
        yield* documents.create(initial)
        const updated = yield* run(1, { _tag: "Update", title: "Findings", body: "New body." })
        assert.strictEqual(updated.version, 2)
        assert.strictEqual(updated.title, "Findings")
        assert.strictEqual(updated.body, "New body.")
        assert.deepStrictEqual((yield* documents.history(id)).map((entry) => entry.action), ["Create", "Update"])
      }).pipe(Effect.provide(Live)))

    it.effect("keeps anchors on lines between two changes", () =>
      Effect.gen(function*() {
        const documents = yield* Documents.Documents
        yield* documents.create({ ...initial, body: "One\nKeep this.\nThree\n" })
        yield* open(1, 4, "Keep this.")
        const updated = yield* run(2, { _tag: "Update", body: "One changed\nKeep this.\nThree changed\n" })
        assert.strictEqual(updated.body, "One changed\nKeep this.\nThree changed\n")
        assert.deepStrictEqual(updated.threads[0]!.range, Option.some({ start: 12, end: 22 }))
      }).pipe(Effect.provide(Live)))

    it.effect("keeps anchors in the unchanged part of a changed line", () =>
      Effect.gen(function*() {
        const documents = yield* Documents.Documents
        yield* documents.create({ ...initial, body: "Clicks take 40 ms today." })
        yield* open(1, 0, "Clicks")
        const updated = yield* run(2, { _tag: "Update", body: "Clicks take 32 ms today." })
        assert.deepStrictEqual(updated.threads[0]!.range, Option.some({ start: 0, end: 6 }))
      }).pipe(Effect.provide(Live)))

    it.effect("gives exactly the text asked for, whatever its line endings", () =>
      Effect.gen(function*() {
        const documents = yield* Documents.Documents
        yield* documents.create({ ...initial, body: "a\r\nb\n\nc" })
        const updated = yield* run(1, { _tag: "Update", body: "😀\r\nb\n\n\nc\n" })
        assert.strictEqual(updated.body, "😀\r\nb\n\n\nc\n")
      }).pipe(Effect.provide(Live)))

    it.effect.prop(
      "a replica ends on exactly the text asked for, through any sequence of updates",
      [lines, lines, lines],
      ([first, second, third]) =>
        Effect.gen(function*() {
          const documents = yield* Documents.Documents
          const bodies = [second.join(""), third.join("")].filter((body, index, all) =>
            body !== (index === 0 ? first.join("") : all[index - 1])
          )
          yield* documents.create({ ...initial, body: first.join("") })
          let version = 1
          for (const body of bodies) {
            const updated = yield* run(version++, { _tag: "Update", body })
            assert.strictEqual(updated.body, body)
          }
          // What the replica holds, not the request: the next edit rebuilds from stored changes.
          const final = yield* documents.read(id)
          const appended = yield* run(version, { _tag: "Update", body: `${final.body}!` })
          assert.strictEqual(appended.body, `${final.body}!`)
        }).pipe(Effect.provide(Live))
    )

    it.effect("rejects an update that changes nothing", () =>
      Effect.gen(function*() {
        const documents = yield* Documents.Documents
        yield* documents.create(initial)
        for (
          const command of [{ _tag: "Update" }, { _tag: "Update", title: initial.title, body: initial.body }] as const
        ) {
          assert.deepStrictEqual(yield* rejected(1, command), new Documents.Unchanged())
        }
      }).pipe(Effect.provide(Live)))
  })

  describe("review", () => {
    it.effect("a reply reopens review and makes an earlier resolution stale", () =>
      Effect.gen(function*() {
        const documents = yield* Documents.Documents
        yield* documents.create(initial)
        yield* open(1, 0, "First")
        const resolved = yield* run(2, { _tag: "Resolve", thread })
        assert.strictEqual(Thread.status(resolved.threads[0]!.thread), "resolved")
        const replied = yield* run(3, { _tag: "Reply", thread, body: "One more question." })
        assert.strictEqual(Thread.status(replied.threads[0]!.thread), "open")
        assert.strictEqual((yield* rejected(3, { _tag: "Resolve", thread }))._tag, "Conflict")
        assert.deepStrictEqual(replied.threads[0]!.thread.events.map((event) => event.action), [
          "Open",
          "Resolve",
          "Reply"
        ])
      }).pipe(Effect.provide(Live)))

    it.effect("rejects a changed quote, a missing discussion and a duplicate one", () =>
      Effect.gen(function*() {
        const documents = yield* Documents.Documents
        yield* documents.create(initial)
        assert.deepStrictEqual(
          yield* rejected(1, { _tag: "Open", thread, start: 6, quote: "wrong", body: "Why?" }),
          new Documents.QuoteChanged({ quote: "wrong", start: 6 })
        )
        assert.deepStrictEqual(
          yield* rejected(1, { _tag: "Reply", thread, body: "Missing" }),
          new Documents.ThreadNotFound({ thread })
        )
        yield* open(1, 0, "First")
        assert.deepStrictEqual(
          yield* rejected(2, { _tag: "Open", thread, start: 0, quote: "First", body: "Again" }),
          new Documents.ThreadAlreadyExists({ thread })
        )
      }).pipe(Effect.provide(Live)))

    it.effect("a thread id can't collide with an object's inherited keys", () =>
      Effect.gen(function*() {
        const documents = yield* Documents.Documents
        yield* documents.create(initial)
        const proto = Thread.Id.make("__proto__")
        assert.deepStrictEqual(
          yield* rejected(1, { _tag: "Reply", thread: proto, body: "Missing" }),
          new Documents.ThreadNotFound({ thread: proto })
        )
        const opened = yield* run(1, { _tag: "Open", thread: proto, start: 0, quote: "First", body: "Why?" })
        assert.strictEqual(opened.threads[0]!.thread.id, proto)
      }).pipe(Effect.provide(Live)))

    it.effect("rebuilds the text's history only for commands that need it", () =>
      Effect.gen(function*() {
        const rebuilds = yield* Ref.make(0)
        yield* withStorage(
          (base) => ({
            changes: (id, options) => Effect.andThen(Ref.update(rebuilds, (n) => n + 1), base.changes(id, options))
          }),
          Effect.gen(function*() {
            const documents = yield* Documents.Documents
            yield* documents.create(initial)
            yield* open(1, 0, "First")
            assert.strictEqual(yield* Ref.get(rebuilds), 1)
            yield* run(2, { _tag: "Reply", thread, body: "More." })
            yield* run(3, { _tag: "Resolve", thread })
            yield* run(4, { _tag: "Reopen", thread })
            yield* run(5, { _tag: "Update", title: "Findings" })
            yield* documents.read(id)
            yield* documents.read(id, { version: 1 })
            yield* documents.history(id)
            assert.strictEqual(yield* Ref.get(rebuilds), 1)
            yield* run(6, { _tag: "Update", body: "New." })
            assert.strictEqual(yield* Ref.get(rebuilds), 2)
          })
        )
      }))
  })

  describe("failure", () => {
    it.effect("rejects a stale update or restore with the versions involved", () =>
      Effect.gen(function*() {
        const documents = yield* Documents.Documents
        yield* documents.create(initial)
        yield* run(1, { _tag: "Update", title: "Findings" })
        assert.deepStrictEqual(
          yield* rejected(1, { _tag: "Update", title: "Stale" }),
          new DocumentStorage.Conflict({ id, expected: 1, actual: 2 })
        )
        assert.deepStrictEqual(
          yield* rejected(1, { _tag: "Restore", from: 1 }),
          new DocumentStorage.Conflict({ id, expected: 1, actual: 2 })
        )
      }).pipe(Effect.provide(Live)))

    it.effect("an edit applies to the current text, whatever its caller last read", () =>
      Effect.gen(function*() {
        const documents = yield* Documents.Documents
        yield* documents.create(initial)
        yield* run(1, { _tag: "Update", body: "First old. Rewritten." })
        const edited = yield* run(1, { _tag: "Edit", oldString: "First", newString: "new" })
        assert.strictEqual(edited.body, "new old. Rewritten.")
        assert.deepStrictEqual(
          yield* rejected(1, { _tag: "Edit", oldString: "Keep this passage", newString: "x" }),
          new Documents.OldStringNotFound({ oldString: "Keep this passage" })
        )
      }).pipe(Effect.provide(Live)))

    it.effect("a resolution is stale only if the discussion moved on, not if the text did", () =>
      Effect.gen(function*() {
        const documents = yield* Documents.Documents
        yield* documents.create(initial)
        const opened = yield* open(1, 0, "First")
        yield* run(1, { _tag: "Edit", oldString: "Second", newString: "Later" })
        const replied = yield* run(1, { _tag: "Reply", thread, body: "One more thing." })
        assert.deepStrictEqual(
          yield* rejected(opened.version, { _tag: "Resolve", thread }),
          new DocumentStorage.Conflict({ id, expected: opened.version, actual: replied.version })
        )
        yield* run(1, { _tag: "Edit", oldString: "Later", newString: "Last" })
        const resolved = yield* run(replied.version, { _tag: "Resolve", thread })
        assert.strictEqual(Thread.status(resolved.threads[0]!.thread), "resolved")
      }).pipe(Effect.provide(Live)))

    // Another writer's command commits just before this one's first attempt does.
    const racing = (winner: Documents.Command, loser: Documents.Command) =>
      Effect.gen(function*() {
        const raced = yield* Ref.make(false)
        return yield* withStorage(
          (base) => ({
            append: Effect.fnUntraced(function*(entry) {
              if (entry.version > 1 && !(yield* Ref.getAndSet(raced, true))) {
                const other = yield* Documents.make.pipe(Effect.provideService(DocumentStorage.DocumentStorage, base))
                yield* other.apply({ id, actor, command: winner }).pipe(Effect.orDie)
              }
              yield* base.append(entry)
            })
          }),
          Effect.gen(function*() {
            const documents = yield* Documents.Documents
            yield* documents.create(initial)
            return yield* Effect.result(documents.apply({ id, actor, command: loser }))
          })
        )
      }).pipe(Effect.provide(DocumentStorage.layerMemory))

    it.effect("an edit that loses a race is worked out again from the winner's text", () =>
      Effect.gen(function*() {
        const result = yield* racing(
          { _tag: "Edit", oldString: "First", newString: "Winner" },
          { _tag: "Edit", oldString: "Second", newString: "Loser" }
        )
        const document = Result.getOrThrow(result)
        assert.strictEqual(document.version, 3)
        assert.strictEqual(document.body, "Winner old. Keep this passage. Loser old.")
      }))

    it.effect("an edit whose target the winner removed fails instead of landing elsewhere", () =>
      Effect.gen(function*() {
        const result = yield* racing(
          { _tag: "Edit", oldString: "Second", newString: "Winner" },
          { _tag: "Edit", oldString: "Second", newString: "Loser" }
        )
        const failure = Option.getOrThrow(Result.getFailure(result))
        assert.deepStrictEqual(
          "reason" in failure ? failure.reason : failure,
          new Documents.OldStringNotFound({ oldString: "Second" })
        )
      }))

    it.effect("an update that loses a race is never retried", () =>
      Effect.gen(function*() {
        const result = yield* racing(
          { _tag: "Edit", oldString: "First", newString: "Winner" },
          { _tag: "Update", version: 1, title: "Loser" }
        )
        const failure = Option.getOrThrow(Result.getFailure(result))
        assert.deepStrictEqual(
          "reason" in failure ? failure.reason : failure,
          new DocumentStorage.Conflict({ id, expected: 1, actual: 2 })
        )
      }))

    it.effect("creating over an existing document conflicts and overwrites nothing", () =>
      Effect.gen(function*() {
        const documents = yield* Documents.Documents
        const before = yield* documents.create(initial)
        const failure = Option.getOrThrow(
          Result.getFailure(yield* Effect.result(documents.create({ ...initial, body: "Overwrite" })))
        )
        assert.strictEqual("reason" in failure ? failure.reason._tag : failure._tag, "Conflict")
        assert.deepStrictEqual(yield* documents.read(id), before)
      }).pipe(Effect.provide(Live)))

    it.effect("two commands prepared from the same revision cannot both commit", () =>
      Effect.gen(function*() {
        const arrivals = yield* Ref.make(0)
        const ready = yield* Deferred.make<void>()
        yield* withStorage(
          (base) => ({
            append: Effect.fnUntraced(function*(entry) {
              if (entry.version === 2) {
                if ((yield* Ref.updateAndGet(arrivals, (n) => n + 1)) === 2) yield* Deferred.succeed(ready, undefined)
                yield* Deferred.await(ready)
              }
              yield* base.append(entry)
            })
          }),
          Effect.gen(function*() {
            const documents = yield* Documents.Documents
            yield* documents.create(initial)
            const results = yield* Effect.all([
              Effect.result(run(1, { _tag: "Update", title: "A" })),
              Effect.result(run(1, { _tag: "Update", title: "B" }))
            ], { concurrency: "unbounded" })
            assert.strictEqual(results.filter(Result.isSuccess).length, 1)
            const failure = results.find(Result.isFailure)!.failure
            assert.strictEqual("reason" in failure ? failure.reason._tag : failure._tag, "Conflict")
            assert.strictEqual((yield* documents.history(id)).length, 2)
          })
        ).pipe(Effect.timeout("5 seconds"))
      }))

    it.effect("a failed commit can't leak text or review data into the next read", () =>
      withStorage(
        (base) => ({
          append: (entry) =>
            entry.version > 1
              ? Effect.fail(
                new DocumentStorage.DocumentStorageError({
                  reason: new DocumentStorage.StorageFailure({ cause: "disk unavailable" })
                })
              )
              : base.append(entry)
        }),
        Effect.gen(function*() {
          const documents = yield* Documents.Documents
          const before = yield* documents.create(initial)
          const edit = yield* rejected(1, { _tag: "Edit", oldString: "First", newString: "Changed" })
          assert.strictEqual(edit._tag, "StorageFailure")
          const review = yield* rejected(1, { _tag: "Open", thread, start: 0, quote: "First", body: "Why?" })
          assert.strictEqual(review._tag, "StorageFailure")
          assert.deepStrictEqual(yield* documents.read(id), before)
        })
      ))

    it.effect("interruption before commit leaves the existing revision readable", () =>
      Effect.gen(function*() {
        const arrived = yield* Deferred.make<void>()
        yield* withStorage(
          (base) => ({
            append: Effect.fnUntraced(function*(entry) {
              if (entry.version === 2) {
                yield* Deferred.succeed(arrived, undefined)
                return yield* Effect.never
              }
              yield* base.append(entry)
            })
          }),
          Effect.gen(function*() {
            const documents = yield* Documents.Documents
            const before = yield* documents.create(initial)
            const fiber = yield* Effect.forkChild(run(1, { _tag: "Update", title: "Interrupted" }))
            yield* Deferred.await(arrived)
            yield* Fiber.interrupt(fiber)
            assert.deepStrictEqual(yield* documents.read(id), before)
            assert.strictEqual((yield* documents.history(id)).length, 1)
          })
        ).pipe(Effect.timeout("5 seconds"))
      }))

    it.effect("a change the text can't accept fails as a storage failure, not a defect", () =>
      withStorage(
        () => ({
          // Claims five characters and carries one, which no honest replica produces.
          changes: () =>
            Effect.map(
              Schema.decodeEffect(Delta.Delta)({
                format: 1,
                changes: [{
                  replica: "broken",
                  seq: 0,
                  length: 5,
                  parents: [],
                  ops: [{ _tag: "Insert", text: "x", parent: null, side: "L" }]
                }]
              }),
              (delta) => [delta]
            ).pipe(Effect.orDie)
        }),
        Effect.gen(function*() {
          const documents = yield* Documents.Documents
          yield* documents.create(initial)
          const failure = yield* rejected(1, { _tag: "Edit", oldString: "First", newString: "new" })
          assert.strictEqual(failure._tag, "StorageFailure")
        })
      ))
  })

  describe("boundary", () => {
    it.effect("a command decodes from JSON with no actor or document id, for hosts to accept directly", () =>
      Effect.gen(function*() {
        const command = yield* Schema.decodeEffect(Documents.Command)({
          _tag: "Edit",
          oldString: "First",
          newString: "new"
        })
        const documents = yield* Documents.Documents
        yield* documents.create(initial)
        assert.strictEqual((yield* run(1, command)).body, "new old. Keep this passage. Second old.")
      }).pipe(Effect.provide(Live)))

    it.effect("rejects properties a command doesn't have", () =>
      Effect.gen(function*() {
        const documents = yield* Documents.Documents
        yield* documents.create(initial)
        const failure = Option.getOrThrow(Result.getFailure(
          yield* Effect.result(documents.apply({
            id,
            actor,
            command: { _tag: "Update", version: 1, title: "New", extra: true } as Documents.Command
          }))
        ))
        assert.strictEqual(failure._tag, "SchemaError")
      }).pipe(Effect.provide(Live)))

    it("errors say what went wrong", () => {
      const conflict = new DocumentStorage.DocumentStorageError({
        reason: new DocumentStorage.Conflict({ id, expected: 1, actual: 2 })
      })
      assert.include(conflict.message, "version 2, not 1")
      assert.strictEqual(conflict.cause, conflict.reason)
      const edit = new Documents.DocumentsError({ reason: new Documents.OldStringNotFound({ oldString: "a\nb" }) })
      assert.include(edit.message, JSON.stringify("a\nb"))
    })
  })
})
