/**
 * The `DocumentStorage` module defines where a document's immutable revisions
 * live. The engine depends only on this service, so a host can keep documents
 * in any store that offers an atomic conditional append.
 *
 * `layerMemory` is for tests and prototypes. For durable SQL storage, see
 * `SqlDocumentStorage`.
 *
 * @stability unstable
 * @since 0.1.0
 */
import * as Delta from "@jpowersdev/effect-delta/Delta"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Document from "./Document.ts"
import * as Revision from "./Revision.ts"

/**
 * The document, or the version asked for, does not exist.
 *
 * @stability unstable
 * @category errors
 * @since 0.1.0
 */
export class NotFound extends Schema.TaggedError<NotFound>("effect-documents/DocumentStorage/NotFound")("NotFound", {
  id: Document.Id,
  version: Schema.OptionFromNullOr(Document.Version)
}) {
  /**
   * Names the document, and the version when one was asked for.
   *
   * @stability unstable
   * @since 0.1.0
   */
  override get message(): string {
    const document = `Document ${JSON.stringify(this.id)}`
    return Option.match(this.version, {
      onNone: () => `${document} does not exist`,
      onSome: (version) => `${document} has no version ${version}`
    })
  }
}

/**
 * The caller's version is not the document's current version. Zero means the
 * document does not exist. The caller must read again and reconsider its change;
 * nothing ever retries a conflicting command automatically.
 *
 * @stability unstable
 * @category errors
 * @since 0.1.0
 */
export class Conflict extends Schema.TaggedError<Conflict>("effect-documents/DocumentStorage/Conflict")("Conflict", {
  id: Document.Id,
  expected: Schema.Natural,
  actual: Schema.Natural
}) {
  /**
   * Names both versions and what to do next.
   *
   * @stability unstable
   * @since 0.1.0
   */
  override get message(): string {
    return `Document ${
      JSON.stringify(this.id)
    } is at version ${this.actual}, not ${this.expected}; read it again and reconsider the change`
  }
}

/**
 * The store failed, or holds a record that can't be used.
 *
 * @stability unstable
 * @category errors
 * @since 0.1.0
 */
export class StorageFailure extends Schema.TaggedError<StorageFailure>(
  "effect-documents/DocumentStorage/StorageFailure"
)("StorageFailure", {
  cause: Schema.Defect()
}) {
  /**
   * Explains that the failure is in the store rather than the request.
   *
   * @stability unstable
   * @since 0.1.0
   */
  override get message(): string {
    return "The document store failed"
  }
}

/**
 * A revision could not be read or committed. The `reason` says why.
 *
 * @stability unstable
 * @category errors
 * @since 0.1.0
 */
export class DocumentStorageError extends Schema.TaggedError<DocumentStorageError>(
  "effect-documents/DocumentStorage/DocumentStorageError"
)("DocumentStorageError", {
  reason: Schema.Union([NotFound, Conflict, StorageFailure])
}) {
  /**
   * Exposes the structured reason as the JavaScript error cause.
   *
   * @stability unstable
   * @since 0.1.0
   */
  override readonly cause = this.reason

  /**
   * Uses the reason's message.
   *
   * @stability unstable
   * @since 0.1.0
   */
  override get message(): string {
    return this.reason.message
  }
}

/**
 * Live changes that were saved but aren't in a revision yet. `position` orders
 * them within a document.
 *
 * @stability unstable
 * @category models
 * @since 0.1.0
 */
export interface Staged {
  readonly position: number
  readonly changes: Delta.Delta
}

/**
 * Storage for a document's immutable revisions.
 *
 * **Details**
 *
 * - `read` returns the current revision, or the one at `version`.
 * - `history` returns every history entry, oldest first, without loading content.
 * - `changes` returns the text changes of every revision through `through`,
 *   oldest first.
 * - `append` commits a revision only if the current version is exactly
 *   `revision.version - 1`, where zero means the document does not exist. On any
 *   failure, storage is unchanged. A mismatch fails with `Conflict`.
 * - `remove` deletes a document, its whole history and everything staged for it.
 *   A later `append` of version one starts a new document under the same id.
 * - `stage` saves live changes durably. `staged` returns them, oldest first, and
 *   `unstage` deletes those up to and including a position. A revision and the
 *   staged changes it holds aren't committed together: staged changes are a set,
 *   so holding one in both places does no harm if `unstage` never runs.
 * - `addWriter` records which user a replica id belongs to, keeping the first
 *   owner if it's called twice, and `writers` returns them all.
 *
 * `read`, `history`, `changes` and `remove` fail with `NotFound` for an unknown
 * document; `staged` and `writers` return nothing for one. Results must be isolated
 * values, never references into a mutable cache.
 *
 * @stability unstable
 * @category services
 * @since 0.1.0
 */
