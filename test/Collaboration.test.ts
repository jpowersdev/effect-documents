import { NodeHttpServer, NodeSocket } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Authority, Delta, Replica, ReplicatedText, Sync, TextPatch } from "@jpowersdev/effect-delta"
import { SecureRandom } from "effect/crypto"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import { Headers, HttpRouter, HttpServer } from "effect/http"
import * as Layer from "effect/Layer"
import type * as NetAddress from "effect/net/NetAddress"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import type * as SqlClient from "effect/sql/SqlClient"
import * as Stream from "effect/Stream"
import { TestClock } from "effect/testing"
import {
  Actor,
  Collaboration,
  Document,
  Documents,
  DocumentStorage,
  Revision,
  SqlDocumentStorage,
  Thread
} from "../src/index.ts"
import { layerD1 } from "./utils/d1.ts"

const id = Document.Id.make("spec")
const room = Replica.makeRoom(id)
const agent: Actor.Actor = {
  by: Actor.Id.make("@agent"),
  via: Option.some({ harness: "test", model: Option.none(), session: Option.none() })
}
const body = "Sessions last 24 hours. Keep this sentence."
const thread = Thread.Id.make("question")

const Stored = DocumentStorage.layerMemory
// Collaboration over whatever store is around, so a test can keep or change it.
const Session = Collaboration.layer().pipe(Layer.provideMerge(SecureRandom.layerWebCrypto))
const Live = Session.pipe(Layer.provideMerge(Stored))

const start = Effect.flatMap(
  Documents.Documents,
  (documents) => documents.create({ id, actor: agent, title: "Spec", body })
)

/** A client typing as `user`, caught up with the server. */
const join = (user: string) =>
  Effect.gen(function*() {
    const client = yield* ReplicatedText.makeConfirmed({ room }).pipe(
      Effect.provideService(Sync.CurrentUser, user)
    )
    yield* client.connection.status.pipe(
      Stream.filter((status) => status._tag === "Synced"),
      Stream.runHead
    )
    return client
  })

/** Waits until the server has every change the client made. */
const saved = (client: ReplicatedText.Confirmed) =>
  client.connection.unconfirmed.pipe(Stream.filter((count) => count === 0), Stream.runHead, Effect.asVoid)

const showing = (client: ReplicatedText.ReplicatedText, text: string) =>
  ReplicatedText.changes(client).pipe(Stream.filter((current) => current === text), Stream.runHead, Effect.asVoid)

const apply = (actor: Actor.Actor, command: Documents.Command) =>
  Effect.flatMap(Documents.Documents, (documents) => documents.apply({ id, actor, command }))

const historyOf = Effect.flatMap(Documents.Documents, (documents) => documents.history(id))

const reason = <A, E>(result: Result.Result<A, E>): { readonly _tag: string } => {
  const failure = Option.getOrThrow(Result.getFailure(result)) as { readonly _tag: string; readonly reason?: never }
  return failure.reason ?? failure
}

/** Tells `done` about the first revision with this action to be appended. */
const noticing = (action: Revision.Info["action"], done: Deferred.Deferred<Revision.Revision>) =>
  Effect.updateService(DocumentStorage.DocumentStorage, (storage) => ({
    ...storage,
    append: (revision: Revision.Revision) =>
      Effect.tap(
        storage.append(revision),
        () => revision.action === action ? Deferred.succeed(done, revision) : Effect.void
      )
  }))

const by = (user: string) => ({ by: Actor.Id.make(user), via: Option.none() })

// The text a document's stored changes build, ignoring its snapshots.
const rebuilt = Effect.gen(function*() {
  const storage = yield* DocumentStorage.DocumentStorage
  const { version } = yield* storage.read(id)
  const text = yield* ReplicatedText.make({ replica: Replica.makeId("reader") })
  yield* Replica.receive(text, Delta.ReducerUnion.combineAll(yield* storage.changes(id, { through: version })))
  return yield* ReplicatedText.get(text)
})

