/**
 * The `Collaboration` module lets people edit a document at the same time, from any
 * number of replicas, alongside commands from the `Documents` service.
 *
 * Clients sync through effect-delta's `Authority`, over any RPC protocol, so
 * reconnecting, offline work and per-document permissions come from there. Each
 * change is saved before it's acknowledged. The module's job is to fit those changes
 * into a document's history: it gathers them into a `Merge` revision once they pause,
 * and before any command runs, so a history holds what a person would call an edit
 * rather than a keystroke.
 *
 * `layer` provides `Documents`, `Authority` and `Collaboration` together, because all
 * of a document's writers have to go through one place.
 *
 * **Example** (Two people typing while an agent edits)
 *
 * ```ts import.meta.vitest
 * import { Replica, ReplicatedText, Sync } from "@jpowersdev/effect-delta"
 * import { Actor, Collaboration, Document, Documents, DocumentStorage } from "@jpowersdev/effect-documents"
 * import { Effect, Layer, Option, Stream } from "effect"
 * import { SecureRandom } from "effect/crypto"
 *
 * const program = Effect.gen(function*() {
 *   const documents = yield* Documents.Documents
 *   const id = Document.Id.make("spec")
 *   const agent: Actor.Actor = {
 *     by: Actor.Id.make("@agent"),
 *     via: Option.none()
 *   }
 *   yield* documents.create({
 *     id,
 *     actor: agent,
 *     title: "Spec",
 *     body: "Sessions last 24 hours."
 *   })
 *
 *   const client = yield* ReplicatedText.makeConfirmed({
 *     room: Replica.RoomId.make(id)
 *   }).pipe(
 *     Effect.provideService(Sync.CurrentUser, "@ada")
 *   )
 *   yield* ReplicatedText.changes(client).pipe(Stream.filter((text) => text.length > 0), Stream.runHead)
 *   yield* ReplicatedText.insert(client, 0, "Draft: ")
 *   yield* client.connection.unconfirmed.pipe(Stream.filter((count) => count === 0), Stream.runHead)
 *
 *   const edited = yield* documents.apply({
 *     id,
 *     actor: agent,
 *     command: {
 *       _tag: "Edit",
 *       oldString: "24",
 *       newString: "8"
 *     }
 *   })
 *   return edited.body
 * })
 *
 * const CollaborationLive = Collaboration.layer().pipe(
 *   Layer.provideMerge(DocumentStorage.layerMemory),
 *   Layer.provideMerge(SecureRandom.layerWebCrypto)
 * )
 * await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(CollaborationLive))) // => "Draft: Sessions last 8 hours."
 * ```
 *
 * @stability unstable
 * @since 0.1.0
 */
import * as Authority from "@jpowersdev/effect-delta/Authority"
import * as Delta from "@jpowersdev/effect-delta/Delta"
import * as HistoryStore from "@jpowersdev/effect-delta/HistoryStore"
import * as Replica from "@jpowersdev/effect-delta/Replica"
import * as ReplicatedText from "@jpowersdev/effect-delta/ReplicatedText"
import * as Sync from "@jpowersdev/effect-delta/Sync"
import * as Context from "effect/Context"
import * as SecureRandom from "effect/crypto/SecureRandom"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as RcMap from "effect/RcMap"
import * as Ref from "effect/Ref"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import * as Document from "./Document.ts"
import * as Documents from "./Documents.ts"
import * as DocumentStorage from "./DocumentStorage.ts"

/**
 * Bringing a document's live changes into its history.
 *
 * **Details**
 *
 * - `checkpoint` gathers a document's live changes into a `Merge` revision now, and
 *   returns the document it produced, or `None` if there were none. It runs by
 *   itself when changes pause, so a host only needs it where a timer can't run, such
 *   as on an alarm in a runtime that evicts idle processes.
 *
 * @stability unstable
 * @category services
 * @since 0.1.0
 */
export class Collaboration extends Context.Service<Collaboration, {
  readonly checkpoint: (
    id: Document.Id
  ) => Effect.Effect<Option.Option<Document.Document>, DocumentStorage.DocumentStorageError>
}>()("effect-documents/Collaboration") {}

// Who the server's own replica writes as. Never stored: a replica id with no
// recorded owner belongs to the server.
const serverUser = "effect-documents/server"

const unavailable = (error: { readonly message: string }) =>
  new Sync.SyncError({ reason: new Sync.Unavailable({ message: error.message }) })

const fromStorage = (error: DocumentStorage.DocumentStorageError) =>
  error.reason._tag === "NotFound"
    ? new Sync.SyncError({ reason: new Sync.Forbidden({ message: error.message }) })
    : unavailable(error)