export class DocumentStorage extends Context.Service<DocumentStorage, {
  readonly read: (
    id: Document.Id,
    options?: { readonly version?: number | undefined }
  ) => Effect.Effect<Revision.Revision, DocumentStorageError>
  readonly history: (id: Document.Id) => Effect.Effect<ReadonlyArray<Revision.Info>, DocumentStorageError>
  readonly changes: (
    id: Document.Id,
    options: { readonly through: number }
  ) => Effect.Effect<ReadonlyArray<Delta.Delta>, DocumentStorageError>
  readonly append: (revision: Revision.Revision) => Effect.Effect<void, DocumentStorageError>
  readonly remove: (id: Document.Id) => Effect.Effect<void, DocumentStorageError>
  readonly stage: (id: Document.Id, changes: Delta.Delta) => Effect.Effect<void, DocumentStorageError>
  readonly staged: (id: Document.Id) => Effect.Effect<ReadonlyArray<Staged>, DocumentStorageError>
  readonly unstage: (
    id: Document.Id,
    options: { readonly through: number }
  ) => Effect.Effect<void, DocumentStorageError>
  readonly addWriter: (id: Document.Id, replica: string, owner: string) => Effect.Effect<void, DocumentStorageError>
  readonly writers: (id: Document.Id) => Effect.Effect<Readonly<Record<string, string>>, DocumentStorageError>
}>()("effect-documents/DocumentStorage") {}

const json = Schema.fromJsonString(Revision.Revision)
const encode = Schema.encodeEffect(json)
const decode = Schema.decodeEffect(json)
const StagedJson = Schema.fromJsonString(Delta.Delta)
const encodeStaged = Schema.encodeEffect(StagedJson)
const decodeStaged = Schema.decodeEffect(StagedJson)

const fail = (reason: NotFound | Conflict | StorageFailure) => new DocumentStorageError({ reason })
const failure = (cause: unknown) => fail(new StorageFailure({ cause }))

/**
 * Provides storage that holds encoded revisions in memory and loses them when
 * its layer is released.
 *
 * **When to use**
 *
 * Use in tests and prototypes.
 *
 * @stability unstable
 * @category layers
 * @since 0.1.0
 */
export const layerMemory: Layer.Layer<DocumentStorage> = Layer.effect(
  DocumentStorage,
  Effect.gen(function*() {
    const documents = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<string>>>(new Map())
    const staged = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<{ position: number; changes: string }>>>(new Map())
    const writers = yield* Ref.make<ReadonlyMap<string, Readonly<Record<string, string>>>>(new Map())
    const without = <A>(all: ReadonlyMap<string, A>, id: string): ReadonlyMap<string, A> => {
      const next = new Map(all)
      next.delete(id)
      return next
    }
    const entries = Effect.fnUntraced(function*(id: Document.Id) {
      const found = (yield* Ref.get(documents)).get(id)
      if (found === undefined) return yield* fail(new NotFound({ id, version: Option.none() }))
      return found
    })
    const decodeAll = (encoded: ReadonlyArray<string>) =>
      Effect.forEach(encoded, (entry) => decode(entry).pipe(Effect.mapError(failure)))
    return DocumentStorage.of({
      read: Effect.fnUntraced(function*(id, options) {
        const all = yield* entries(id)
        const version = options?.version ?? all.length
        const entry = all[version - 1]
        if (entry === undefined) return yield* fail(new NotFound({ id, version: Option.some(version) }))
        return yield* decode(entry).pipe(Effect.mapError(failure))
      }),
      history: (id) => entries(id).pipe(Effect.flatMap(decodeAll), Effect.map((all) => all.map(Revision.info))),
      changes: (id, { through }) =>
        entries(id).pipe(
          Effect.flatMap((all) => decodeAll(all.slice(0, through))),
          Effect.map((all) => all.map((revision) => revision.changes))
        ),
      append: Effect.fnUntraced(function*(revision) {
        const encoded = yield* encode(revision).pipe(Effect.mapError(failure))
        const id = revision.document.id
        const expected = revision.version - 1
        const result = yield* Ref.modify(
          documents,
          (all): readonly [Result.Result<void, DocumentStorageError>, ReadonlyMap<string, ReadonlyArray<string>>] => {
            const previous = all.get(id) ?? []
            if (previous.length !== expected) {
              return [Result.fail(fail(new Conflict({ id, expected, actual: previous.length }))), all]
            }
            return [Result.void, new Map(all).set(id, [...previous, encoded])]
          }
        )
        yield* Effect.fromResult(result)
      }),
      remove: Effect.fnUntraced(function*(id) {
        yield* entries(id)
        yield* Ref.update(documents, (all) => without(all, id))
        yield* Ref.update(staged, (all) => without(all, id))
        yield* Ref.update(writers, (all) => without(all, id))
      }),
      stage: Effect.fnUntraced(function*(id, changes) {
        const encoded = yield* encodeStaged(changes).pipe(Effect.mapError(failure))
        yield* Ref.update(staged, (all) => {
          const rows = all.get(id) ?? []
          return new Map(all).set(id, [...rows, {
            position: (rows[rows.length - 1]?.position ?? 0) + 1,
            changes: encoded
          }])
        })
      }),
      staged: Effect.fnUntraced(function*(id) {
        const rows = (yield* Ref.get(staged)).get(id) ?? []
        return yield* Effect.forEach(rows, ({ changes, position }) =>
          decodeStaged(changes).pipe(
            Effect.map((changes) => ({ position, changes })),
            Effect.mapError(failure)
          ))
      }),
      unstage: (id, { through }) =>
        Ref.update(
          staged,
          (all) => new Map(all).set(id, (all.get(id) ?? []).filter(({ position }) => position > through))
        ),
      addWriter: (id, replica, owner) =>
        Ref.update(writers, (all) => {
          const known = all.get(id) ?? {}
          return Object.hasOwn(known, replica) ? all : new Map(all).set(id, { ...known, [replica]: owner })
        }),
      writers: (id) => Effect.map(Ref.get(writers), (all) => ({ ...all.get(id) }))
    })
  })
)
