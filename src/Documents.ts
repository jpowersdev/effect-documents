/**
 * The `Documents` module is the document engine: versioned text with attributed
 * history and anchored review, independent of databases, transport, permissions
 * and how a host organizes its documents.
 *
 * Every accepted command appends exactly one immutable revision. A command that
 * could overwrite work its caller never saw names the version it read, and fails if
 * that's stale; the rest apply to the current text. Reading any version decodes one
 * record. Only commands that change the text or place an anchor rebuild the document's
 * text history, in a private replica that a failed commit can't leak into later reads.
 *
 * The host authenticates actors, authorizes commands and allocates document and
 * thread ids. `Command` deliberately carries no actor or document id, so a host
 * can accept it directly from a client and supply those itself.
 *
 * **Example** (Editing and reading an earlier version)
 *
 * ```ts
 * import { Effect, Layer, Option } from "effect"
 * import { Actor, Document, Documents, DocumentStorage } from "effect-documents"
 *
 * const program = Effect.gen(function*() {
 *   const documents = yield* Documents.Documents
 *   const actor: Actor.Actor = { by: Actor.Id.make("@owner"), via: Option.none() }
 *   const id = Document.Id.make("performance-map")
 *   const first = yield* documents.create({ id, actor, title: "Performance map", body: "Clicks take 40 ms." })
 *   yield* documents.apply({
 *     id,
 *     actor,
 *     note: "Updated after a paired run.",
 *     command: { _tag: "Edit", oldString: "40 ms", newString: "32 ms" }
 *   })
 *   return yield* documents.read(id, { version: first.version })
 * })
 *
 * const Live = Documents.layer.pipe(Layer.provide(DocumentStorage.layerMemory))
 * ```
 *
 * @stability unstable
 * @since 0.1.0
 */
import * as Delta from "effect-delta/Delta"
import * as Replica from "effect-delta/Replica"
import * as ReplicatedText from "effect-delta/ReplicatedText"
import * as TextPatch from "effect-delta/TextPatch"
import * as VersionVector from "effect-delta/VersionVector"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Order from "effect/Order"
import * as Schema from "effect/Schema"
import * as Actor from "./Actor.ts"
import * as Document from "./Document.ts"
import * as DocumentStorage from "./DocumentStorage.ts"
import * as InternalPatch from "./internal/patch.ts"
import * as Revision from "./Revision.ts"
import * as Thread from "./Thread.ts"

/**
 * The command would change nothing, so no revision was made.
 *
 * @stability unstable
 * @category errors
 * @since 0.1.0
 */
export class Unchanged extends Schema.TaggedError<Unchanged>("effect-documents/Documents/Unchanged")("Unchanged", {}) {
  /**
   * Explains why the command was rejected.
   *
   * @stability unstable
   * @since 0.1.0
   */
  override get message(): string {
    return "The command changes nothing"
  }
}

/**
 * The text to replace is not in the document.
 *
 * @stability unstable
 * @category errors
 * @since 0.1.0
 */
export class OldStringNotFound extends Schema.TaggedError<OldStringNotFound>(
  "effect-documents/Documents/OldStringNotFound"
)("OldStringNotFound", {
  oldString: Schema.String
}) {
  /**
   * Says what to do next, because an agent reads it.
   *
   * @stability unstable
   * @since 0.1.0
   */
  override get message(): string {
    return `${JSON.stringify(this.oldString)} was not found; read the document again and use its current text`
  }
}

/**
 * The text to replace appears more than once and `replaceAll` was not set.
 *
 * @stability unstable
 * @category errors
 * @since 0.1.0
 */
export class AmbiguousOldString extends Schema.TaggedError<AmbiguousOldString>(
  "effect-documents/Documents/AmbiguousOldString"
)("AmbiguousOldString", {
  oldString: Schema.String,
  occurrences: Schema.Int
}) {
  /**
   * Says what to do next, because an agent reads it.
   *
   * @stability unstable
   * @since 0.1.0
   */
  override get message(): string {
    return `${
      JSON.stringify(this.oldString)
    } appears ${this.occurrences} times; include more surrounding text or set replaceAll`
  }
}