const storageFailure = (cause: unknown) =>
  new DocumentStorage.DocumentStorageError({ reason: new DocumentStorage.StorageFailure({ cause }) })

const historyError = (cause: DocumentStorage.DocumentStorageError) =>
  new HistoryStore.HistoryStoreError({ message: cause.message, cause })

// What effect-delta's server keeps, in a document's revisions and staged changes.
const makeHistoryStore = (
  storage: DocumentStorage.DocumentStorage["Service"]
): HistoryStore.HistoryStore["Service"] => {
  const idOf = (room: Replica.RoomId) => Document.Id.make(room)
  return HistoryStore.HistoryStore.of({
    load: (room) =>
      Effect.gen(function*() {
        const id = idOf(room)
        const { version } = yield* storage.read(id)
        const history = Delta.ReducerUnion.combineAll([
          ...yield* storage.changes(id, { through: version }),
          ...(yield* storage.staged(id)).map(({ changes }) => changes)
        ])
        const writers = yield* storage.writers(id)
        const owners: Record<string, string> = {}
        for (const replica of Object.keys(Delta.version(history))) owners[replica] = serverUser
        return Option.some<HistoryStore.Stored>({
          history,
          unconfirmed: Delta.empty,
          writers: { ...owners, ...writers },
          snapshot: Option.none()
        })
      }).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(Option.none<HistoryStore.Stored>())
        ),
        Effect.mapError(historyError)
      ),
    append: (room, delta) => storage.stage(idOf(room), delta).pipe(Effect.mapError(historyError)),
    addWriter: (room, replica, owner) =>
      owner === serverUser
        ? Effect.void
        : storage.addWriter(idOf(room), replica, owner).pipe(Effect.mapError(historyError)),
    // Only a replica persisting itself uses these, and this store's replica is the
    // server, which keeps its changes as staged ones.
    setUnconfirmed: () => Effect.void,
    setSnapshot: () => Effect.void
  })
}

// A document's live state: everything that writes to it goes through here.
interface Session {
  readonly workspace: Documents.Workspace
  readonly lock: Semaphore.Semaphore
  /** Gathers what was acknowledged before now. Run it with the lock held. */
  readonly gather: Effect.Effect<Option.Option<Document.Document>, DocumentStorage.DocumentStorageError>
}

/**
 * Provides `Documents`, an `Authority` for clients to sync through, and
 * `Collaboration`, over one store.
 *
 * **When to use**
 *
 * Use instead of `Documents.layer` when documents can be edited live. Serve the
 * `Authority` with `Authority.layerHandlers`, and give clients
 * `ReplicatedText.makeConfirmed`.
 *
 * **Details**
 *
 * - `check` decides whether a change is accepted, as `Authority.layer`'s does. It
 *   isn't asked about commands, which the host authorizes before calling them.
 * - `idle` is how long changes must pause before they're gathered into a revision.
 *   Defaults to five seconds.
 * - `every` gathers them regardless, so a long session still leaves a history.
 *   Defaults to one minute.
 * - `release` is how long a document with no clients or commands stays in memory.
 *   Defaults to one minute.
 *
 * Subscribing to or pushing to a document that doesn't exist fails as `Forbidden`.
 * Live changes join a revision's `actors` under the user id `Sync.Authorization`
 * gave them.
 *
 * If the store fails while a command's edit is being saved, the command fails with
 * a `StorageFailure`, but the edit is already in the shared text and lands once the
 * store is back. Read again before deciding to retry.
 *
 * **Gotchas**
 *
 * Every writer of a document must use the same instance of this layer, so run one per
 * document or per process, not one per request. A document removed here can't be
 * recreated under the same id until a minute after its last client has gone, because
 * the `Authority` holds it in memory until then.
 *
 * @stability unstable
 * @category layers
 * @since 0.1.0
 */
export const layer = <R = never>(options?: {
  readonly check?: ((proposal: Authority.Proposal) => Effect.Effect<void, Authority.Rejected, R>) | undefined
  readonly idle?: Duration.Input | undefined
  readonly every?: Duration.Input | undefined
  readonly release?: Duration.Input | undefined
}): Layer.Layer<
  Collaboration | Documents.Documents | Authority.Authority,
  never,
  DocumentStorage.DocumentStorage | SecureRandom.SecureRandom | R