describe("Collaboration", () => {
  describe("live editing", () => {
    it.effect("people see each other's typing, and it's saved before it's acknowledged", () =>
      Effect.gen(function*() {
        yield* start
        const ada = yield* join("@ada")
        const ben = yield* join("@ben")
        yield* ReplicatedText.insert(ada, 0, "Draft: ")
        yield* showing(ben, `Draft: ${body}`)
        yield* ReplicatedText.insert(ben, 0, "Ben's ")
        yield* showing(ada, `Ben's Draft: ${body}`)
        yield* Effect.all([saved(ada), saved(ben)])

        const storage = yield* DocumentStorage.DocumentStorage
        assert.strictEqual((yield* storage.staged(id)).length, 2)
        assert.strictEqual((yield* storage.read(id)).version, 1)
      }).pipe(Effect.scoped, Effect.provide(Live)))

    it.effect("gathers changes into one revision crediting everyone, once they pause", () =>
      Effect.gen(function*() {
        const merged = yield* Deferred.make<Revision.Revision>()
        yield* Effect.gen(function*() {
          yield* start
          const ada = yield* join("@ada")
          const ben = yield* join("@ben")
          yield* ReplicatedText.insert(ada, 0, "Draft: ")
          yield* TestClock.adjust("4 seconds")
          yield* ReplicatedText.insert(ben, 0, "Ben's ")
          yield* Effect.all([saved(ada), saved(ben)])
          // Each change started the wait again, so nothing's gathered yet.
          yield* TestClock.adjust("4 seconds")
          assert.strictEqual((yield* historyOf).length, 1)

          yield* TestClock.adjust("5 seconds")
          const revision = yield* Deferred.await(merged)
          assert.strictEqual(revision.action, "Merge")
          assert.strictEqual(revision.version, 2)
          assert.deepStrictEqual(revision.actors, [by("@ada"), by("@ben")])
          assert.strictEqual(revision.document.body, `Ben's Draft: ${body}`)
          assert.strictEqual(yield* rebuilt, `Ben's Draft: ${body}`)
          const storage = yield* DocumentStorage.DocumentStorage
          assert.deepStrictEqual(yield* storage.staged(id), [])
        }).pipe(Effect.scoped, Effect.provide(Session), noticing("Merge", merged))
      }).pipe(Effect.provide(Stored)))

    it.effect("a long session leaves history without ever pausing", () =>
      Effect.gen(function*() {
        const merged = yield* Deferred.make<Revision.Revision>()
        yield* Effect.gen(function*() {
          yield* start
          const ada = yield* join("@ada")
          for (let i = 0; i < 13; i++) {
            yield* ReplicatedText.insert(ada, 0, "x")
            yield* saved(ada)
            yield* TestClock.adjust("4 seconds")
          }
          const revision = yield* Deferred.await(merged)
          assert.deepStrictEqual(revision.actors, [by("@ada")])
        }).pipe(
          Effect.scoped,
          Effect.provide(
            Collaboration.layer({ idle: "5 seconds", every: "50 seconds" }).pipe(
              Layer.provideMerge(SecureRandom.layerWebCrypto)
            )
          ),
          noticing("Merge", merged)
        )
      }).pipe(Effect.provide(Stored)))

    it.effect("checkpoint gathers what was acknowledged, and nothing when there's nothing", () =>
      Effect.gen(function*() {
        yield* start
        const collaboration = yield* Collaboration.Collaboration
        assert.isTrue(Option.isNone(yield* collaboration.checkpoint(id)))
        const ada = yield* join("@ada")
        yield* ReplicatedText.insert(ada, 0, "Draft: ")
        yield* saved(ada)
        const merged = yield* collaboration.checkpoint(id)
        assert.strictEqual(Option.getOrThrow(merged).body, `Draft: ${body}`)
        assert.isTrue(Option.isNone(yield* collaboration.checkpoint(id)))
        assert.strictEqual((yield* historyOf).length, 2)
      }).pipe(Effect.scoped, Effect.provide(Live)))

    it.effect("a reader who isn't connected sees what was acknowledged", () =>
      Effect.gen(function*() {
        yield* start
        const documents = yield* Documents.Documents
        const ada = yield* join("@ada")
        yield* ReplicatedText.insert(ada, 0, "Draft: ")
        yield* saved(ada)
        assert.strictEqual((yield* documents.read(id)).body, `Draft: ${body}`)
        assert.strictEqual((yield* documents.read(id, { version: 1 })).body, body)
      }).pipe(Effect.scoped, Effect.provide(Live)))

    it.effect("a change that removes what another just removed still lands in a revision", () =>
      Effect.gen(function*() {
        yield* start
        const ada = yield* join("@ada")
        const ben = yield* join("@ben")
        yield* Effect.all([
          ReplicatedText.remove(ada, 0, 9),
          ReplicatedText.remove(ben, 0, 9)
        ])
        yield* Effect.all([saved(ada), saved(ben)])
        const merged = yield* Effect.flatMap(Collaboration.Collaboration, (c) => c.checkpoint(id))
        assert.strictEqual(Option.getOrThrow(merged).body, body.slice(9))
        assert.deepStrictEqual((yield* historyOf)[1]!.actors, [by("@ada"), by("@ben")])
      }).pipe(Effect.scoped, Effect.provide(Live)))
  })

  describe("commands during a session", () => {
    it.effect("an edit needs no version, lands in everyone's text and credits the agent", () =>
      Effect.gen(function*() {
        yield* start
        const ada = yield* join("@ada")
        yield* ReplicatedText.insert(ada, 0, "Draft: ")
        yield* saved(ada)

        const edited = yield* apply(agent, { _tag: "Edit", oldString: "24", newString: "8" })
        assert.strictEqual(edited.body, "Draft: Sessions last 8 hours. Keep this sentence.")
        yield* showing(ada, edited.body)

        // Typing before the command is its own revision, so the edit stands alone.
        const history = yield* historyOf
        assert.deepStrictEqual(history.map(({ action }) => action), ["Create", "Merge", "Edit"])
        assert.deepStrictEqual(history[1]!.actors, [by("@ada")])
        assert.deepStrictEqual(history[2]!.actors, [agent])
        assert.strictEqual(yield* rebuilt, edited.body)
      }).pipe(Effect.scoped, Effect.provide(Live)))

    it.effect("an edit fails only if its target has gone", () =>
      Effect.gen(function*() {
        yield* start
        const ada = yield* join("@ada")
        yield* ReplicatedText.remove(ada, 0, 9)
        yield* saved(ada)
        const documents = yield* Documents.Documents
        const before = (yield* documents.history(id)).length
        const missing = yield* Effect.result(apply(agent, { _tag: "Edit", oldString: "Sessions", newString: "x" }))
        assert.deepStrictEqual(reason(missing), new Documents.OldStringNotFound({ oldString: "Sessions" }))
        // The typing it found is still gathered; the edit added nothing.
        assert.deepStrictEqual((yield* documents.history(id)).map(({ action }) => action), ["Create", "Merge"])
        assert.isAbove((yield* documents.history(id)).length, before)
      }).pipe(Effect.scoped, Effect.provide(Live)))

    it.effect("an update can't undo typing its caller never saw", () =>
      Effect.gen(function*() {
        const created = yield* start
        const ada = yield* join("@ada")
        yield* ReplicatedText.insert(ada, 0, "Draft: ")
        yield* saved(ada)

        const stale = yield* Effect.result(
          apply(agent, { _tag: "Update", version: created.version, body: "Replaced." })
        )
        assert.deepStrictEqual(reason(stale), new DocumentStorage.Conflict({ id, expected: 1, actual: 2 }))
        assert.strictEqual(yield* ReplicatedText.get(ada), `Draft: ${body}`)

        const updated = yield* apply(agent, { _tag: "Update", version: 2, body: "Replaced." })
        yield* showing(ada, "Replaced.")
        assert.strictEqual(updated.version, 3)
      }).pipe(Effect.scoped, Effect.provide(Live)))

    it.effect("a title change and a restore reach the document's revisions", () =>
      Effect.gen(function*() {
        yield* start
        const ada = yield* join("@ada")
        yield* ReplicatedText.insert(ada, 0, "Draft: ")
        yield* saved(ada)
        const titled = yield* apply(agent, { _tag: "Update", version: 2, title: "Renamed" })
        assert.strictEqual(titled.title, "Renamed")
        assert.strictEqual(titled.body, `Draft: ${body}`)
        const restored = yield* apply(agent, { _tag: "Restore", version: 3, from: 1 })
        assert.strictEqual(restored.body, body)
        assert.strictEqual(restored.title, "Spec")
        yield* showing(ada, body)
      }).pipe(Effect.scoped, Effect.provide(Live)))

    it.effect("a discussion follows its passage through other people's typing", () =>
      Effect.gen(function*() {
        yield* start
        const ada = yield* join("@ada")
        const start_ = body.indexOf("Keep")
        const opened = yield* apply(agent, {
          _tag: "Open",
          thread,
          start: start_,
          quote: "Keep this",
          body: "Is this still true?"
        })
        assert.deepStrictEqual(opened.threads[0]!.range, Option.some({ start: start_, end: start_ + 9 }))

        yield* ReplicatedText.insert(ada, 0, "Draft: ")
        yield* saved(ada)
        const replied = yield* apply(agent, { _tag: "Reply", thread, body: "Yes." })
        assert.deepStrictEqual(replied.threads[0]!.range, Option.some({ start: start_ + 7, end: start_ + 16 }))

        const stale = yield* Effect.result(apply(agent, { _tag: "Resolve", version: opened.version, thread }))
        assert.strictEqual(reason(stale)._tag, "Conflict")
        yield* ReplicatedText.insert(ada, 0, "More. ")
        yield* saved(ada)
        const resolved = yield* apply(agent, { _tag: "Resolve", version: replied.version, thread })
        assert.strictEqual(Thread.status(resolved.threads[0]!.thread), "resolved")
      }).pipe(Effect.scoped, Effect.provide(Live)))

    it.effect("a client can anchor to a discussion's passage itself", () =>
      Effect.gen(function*() {
        yield* start
        const ada = yield* join("@ada")
        const opened = yield* apply(agent, { _tag: "Open", thread, start: 0, quote: "Sessions", body: "Why?" })
        yield* ReplicatedText.insert(ada, 0, "Draft: ")
        yield* showing(ada, `Draft: ${body}`)
        yield* ada.connection.sync
        assert.deepStrictEqual(
          yield* ReplicatedText.locateRange(ada, opened.threads[0]!.thread.anchor),
          Option.some({ start: 7, end: 15 })
        )
      }).pipe(Effect.scoped, Effect.provide(Live)))

    it.effect("commands on one document run one at a time", () =>
      Effect.gen(function*() {
        yield* start
        const edits = ["Sessions", "last", "hours", "Keep"].map((oldString) =>
          apply(agent, { _tag: "Edit", oldString, newString: oldString.toUpperCase() })
        )
        const results = yield* Effect.all(edits, { concurrency: "unbounded" })
        assert.deepStrictEqual(results.map(({ version }) => version).sort(), [2, 3, 4, 5])
        const documents = yield* Documents.Documents
        assert.strictEqual((yield* documents.read(id)).body, "SESSIONS LAST 24 HOURS. KEEP this sentence.")
      }).pipe(Effect.scoped, Effect.provide(Live)))
  })

  describe("access", () => {
    it.effect("a document that doesn't exist can't be joined", () =>
      Effect.gen(function*() {
        const authority = yield* Authority.Authority
        const pushed = yield* Effect.result(authority.push({ format: 1, room, delta: Delta.empty }))
        const failure = Option.getOrThrow(Result.getFailure(pushed))
        assert.strictEqual(failure.reason._tag, "Forbidden")
        const subscribed = yield* Effect.result(Stream.runHead(authority.subscribe({
          format: 1,
          room,
          strategy: "tree",
          version: {},
          authority: true
        })))
        assert.strictEqual(Option.getOrThrow(Result.getFailure(subscribed)).reason._tag, "Forbidden")
      }).pipe(Effect.scoped, Effect.provide(Live)))

    it.effect("check rejects a change, which rolls back and never reaches the history", () =>
      Effect.gen(function*() {
        yield* start
        const reviewer = yield* join("@reviewer")
        const { edits } = yield* ReplicatedText.subscribe(reviewer)
        yield* ReplicatedText.insert(reviewer, 0, "LGTM ")
        yield* edits.pipe(Stream.filter((edit) => edit._tag === "Rejected"), Stream.runHead)
        assert.strictEqual(yield* ReplicatedText.get(reviewer), body)
        const documents = yield* Documents.Documents
        assert.strictEqual((yield* documents.read(id)).body, body)
        assert.strictEqual((yield* documents.history(id)).length, 1)
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Collaboration.layer({
            check: ({ user }) =>
              user === "@reviewer"
                ? Effect.fail(new Authority.Rejected({ message: "Reviewers can comment but not edit" }))
                : Effect.void
          }).pipe(Layer.provideMerge(Stored), Layer.provideMerge(SecureRandom.layerWebCrypto))
        )
      ))

    it.effect("check isn't asked about commands, which the host has already authorized", () =>
      Effect.gen(function*() {
        yield* start
        const edited = yield* apply(agent, { _tag: "Edit", oldString: "24", newString: "8" })
        assert.strictEqual(edited.body, "Sessions last 8 hours. Keep this sentence.")
        const documents = yield* Documents.Documents
        assert.strictEqual((yield* documents.read(id)).body, edited.body)
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Collaboration.layer({
            check: () => Effect.fail(new Authority.Rejected({ message: "Nobody edits live" }))
          }).pipe(Layer.provideMerge(Stored), Layer.provideMerge(SecureRandom.layerWebCrypto))
        )
      ))

    it.effect("a client can't write under a replica id that came with the document", () =>
      Effect.gen(function*() {
        yield* start
        const storage = yield* DocumentStorage.DocumentStorage
        const [replica] = Object.keys(Delta.version(
          yield* storage.changes(id, { through: 1 }).pipe(
            Effect.map(Delta.ReducerUnion.combineAll)
          )
        ))
        const forged = yield* ReplicatedText.make({ replica: Replica.makeId(replica!) })
        const authority = yield* Authority.Authority
        yield* ReplicatedText.insert(forged, 0, "Forged")
        const pushed = yield* Effect.result(
          authority.push({ format: 1, room, delta: yield* Replica.delta(forged, {}) }).pipe(
            Effect.provideService(Sync.CurrentUser, "@mallory")
          )
        )
        assert.strictEqual(Option.getOrThrow(Result.getFailure(pushed)).reason._tag, "Forbidden")
      }).pipe(Effect.scoped, Effect.provide(Live)))

    it.effect("removing ends a document for clients who arrive later", () =>
      Effect.gen(function*() {
        yield* start
        const ada = yield* join("@ada")
        yield* ReplicatedText.insert(ada, 0, "Draft: ")
        yield* saved(ada)
        const documents = yield* Documents.Documents
        yield* documents.remove(id)
        const read = yield* Effect.result(documents.read(id))
        assert.strictEqual(reason(read)._tag, "NotFound")
        const authority = yield* Authority.Authority
        const pushed = yield* Effect.result(authority.push({ format: 1, room, delta: Delta.empty }))
        assert.strictEqual(Option.getOrThrow(Result.getFailure(pushed)).reason._tag, "Forbidden")
      }).pipe(Effect.scoped, Effect.provide(Live)))
  })

  describe("closing", () => {
    it.effect("gathers an edit that was still being saved when the session closed", () =>
      Effect.gen(function*() {
        const saving = yield* Deferred.make<void>()
        const resume = yield* Deferred.make<void>()
        const storage = yield* DocumentStorage.DocumentStorage
        const held = DocumentStorage.DocumentStorage.of({
          ...storage,
          stage: (id, changes) =>
            Effect.andThen(
              Effect.andThen(Deferred.succeed(saving, undefined), Deferred.await(resume)),
              storage.stage(id, changes)
            )
        })
        const session = yield* Scope.make()
        const context = yield* Layer.buildWithScope(
          Session.pipe(Layer.provide(Layer.succeed(DocumentStorage.DocumentStorage)(held))),
          session
        )
        yield* Effect.gen(function*() {
          yield* start
          const ada = yield* join("@ada")
          yield* ReplicatedText.insert(ada, 0, "Draft: ")
          yield* Deferred.await(saving)

          const closing = yield* Effect.forkChild(Scope.close(session, Exit.void))
          // Finalizers that don't depend on the save get to run first.
          yield* Effect.repeat(Effect.yieldNow, { times: 100 })
          yield* Deferred.succeed(resume, undefined)
          yield* Fiber.join(closing)
        }).pipe(Effect.scoped, Effect.provide(context))

        const revision = yield* storage.read(id)
        assert.strictEqual(revision.action, "Merge")
        assert.strictEqual(revision.document.body, `Draft: ${body}`)
        assert.deepStrictEqual(yield* storage.staged(id), [])
      }).pipe(Effect.provide(Stored)))

    it.effect("a released session stops following the document", () =>
      Effect.gen(function*() {
        const storage = yield* DocumentStorage.DocumentStorage
        let loads = 0
        const counting = DocumentStorage.DocumentStorage.of({
          ...storage,
          // Asked for when the session's server loads a document, and by a merge.
          writers: (id) => Effect.suspend(() => (loads++, storage.writers(id)))
        })
        yield* Effect.gen(function*() {
          yield* start
          yield* Effect.scoped(Effect.gen(function*() {
            const ada = yield* join("@ada")
            yield* ReplicatedText.insert(ada, 0, "Draft: ")
            yield* saved(ada)
          }))

          // The session's released, then the server's copy, which is only free to go
          // once the session has stopped subscribing to it.
          yield* TestClock.adjust("1 minute")
          assert.strictEqual((yield* storage.read(id)).action, "Merge")
          yield* TestClock.adjust("1 minute")

          const before = loads
          yield* Effect.scoped(join("@ben"))
          assert.strictEqual(loads, before + 1)
        }).pipe(
          Effect.scoped,
          Effect.provide(Session.pipe(Layer.provide(Layer.succeed(DocumentStorage.DocumentStorage)(counting))))
        )
      }).pipe(Effect.provide(Stored)))
  })

  describe("durability", () => {
    // A process that dies without a chance to gather: its changes are only staged.
    const stagedByALostSession = Effect.gen(function*() {
      const storage = yield* DocumentStorage.DocumentStorage
      const lost = yield* ReplicatedText.make({ replica: Replica.makeId("lost-session") })
      yield* Replica.receive(lost, Delta.ReducerUnion.combineAll(yield* storage.changes(id, { through: 1 })))
      const base = yield* Replica.version(lost)
      yield* ReplicatedText.insert(lost, 0, "Recovered: ")
      yield* storage.stage(id, yield* Replica.delta(lost, base))
    })

    it.effect("a new session picks up changes a lost one saved, with whoever typed them", () =>
      Effect.gen(function*() {
        yield* start
        yield* stagedByALostSession
        const storage = yield* DocumentStorage.DocumentStorage
        yield* storage.addWriter(id, "lost-session", "@ada")

        const documents = yield* Documents.Documents
        assert.strictEqual((yield* documents.read(id)).body, `Recovered: ${body}`)
        const history = yield* documents.history(id)
        assert.strictEqual(history[1]!.action, "Merge")
        assert.deepStrictEqual(history[1]!.actors, [by("@ada")])
        assert.deepStrictEqual(yield* storage.staged(id), [])
      }).pipe(Effect.scoped, Effect.provide(Live)))

    it.effect("changes with no recorded author are kept, credited to no one", () =>
      Effect.gen(function*() {
        yield* start
        yield* stagedByALostSession
        const documents = yield* Documents.Documents
        assert.strictEqual((yield* documents.read(id)).body, `Recovered: ${body}`)
        assert.deepStrictEqual((yield* documents.history(id))[1]!.actors, [])
      }).pipe(Effect.scoped, Effect.provide(Live)))

    it.effect("the engine without live editing gathers leftovers before its next command", () =>
      Effect.gen(function*() {
        const documents = yield* Documents.Documents
        yield* documents.create({ id, actor: agent, title: "Spec", body })
        yield* stagedByALostSession
        const edited = yield* documents.apply({
          id,
          actor: agent,
          command: { _tag: "Edit", oldString: "24", newString: "8" }
        })
        assert.strictEqual(edited.body, "Recovered: Sessions last 8 hours. Keep this sentence.")
        assert.deepStrictEqual(
          (yield* documents.history(id)).map(({ action }) => action),
          ["Create", "Merge", "Edit"]
        )
        assert.deepStrictEqual(yield* (yield* DocumentStorage.DocumentStorage).staged(id), [])
        assert.strictEqual(yield* rebuilt, edited.body)
      }).pipe(Effect.provide(Documents.layer.pipe(Layer.provideMerge(Stored)))))

    it.effect("closing gathers what's left, and a later session continues from it", () =>
      Effect.gen(function*() {
        yield* Effect.gen(function*() {
          yield* start
          const ada = yield* join("@ada")
          yield* ReplicatedText.insert(ada, 0, "Draft: ")
          yield* saved(ada)
        }).pipe(Effect.scoped, Effect.provide(Session))

        const storage = yield* DocumentStorage.DocumentStorage
        assert.strictEqual((yield* storage.read(id)).document.body, `Draft: ${body}`)
        assert.deepStrictEqual(yield* storage.staged(id), [])

        yield* Effect.gen(function*() {
          const ben = yield* join("@ben")
          assert.strictEqual(yield* ReplicatedText.get(ben), `Draft: ${body}`)
          yield* ReplicatedText.insert(ben, 0, "Ben's ")
          yield* saved(ben)
          const merged = yield* Effect.flatMap(Collaboration.Collaboration, (c) => c.checkpoint(id))
          assert.strictEqual(Option.getOrThrow(merged).body, `Ben's Draft: ${body}`)
        }).pipe(Effect.scoped, Effect.provide(Session))
        assert.strictEqual(yield* rebuilt, `Ben's Draft: ${body}`)
      }).pipe(Effect.provide(Stored)))

    it.effect("a failed gather loses nothing, and the next one succeeds", () =>
      Effect.gen(function*() {
        let failing = true
        yield* Effect.gen(function*() {
          yield* start
          const ada = yield* join("@ada")
          yield* ReplicatedText.insert(ada, 0, "Draft: ")
          yield* saved(ada)
          const collaboration = yield* Collaboration.Collaboration
          const failed = yield* Effect.result(collaboration.checkpoint(id))
          assert.strictEqual(reason(failed)._tag, "StorageFailure")
          assert.strictEqual(yield* ReplicatedText.get(ada), `Draft: ${body}`)
          failing = false
          const merged = yield* collaboration.checkpoint(id)
          assert.strictEqual(Option.getOrThrow(merged).version, 2)
          assert.strictEqual(Option.getOrThrow(merged).body, `Draft: ${body}`)
        }).pipe(
          Effect.scoped,
          Effect.provide(Session),
          Effect.updateService(DocumentStorage.DocumentStorage, (storage) => ({
            ...storage,
            append: (revision: Revision.Revision) =>
              failing && revision.action === "Merge"
                ? Effect.fail(
                  new DocumentStorage.DocumentStorageError({
                    reason: new DocumentStorage.StorageFailure({ cause: "Database unavailable" })
                  })
                )
                : storage.append(revision)
          }))
        )
      }).pipe(Effect.provide(Stored)))
  })

  describe("when the store fails", () => {
    // On the real clock, because reconnecting backs off in the background.
    it.live("a command fails rather than waiting, and its edit lands once the store is back", () =>
      Effect.gen(function*() {
        let failing = false
        yield* Effect.gen(function*() {
          yield* start
          yield* Effect.flatMap(Collaboration.Collaboration, (c) => c.checkpoint(id))
          failing = true
          const failed = yield* Effect.result(apply(agent, { _tag: "Edit", oldString: "24", newString: "8" }))
          assert.strictEqual(reason(failed)._tag, "StorageFailure")

          failing = false
          const ada = yield* join("@ada")
          yield* showing(ada, "Sessions last 8 hours. Keep this sentence.")
          const documents = yield* Documents.Documents
          assert.strictEqual((yield* documents.read(id)).body, "Sessions last 8 hours. Keep this sentence.")
        }).pipe(
          Effect.scoped,
          Effect.provide(Session),
          Effect.updateService(DocumentStorage.DocumentStorage, (storage) => ({
            ...storage,
            stage: (id: Document.Id, changes: Delta.Delta) =>
              failing
                ? Effect.fail(
                  new DocumentStorage.DocumentStorageError({
                    reason: new DocumentStorage.StorageFailure({ cause: "Database unavailable" })
                  })
                )
                : storage.stage(id, changes)
          }))
        )
      }).pipe(Effect.provide(Stored)))
  })

  describe("over SQL", () => {
    const over = <E>(client: Layer.Layer<SqlClient.SqlClient, E>) =>
      Collaboration.layer().pipe(
        Layer.provideMerge(SqlDocumentStorage.layer.pipe(Layer.orDie)),
        Layer.provideMerge(SecureRandom.layerWebCrypto),
        Layer.provide(client.pipe(Layer.orDie))
      )

    const gathers = Effect.gen(function*() {
      yield* start
      const ada = yield* join("@ada")
      yield* ReplicatedText.insert(ada, 0, "Draft: ")
      yield* saved(ada)
      const storage = yield* DocumentStorage.DocumentStorage
      assert.strictEqual((yield* storage.staged(id)).length, 1)
      assert.include(Object.values(yield* storage.writers(id)), "@ada")
      const edited = yield* apply(agent, { _tag: "Edit", oldString: "24", newString: "8" })
      assert.strictEqual(edited.body, "Draft: Sessions last 8 hours. Keep this sentence.")
      yield* showing(ada, edited.body)
      assert.deepStrictEqual(yield* storage.staged(id), [])
      assert.deepStrictEqual((yield* historyOf).map(({ action }) => action), ["Create", "Merge", "Edit"])
      assert.strictEqual(yield* rebuilt, edited.body)
    })

    it.effect("on SQLite, keeps live changes in its tables and gathers them", () =>
      gathers.pipe(Effect.scoped, Effect.provide(over(SqliteClient.layer({ filename: ":memory:" })))))

    it.effect(
      "on D1, keeps live changes in its tables and gathers them",
      () => gathers.pipe(Effect.scoped, Effect.provide(over(layerD1))),
      { timeout: 30_000 }
    )
  })

  describe("over a WebSocket", () => {
    const Users = Layer.succeed(Sync.Authorization)({
      identify: (headers) =>
        Effect.fromOption(Headers.get(headers, "x-user")).pipe(
          Effect.mapError(() => new Sync.Forbidden({ message: "Sign in first" }))
        ),
      authorize: ({ access, user }) =>
        access === "write" && user === "@viewer"
          ? Effect.fail(new Sync.Forbidden({ message: "Viewers can't edit" }))
          : Effect.void
    })

    const Server = HttpRouter.serve(
      RpcServer.layer(Sync.Rpcs).pipe(
        Layer.provide(Authority.layerHandlers),
        Layer.provide(Users),
        Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/sync" }))
      ),
      { disableListenLog: true, disableLogger: true }
    ).pipe(
      Layer.provideMerge(Live),
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provide(RpcSerialization.layerNdjson)
    )

    const connect = (user: string) =>
      Effect.gen(function*() {
        const context = yield* Layer.build(Layer.fresh(Authority.layerRemote.pipe(
          Layer.provide(RpcClient.layerProtocolSocket({ retryTransientErrors: true })),
          Layer.provide(Layer.unwrap(Effect.gen(function*() {
            const server = yield* HttpServer.HttpServer
            const address = server.address as NetAddress.InetAddress
            return NodeSocket.layerWebSocket(`http://127.0.0.1:${address.port}/sync`, { headers: { "x-user": user } })
          }))),
          Layer.provide(RpcSerialization.layerNdjson)
        )))
        return yield* ReplicatedText.makeConfirmed({ room }).pipe(Effect.provideContext(context))
      })

    it.live("real clients type together, and the server decides who they are", () =>
      Effect.gen(function*() {
        yield* start
        const ada = yield* connect("@ada")
        const ben = yield* connect("@ben")
        yield* showing(ada, body)
        yield* showing(ben, body)
        yield* ReplicatedText.insert(ada, 0, "Draft: ")
        yield* showing(ben, `Draft: ${body}`)
        yield* ReplicatedText.insert(ben, 0, "Ben's ")
        yield* showing(ada, `Ben's Draft: ${body}`)

        const edited = yield* apply(agent, { _tag: "Edit", oldString: "24", newString: "8" })
        yield* showing(ada, edited.body)
        yield* showing(ben, edited.body)
        const history = yield* historyOf
        assert.deepStrictEqual(history[1]!.actors, [by("@ada"), by("@ben")])
        assert.deepStrictEqual(history[2]!.actors, [agent])
      }).pipe(Effect.scoped, Effect.provide(Server)))

    it.live("a person who may read but not write sees text and can't change it", () =>
      Effect.gen(function*() {
        yield* start
        const viewer = yield* connect("@viewer")
        yield* showing(viewer, body)
        yield* ReplicatedText.insert(viewer, 0, "Nope ")
        const failure = yield* Effect.flip(viewer.connection.await)
        assert.strictEqual(failure.reason._tag, "Forbidden")
        const documents = yield* Documents.Documents
        assert.strictEqual((yield* documents.read(id)).body, body)
      }).pipe(Effect.scoped, Effect.provide(Server)))
  })

  describe("convergence", () => {
    const Which = Schema.Literals([0, 1, 2])
    const Fraction = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 }))
    const Step = Schema.Union([
      Schema.TaggedStruct("Type", { client: Which, at: Fraction, text: Schema.Literals(["a", "bc", "def"]) }),
      Schema.TaggedStruct("Delete", {
        client: Which,
        at: Fraction,
        length: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 }))
      }),
      Schema.TaggedStruct("Edit", { oldString: Schema.Literals(["a", "bc", "Keep"]) }),
      Schema.TaggedStruct("Reply", { body: Schema.Literals(["ok", "no"]) }),
      Schema.TaggedStruct("Checkpoint", {})
    ])

    // A store's writes take as long as they take, and others carry on meanwhile.
    const Unhurried = Layer.effect(DocumentStorage.DocumentStorage)(Effect.gen(function*() {
      const storage = yield* DocumentStorage.DocumentStorage
      const later = <A, E>(write: Effect.Effect<A, E>) =>
        Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 5 }), write)
      return DocumentStorage.DocumentStorage.of({
        ...storage,
        append: (revision) => later(storage.append(revision)),
        stage: (id, changes) => later(storage.stage(id, changes)),
        unstage: (id, options) => later(storage.unstage(id, options))
      })
    }))

    const stores = [
      ["a store that answers at once", Stored],
      ["a store that takes its time", Unhurried.pipe(Layer.provide(Stored))]
    ] as const

    for (const [name, store] of stores) {
      it.effect.prop(
        `everyone ends with the same text, which the history can rebuild, on ${name}`,
        { steps: Schema.Array(Step).check(Schema.isMaxLength(30)) },
        Effect.fnUntraced(function*({ steps }) {
          yield* Effect.gen(function*() {
            yield* start
            const clients = [yield* join("@a"), yield* join("@b"), yield* join("@c")]
            yield* apply(agent, { _tag: "Open", thread, start: 0, quote: "Sessions", body: "Why?" })
            for (const step of steps) {
              switch (step._tag) {
                case "Type": {
                  // Worked out from the text under the replica's lock: others' changes land at any moment.
                  yield* ReplicatedText.modify(clients[step.client]!, ({ length }) => [
                    undefined,
                    TextPatch.insert(Math.floor(step.at * (length + 1) / 1001), step.text)
                  ])
                  break
                }
                case "Delete": {
                  yield* ReplicatedText.modify(clients[step.client]!, ({ length }) => {
                    const index = Math.floor(step.at * length / 1001)
                    return [
                      undefined,
                      length === 0 ? TextPatch.empty : TextPatch.remove(index, Math.min(step.length, length - index))
                    ]
                  })
                  break
                }
                case "Edit":
                  yield* Effect.ignore(apply(agent, {
                    _tag: "Edit",
                    oldString: step.oldString,
                    newString: step.oldString.toUpperCase(),
                    replaceAll: true
                  }))
                  break
                case "Reply":
                  yield* apply(agent, { _tag: "Reply", thread, body: step.body })
                  break
                case "Checkpoint":
                  yield* Effect.flatMap(Collaboration.Collaboration, (c) => c.checkpoint(id))
                  break
              }
            }
            yield* Effect.forEach(clients, saved)
            yield* Effect.forEach(clients, (client) => client.connection.sync)
            const texts = yield* Effect.forEach(clients, ReplicatedText.get)
            assert.strictEqual(texts[1], texts[0])
            assert.strictEqual(texts[2], texts[0])

            yield* Effect.flatMap(Collaboration.Collaboration, (c) => c.checkpoint(id))
            const storage = yield* DocumentStorage.DocumentStorage
            const documents = yield* Documents.Documents
            assert.strictEqual((yield* documents.read(id)).body, texts[0])
            assert.strictEqual(yield* rebuilt, texts[0])
            assert.deepStrictEqual(yield* storage.staged(id), [])
            assert.deepStrictEqual(
              (yield* documents.history(id)).map(({ version }) => version),
              Array.from({ length: (yield* documents.history(id)).length }, (_, i) => i + 1)
            )
          }).pipe(Effect.scoped, Effect.provide(Session.pipe(Layer.provideMerge(store))))
        })
      )
    }
  })

  describe("while a fiber is typing", () => {
    it.effect("a command and a stream of typing both land", () =>
      Effect.gen(function*() {
        yield* start
        const ada = yield* join("@ada")
        const typing = yield* Effect.forkChild(
          Effect.forEach(Array.from({ length: 50 }), () => ReplicatedText.insert(ada, 0, "x"), { discard: true })
        )
        const edited = yield* apply(agent, { _tag: "Edit", oldString: "24", newString: "8" })
        assert.include(edited.body, "last 8 hours")
        yield* Fiber.join(typing)
        yield* saved(ada)
        yield* ada.connection.sync
        assert.strictEqual(
          yield* ReplicatedText.get(ada),
          `${"x".repeat(50)}Sessions last 8 hours. Keep this sentence.`
        )
        const documents = yield* Documents.Documents
        assert.strictEqual((yield* documents.read(id)).body, yield* ReplicatedText.get(ada))
      }).pipe(Effect.scoped, Effect.provide(Live)))
  })
})