/**
 * An edit or anchor would fall between the two halves of a surrogate pair.
 *
 * @stability unstable
 * @category errors
 * @since 0.1.0
 */
export class SplitsSurrogatePair extends Schema.TaggedError<SplitsSurrogatePair>(
  "effect-documents/Documents/SplitsSurrogatePair"
)("SplitsSurrogatePair", {
  index: Schema.Int
}) {
  /**
   * Names the offset that would split a character.
   *
   * @stability unstable
   * @since 0.1.0
   */
  override get message(): string {
    return `Offset ${this.index} falls inside a character`
  }
}

/**
 * The document has no discussion with this id.
 *
 * @stability unstable
 * @category errors
 * @since 0.1.0
 */
export class ThreadNotFound extends Schema.TaggedError<ThreadNotFound>("effect-documents/Documents/ThreadNotFound")(
  "ThreadNotFound",
  { thread: Thread.Id }
) {
  /**
   * Names the missing discussion.
   *
   * @stability unstable
   * @since 0.1.0
   */
  override get message(): string {
    return `The document has no discussion ${JSON.stringify(this.thread)}`
  }
}

/**
 * The document already has a discussion with this id.
 *
 * @stability unstable
 * @category errors
 * @since 0.1.0
 */
export class ThreadAlreadyExists extends Schema.TaggedError<ThreadAlreadyExists>(
  "effect-documents/Documents/ThreadAlreadyExists"
)("ThreadAlreadyExists", {
  thread: Thread.Id
}) {
  /**
   * Names the existing discussion.
   *
   * @stability unstable
   * @since 0.1.0
   */
  override get message(): string {
    return `The document already has a discussion ${JSON.stringify(this.thread)}`
  }
}

/**
 * The text at the given offset is not the quote the caller meant to discuss.
 *
 * @stability unstable
 * @category errors
 * @since 0.1.0
 */
export class QuoteChanged extends Schema.TaggedError<QuoteChanged>("effect-documents/Documents/QuoteChanged")(
  "QuoteChanged",
  { quote: Schema.String, start: Schema.Natural }
) {
  /**
   * Says what to do next, because an agent reads it.
   *
   * @stability unstable
   * @since 0.1.0
   */
  override get message(): string {
    return `${JSON.stringify(this.quote)} is not at offset ${this.start}; read the document again`
  }
}

/**
 * A command was rejected, so no revision was made. The `reason` says why.
 *
 * @stability unstable
 * @category errors
 * @since 0.1.0
 */