> =>
  Layer.effectContext(Effect.gen(function*() {
    const storage = yield* DocumentStorage.DocumentStorage
    const check = options?.check
    const random = yield* SecureRandom.SecureRandom
    const server = Context.get(
      yield* Layer.build(
        Authority.layer<R>({
          check: (proposal) => proposal.user === serverUser || check === undefined ? Effect.void : check(proposal)
        }).pipe(Layer.provide(Layer.succeed(HistoryStore.HistoryStore)(makeHistoryStore(storage))))
      ),
      Authority.Authority
    )

    const open = Effect.fnUntraced(function*(id: Document.Id) {
      const { version } = yield* storage.read(id)
      const base = yield* Ref.make(Delta.version(
        Delta.ReducerUnion.combineAll(yield* storage.changes(id, { through: version }))
      ))
      const text = yield* ReplicatedText.makeConfirmed({ room: Replica.RoomId.make(id) }).pipe(
        Effect.provideService(Sync.CurrentUser, serverUser),
        Effect.provideService(Authority.Authority, server),
        Effect.provideService(SecureRandom.SecureRandom, random)
      )
      yield* text.connection.status.pipe(
        Stream.filter((status) => status._tag === "Synced"),
        Stream.runHead,
        Effect.raceFirst(text.connection.await),
        Effect.mapError(storageFailure)
      )
      const workspace: Documents.Workspace = {
        load: Effect.map(Ref.get(base), (base) => ({ text, base })),
        shared: true,
        // The connection keeps retrying, and the edit lands once it gets through, but
        // the command that made it shouldn't wait for that holding the lock.
        settle: () =>
          text.connection.unconfirmed.pipe(
            Stream.filter((count) => count === 0),
            Stream.runHead,
            Effect.asVoid,
            Effect.raceFirst(
              text.connection.status.pipe(
                Stream.runForEach((status) =>
                  status._tag === "Offline" ? Effect.fail(storageFailure(status.error)) : Effect.void
                )
              )
            )
          ),
        committed: (version) => Ref.set(base, version)
      }
      const session: Session = {
        workspace,
        lock: yield* Semaphore.make(1),
        gather: text.connection.sync.pipe(
          Effect.mapError(storageFailure),
          Effect.andThen(Documents.merge({ storage, workspace, id }))
        )
      }

      const gatherLater = session.lock.withPermit(session.gather).pipe(
        Effect.tapError((error) => Effect.logWarning("Couldn't gather live changes", error)),
        Effect.ignore
      )
      yield* ReplicatedText.changes(text).pipe(
        Stream.debounce(options?.idle ?? "5 seconds"),
        // A tick comes straight away too, which there's no need to act on.
        Stream.merge(Stream.drop(Stream.tick(options?.every ?? "1 minute"), 1)),
        Stream.runForEach(() => gatherLater),
        Effect.forkScoped
      )
      // Runs first of the session's finalizers, while the connection is still up.
      yield* Effect.addFinalizer(() => gatherLater)
      return session
    })

    const sessions = yield* RcMap.make({
      lookup: open,
      idleTimeToLive: options?.release ?? "1 minute"
    })

    const engine = Documents.makeWith({
      storage,
      run: (id, command) =>
        Effect.gen(function*() {
          const session = yield* RcMap.get(sessions, id)
          return yield* session.lock.withPermit(Effect.andThen(session.gather, command(session.workspace)))
        }).pipe(Effect.scoped)
    })

    const checkpoint = (id: Document.Id) =>
      Effect.gen(function*() {
        const session = yield* RcMap.get(sessions, id)
        return yield* session.lock.withPermit(session.gather)
      }).pipe(Effect.scoped)

    const documents = Documents.Documents.of({
      ...engine,
      // What the latest revision says plus anything saved since, for a reader who
      // isn't connected and would otherwise see text from before the last pause.
      read: (id, readOptions) =>
        Effect.gen(function*() {
          if (readOptions?.version === undefined && (yield* storage.staged(id)).length > 0) yield* checkpoint(id)
          return yield* engine.read(id, readOptions)
        }),
      remove: (id) => Effect.andThen(RcMap.invalidate(sessions, id), engine.remove(id))
    })

    const enter = (room: Replica.RoomId) =>
      RcMap.get(sessions, Document.Id.make(room)).pipe(Effect.mapError(fromStorage))

    const authority = Authority.Authority.of({
      subscribe: (request) => Stream.unwrap(Effect.as(enter(request.room), server.subscribe(request))),
      push: (request) => Effect.andThen(enter(request.room), server.push(request)).pipe(Effect.scoped)
    })

    return Context.make(Documents.Documents, documents).pipe(
      Context.add(Authority.Authority, authority),
      Context.add(Collaboration, Collaboration.of({ checkpoint }))
    )
  }))