export class DocumentsError extends Schema.TaggedError<DocumentsError>("effect-documents/Documents/DocumentsError")(
  "DocumentsError",
  {
    reason: Schema.Union([
      Unchanged,
      OldStringNotFound,
      AmbiguousOldString,
      SplitsSurrogatePair,
      ThreadNotFound,
      ThreadAlreadyExists,
      QuoteChanged
    ])
  }
) {
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
 * What a caller can do to a document, with no actor or document id, which
 * accompany it in `apply`.
 *
 * **Details**
 *
 * - `Edit` replaces exact, literal text in the current document. `oldString` must
 *   match once unless `replaceAll` is set, so it fails only if its target has gone
 *   or has become ambiguous.
 * - `Update` replaces the title, the body or both, in one revision. Anchors on
 *   unchanged text survive. `version` is the version its caller read; a stale one
 *   fails with `Conflict`, because the update would undo what it never saw.
 * - `Open` starts a discussion on the exact `quote` at UTF-16 offset `start`, and
 *   fails with `QuoteChanged` if that isn't what's there now.
 * - `Reply` and `Reopen` continue a discussion. A reply reopens it.
 * - `Resolve` closes a discussion. `version` is the version its caller read; it
 *   fails with `Conflict` only if the discussion has moved on since, not if the
 *   text has.
 * - `Restore` copies an earlier title and body into a new revision, and its
 *   `version` works as `Update`'s does. It keeps current discussions and all
 *   history, and can't bring back deleted anchors.
 *
 * @stability unstable
 * @category schemas
 * @since 0.1.0
 */
export const Command = Schema.Union([
  Schema.TaggedStruct("Edit", {
    oldString: Schema.NonEmptyString,
    newString: Schema.String,
    replaceAll: Schema.optionalKey(Schema.Boolean)
  }),
  Schema.TaggedStruct("Update", {
    version: Document.Version,
    title: Schema.optionalKey(Schema.String),
    body: Schema.optionalKey(Schema.String)
  }),
  Schema.TaggedStruct("Open", {
    thread: Thread.Id,
    start: Schema.Natural,
    quote: Schema.NonEmptyString,
    body: Schema.NonEmptyString
  }),
  Schema.TaggedStruct("Reply", { thread: Thread.Id, body: Schema.NonEmptyString }),
  Schema.TaggedStruct("Resolve", { version: Document.Version, thread: Thread.Id }),
  Schema.TaggedStruct("Reopen", { thread: Thread.Id }),
  Schema.TaggedStruct("Restore", { version: Document.Version, from: Document.Version })
])

/**
 * A document or review command.
 *
 * @stability unstable
 * @category models
 * @since 0.1.0
 */
export type Command = typeof Command.Type

const attribution = { actor: Actor.Actor, note: Schema.optionalKey(Schema.String) }

/**
 * A new document. `note` defaults to `""`.
 *
 * @stability unstable
 * @category schemas
 * @since 0.1.0
 */
export const Create = Schema.Struct({
  ...attribution,
  id: Document.Id,
  title: Schema.String,
  body: Schema.String
})

/**
 * A new document.
 *
 * @stability unstable
 * @category models
 * @since 0.1.0
 */
export type Create = typeof Create.Type

/**
 * A command against a document. `note` defaults to `""`.
 *
 * @stability unstable
 * @category schemas
 * @since 0.1.0
 */
export const Apply = Schema.Struct({
  ...attribution,
  id: Document.Id,
  command: Command
})

/**
 * A command against a document.
 *
 * @stability unstable
 * @category models
 * @since 0.1.0
 */
export type Apply = typeof Apply.Type

/**
 * Documents and their history.
 *
 * **Details**
 *
 * - `create` starts a document at version one. An existing id fails with
 *   `Conflict`.
 * - `read` returns the current document, or the one at `version`.
 * - `apply` runs a command. `Update` and `Restore` fail with `Conflict` on a stale
 *   version. Other commands apply to the current text, and are worked out again from
 *   it if another writer gets in first.
 * - `history` returns who did what and when, oldest first, without content.
 * - `remove` deletes a document and its whole history, leaving no trace; recording
 *   that it happened belongs to the host.
 *
 * Changes staged by a collaboration session are gathered into a `Merge` revision
 * before the next command, so a command is never based on less than they hold.
 *
 * Input that doesn't match its schema fails with a `SchemaError`.
 *
 * **Gotchas**
 *
 * If storage commits but the connection fails before it answers, the caller sees
 * a failure for a command that took effect. Read again before deciding to retry.
 *
 * @stability unstable
 * @category services
 * @since 0.1.0
 */
export class Documents extends Context.Service<Documents, {
  readonly create: (
    input: Create
  ) => Effect.Effect<Document.Document, DocumentStorage.DocumentStorageError | Schema.SchemaError>
  readonly read: (
    id: Document.Id,
    options?: { readonly version?: number | undefined }
  ) => Effect.Effect<Document.Document, DocumentStorage.DocumentStorageError | Schema.SchemaError>
  readonly apply: (
    input: Apply
  ) => Effect.Effect<Document.Document, DocumentsError | DocumentStorage.DocumentStorageError | Schema.SchemaError>
  readonly history: (
    id: Document.Id
  ) => Effect.Effect<ReadonlyArray<Revision.Info>, DocumentStorage.DocumentStorageError>
  readonly remove: (id: Document.Id) => Effect.Effect<void, DocumentStorage.DocumentStorageError>
}>()("effect-documents/Documents") {}

const strict = { onExcessProperty: "error" } as const
const decodeCreate = Schema.decodeUnknownEffect(Schema.toType(Create), strict)
const decodeApply = Schema.decodeUnknownEffect(Schema.toType(Apply), strict)
const decodeVersion = Schema.decodeUnknownEffect(Document.Version)

const reject = (reason: typeof DocumentsError.fields.reason.Type) => new DocumentsError({ reason })

const byThreadId = Order.mapInput(Order.String, (located: Thread.Located) => located.thread.id)

const conflict = (id: Document.Id, expected: number, actual: number) =>
  new DocumentStorage.DocumentStorageError({
    reason: new DocumentStorage.Conflict({ id, expected, actual })
  })

// Patches come from the current text, so their offsets are always in bounds.
const fromTextError = (error: ReplicatedText.ReplicatedTextError) =>
  error.reason._tag === "SplitsSurrogatePair"
    ? Effect.fail(reject(new SplitsSurrogatePair({ index: error.reason.index })))
    : Effect.die(error)

const storageFailure = (cause: unknown) =>
  new DocumentStorage.DocumentStorageError({ reason: new DocumentStorage.StorageFailure({ cause }) })

// A replica's id only has to be unique among the writers of one document's text.
// Compare-and-append lets one revision per version commit and discards the
// changes of the rest, so the version is unique, and needs no randomness.
const makeText = (version: number) => ReplicatedText.make({ replica: Replica.ReplicaId.make(String(version)) })

const locate = (
  threads: ReadonlyArray<Thread.Located>,
  text: ReplicatedText.ReplicatedText
): Effect.Effect<ReadonlyArray<Thread.Located>> =>
  Effect.forEach(
    threads,
    ({ thread }) => Effect.map(ReplicatedText.locateRange(text, thread.anchor), (range) => ({ thread, range }))
  )

/**
 * A document's text to edit, and what its last revision covers.
 *
 * @internal
 */
export interface Loaded {
  readonly text: ReplicatedText.ReplicatedText
  readonly base: VersionVector.VersionVector
}

/**
 * How the engine reaches a document's text while it runs one command. By default
 * that's a private replica, loaded only if needed. A collaboration session gives
 * it the session's shared one instead.
 *
 * @internal
 */
export interface Workspace {
  /** The text, loaded at most once. */
  readonly load: Effect.Effect<Loaded, DocumentStorage.DocumentStorageError>
  /** Whether revisions must hold what's in the text, because others are changing it. */
  readonly shared: boolean
  /** Waits until edits made to the text are durable. */
  readonly settle: (text: ReplicatedText.ReplicatedText) => Effect.Effect<void, DocumentStorage.DocumentStorageError>
  /** Called with what a committed revision covers. */
  readonly committed: (version: VersionVector.VersionVector) => Effect.Effect<void>
}

// Reads a text with what it covers. Another replica's changes can arrive between
// any two reads, so this reads until nothing did.
const consistent = <A, E>(text: ReplicatedText.ReplicatedText, read: Effect.Effect<A, E>) =>
  Effect.gen(function*() {
    while (true) {
      const version = yield* Replica.version(text)
      const value = yield* read
      if (VersionVector.compare(version, yield* Replica.version(text)) === "equal") return { value, version }
    }
  })

// A revision holds what's in the text now, whoever it came from, so everyone with
// live changes in it is one of its actors.
const contributors = Effect.fnUntraced(function*(
  storage: DocumentStorage.DocumentStorage["Service"],
  id: Document.Id,
  version: VersionVector.VersionVector,
  base: VersionVector.VersionVector
) {
  const writers = yield* storage.writers(id)
  const owners = new Set<string>()
  for (const replica of Object.keys(version)) {
    if (version[replica]! > (base[replica] ?? 0) && Object.hasOwn(writers, replica)) owners.add(writers[replica]!)
  }
  return [...owners].sort()
})

// Staged changes are saved in the order they came in, and a replica takes them in
// that order, so the ones a revision holds come first.
const unstage = Effect.fnUntraced(function*(
  storage: DocumentStorage.DocumentStorage["Service"],
  id: Document.Id,
  version: VersionVector.VersionVector
) {
  let through = 0
  for (const { changes, position } of yield* storage.staged(id)) {
    const held = VersionVector.compare(Delta.version(changes), version)
    if (held !== "before" && held !== "equal") break
    through = position
  }
  if (through > 0) yield* storage.unstage(id, { through })
})

const commit = Effect.fnUntraced(function*(
  storage: DocumentStorage.DocumentStorage["Service"],
  workspace: Workspace,
  { text, base }: Loaded,
  previous: Revision.Revision,
  entry: Omit<Revision.Info, "version" | "at" | "actors"> & {
    readonly actor: Actor.Actor | undefined
    readonly title: string
    readonly threads: ReadonlyArray<Thread.Located>
  }
) {
  const { id } = previous.document
  yield* workspace.settle(text)
  const { value, version } = yield* consistent(
    text,
    Effect.all({
      body: ReplicatedText.get(text),
      threads: locate(entry.threads, text),
      changes: Replica.delta(text, base)
    })
  )
  const others = yield* contributors(storage, id, version, base)
  const actors: ReadonlyArray<Actor.Actor> = [
    ...(entry.actor === undefined ? [] : [entry.actor]),
    ...others.filter((by) => by !== entry.actor?.by).map((by) => ({ by: Actor.Id.make(by), via: Option.none() }))
  ]
  const document: Document.Document = {
    id,
    title: entry.title,
    body: value.body,
    version: previous.version + 1,
    threads: value.threads
  }
  yield* storage.append({
    version: document.version,
    action: entry.action,
    actors,
    at: yield* Clock.currentTimeMillis,
    note: entry.note,
    restoredFrom: entry.restoredFrom,
    document,
    changes: value.changes
  })
  yield* workspace.committed(version)
  yield* unstage(storage, id, version)
  return document
})

/**
 * Gathers changes that aren't in a revision yet into a `Merge` revision. Does
 * nothing if there are none.
 *
 * @internal
 */
export const merge = Effect.fnUntraced(function*({ id, storage, workspace }: {
  readonly storage: DocumentStorage.DocumentStorage["Service"]
  readonly workspace: Workspace
  readonly id: Document.Id
}) {
  const loaded = yield* workspace.load
  const pending = yield* Replica.delta(loaded.text, loaded.base)
  if (Delta.isEmpty(pending)) return Option.none<Document.Document>()
  const previous = yield* storage.read(id)
  return Option.some(
    yield* commit(storage, workspace, loaded, previous, {
      action: "Merge",
      actor: undefined,
      note: "",
      restoredFrom: Option.none(),
      title: previous.document.title,
      threads: previous.document.threads
    })
  )
})

/**
 * The engine, reaching each document's text through `run`, which hands a command
 * its workspace and decides what else must happen around it.
 *
 * @internal
 */
export const makeWith = ({ run, storage }: {
  readonly storage: DocumentStorage.DocumentStorage["Service"]
  readonly run: <A, E>(
    id: Document.Id,
    command: (workspace: Workspace) => Effect.Effect<A, E>
  ) => Effect.Effect<A, E | DocumentStorage.DocumentStorageError>
}): Documents["Service"] => {
  const create = Effect.fnUntraced(function*(request: Create) {
    const input = yield* decodeCreate(request)
    const text = yield* makeText(1)
    yield* ReplicatedText.set(text, input.body)
    const document: Document.Document = {
      id: input.id,
      title: input.title,
      body: input.body,
      version: 1,
      threads: []
    }
    yield* storage.append({
      version: 1,
      action: "Create",
      actors: [input.actor],
      at: yield* Clock.currentTimeMillis,
      note: input.note ?? "",
      restoredFrom: Option.none(),
      document,
      changes: yield* Replica.delta(text, VersionVector.empty)
    })
    return document
  })

  const read = Effect.fnUntraced(function*(id: Document.Id, options?: { readonly version?: number | undefined }) {
    if (options?.version !== undefined) yield* decodeVersion(options.version)
    const revision = yield* storage.read(id, options)
    return revision.document
  })

  const applyOnce = (input: Apply) =>
    run(input.id, (workspace) =>
      Effect.gen(function*() {
        const { actor, command, id } = input
        const previous = yield* storage.read(id)
        const current = previous.document
        const version = current.version + 1
        const at = yield* Clock.currentTimeMillis

        const findThread = (thread: Thread.Id) =>
          Effect.fromNullishOr(current.threads.find((located) => located.thread.id === thread)).pipe(
            Effect.mapError(() => reject(new ThreadNotFound({ thread })))
          )

        const addEvent = (
          thread: Thread.Id,
          action: "Reply" | "Resolve" | "Reopen",
          body: Option.Option<string>
        ) =>
          Effect.map(
            findThread(thread),
            () =>
              current.threads.map((located): Thread.Located =>
                located.thread.id === thread
                  ? {
                    ...located,
                    thread: {
                      ...located.thread,
                      events: [...located.thread.events, { revision: version, actor, at, action, body }]
                    }
                  }
                  : located
              )
          )

        // Replaces the whole text with `body`, as a diff so anchors on what's
        // unchanged survive.
        const replaceBody = Effect.fnUntraced(function*(body: string) {
          const { text } = yield* workspace.load
          yield* ReplicatedText.modify(text, (before) => [undefined, InternalPatch.between(before, body)]).pipe(
            Effect.catch(fromTextError)
          )
        })

        // Only commands that change the text or place an anchor need its history.
        let edited = false
        let title = current.title
        let threads = current.threads
        let restoredFrom = Option.none<number>()

        switch (command._tag) {
          case "Edit": {
            if (command.oldString === command.newString) return yield* reject(new Unchanged())
            const { text } = yield* workspace.load
            const problem = yield* ReplicatedText.modify(
              text,
              (body): readonly [Option.Option<OldStringNotFound | AmbiguousOldString>, TextPatch.TextPatch] => {
                const found = InternalPatch.occurrences(body, command.oldString)
                if (found.length === 0) {
                  return [Option.some(new OldStringNotFound({ oldString: command.oldString })), TextPatch.empty]
                }
                if (found.length > 1 && command.replaceAll !== true) {
                  return [
                    Option.some(new AmbiguousOldString({ oldString: command.oldString, occurrences: found.length })),
                    TextPatch.empty
                  ]
                }
                return [Option.none(), InternalPatch.replaceAt(found, command.oldString.length, command.newString)]
              }
            ).pipe(Effect.catch(fromTextError))
            if (Option.isSome(problem)) return yield* reject(problem.value)
            edited = true
            break
          }
          case "Update": {
            if (command.version !== current.version) return yield* conflict(id, command.version, current.version)
            title = command.title ?? title
            const body = command.body ?? current.body
            if (title === current.title && body === current.body) return yield* reject(new Unchanged())
            if (body !== current.body) {
              yield* replaceBody(body)
              edited = true
            }
            break
          }
          case "Restore": {
            if (command.version !== current.version) return yield* conflict(id, command.version, current.version)
            const source = (yield* storage.read(id, { version: command.from })).document
            title = source.title
            restoredFrom = Option.some(command.from)
            if (source.body !== current.body) {
              yield* replaceBody(source.body)
              edited = true
            }
            break
          }
          case "Open": {
            if (current.threads.some((located) => located.thread.id === command.thread)) {
              return yield* reject(new ThreadAlreadyExists({ thread: command.thread }))
            }
            const { text } = yield* workspace.load
            const end = command.start + command.quote.length
            const { value: anchor } = yield* consistent(
              text,
              Effect.gen(function*() {
                const body = yield* ReplicatedText.get(text)
                if (body.slice(command.start, end) !== command.quote) {
                  return yield* reject(new QuoteChanged({ quote: command.quote, start: command.start }))
                }
                return yield* ReplicatedText.anchorRange(text, { start: command.start, end }).pipe(
                  Effect.catch(fromTextError)
                )
              })
            )
            const opened: Thread.Located = {
              thread: {
                id: command.thread,
                quote: command.quote,
                anchor,
                events: [{ revision: version, actor, at, action: "Open", body: Option.some(command.body) }]
              },
              range: Option.none()
            }
            threads = [...threads, opened].sort(byThreadId)
            edited = true
            break
          }
          case "Reply":
            threads = yield* addEvent(command.thread, "Reply", Option.some(command.body))
            break
          case "Resolve": {
            const { thread } = yield* findThread(command.thread)
            const latest = thread.events[thread.events.length - 1]!.revision
            if (latest > command.version) return yield* conflict(id, command.version, current.version)
            threads = yield* addEvent(command.thread, "Resolve", Option.none())
            break
          }
          case "Reopen":
            threads = yield* addEvent(command.thread, "Reopen", Option.none())
            break
        }

        if (edited || workspace.shared) {
          return yield* commit(storage, workspace, yield* workspace.load, previous, {
            action: command._tag,
            actor,
            note: input.note ?? "",
            restoredFrom,
            title,
            threads
          })
        }
        const document: Document.Document = { id, title, version, body: current.body, threads }
        yield* storage.append({
          version,
          action: command._tag,
          actors: [actor],
          at,
          note: input.note ?? "",
          restoredFrom,
          document,
          changes: Delta.empty
        })
        return document
      }))

  const apply = Effect.fnUntraced(function*(request: Apply) {
    const input = yield* decodeApply(request)
    // Losing a race to another writer means working the command out again from
    // what they wrote: a command that named a version will find it stale, and any
    // other is applied to the new text. Each loss means that writer got through.
    return yield* applyOnce(input).pipe(
      Effect.retry({
        while: (error) => error._tag === "DocumentStorageError" && error.reason._tag === "Conflict",
        times: 16
      })
    )
  })

  return Documents.of({ create, read, apply, history: storage.history, remove: storage.remove })
}

// The default workspace: a private replica rebuilt from storage, and only if a
// command needs it. Changes staged by an earlier session are already gathered
// into a revision by the time a command runs.
const makeWorkspace = (storage: DocumentStorage.DocumentStorage["Service"], id: Document.Id) =>
  Effect.gen(function*() {
    const load = yield* Effect.cached(Effect.gen(function*() {
      const { version } = yield* storage.read(id)
      const text = yield* makeText(version + 1)
      const receive = (changes: ReadonlyArray<Delta.Delta>) =>
        Replica.receive(text, Delta.ReducerUnion.combineAll(changes)).pipe(Effect.mapError(storageFailure))
      yield* receive(yield* storage.changes(id, { through: version }))
      const base = yield* Replica.version(text)
      yield* receive((yield* storage.staged(id)).map(({ changes }) => changes))
      return { text, base }
    }))
    return { load, shared: false, settle: () => Effect.void, committed: () => Effect.void } satisfies Workspace
  })

/**
 * Creates the document engine over the current `DocumentStorage`.
 *
 * @stability unstable
 * @category constructors
 * @since 0.1.0
 */
export const make: Effect.Effect<Documents["Service"], never, DocumentStorage.DocumentStorage> = Effect.gen(
  function*() {
    const storage = yield* DocumentStorage.DocumentStorage
    return makeWith({
      storage,
      run: (id, command) =>
        Effect.gen(function*() {
          if ((yield* storage.staged(id)).length > 0) {
            yield* merge({ storage, workspace: yield* makeWorkspace(storage, id), id })
          }
          return yield* command(yield* makeWorkspace(storage, id))
        })
    })
  }
)

/**
 * Provides the document engine over a host-supplied `DocumentStorage`.
 *
 * @stability unstable
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<Documents, never, DocumentStorage.DocumentStorage> = Layer.effect(Documents, make)
