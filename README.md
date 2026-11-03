# effect-documents

Versioned Markdown documents with attributed history, anchored review and live editing, built on
[Effect](https://effect.website) and [effect-delta](https://github.com/jpowersdev/effect-delta). Unstable: the API may
change in any minor release.

```sh
pnpm add @jpowersdev/effect-documents @jpowersdev/effect-delta effect
```

`effect` is a peer dependency, `^4.1.1`, and `@jpowersdev/effect-delta` one at `^0.1.0`.

## Use

```ts
import { Actor, Document, Documents, DocumentStorage } from "@jpowersdev/effect-documents"
import { Effect, Layer, Option } from "effect"

const program = Effect.gen(function*() {
  const documents = yield* Documents.Documents
  const actor: Actor.Actor = { by: Actor.Id.make("@owner"), via: Option.none() }
  const id = Document.Id.make("performance-map")
  const first = yield* documents.create({ id, actor, title: "Performance map", body: "Clicks take 40 ms." })
  const second = yield* documents.apply({
    id,
    actor,
    note: "Updated after a paired run.",
    command: { _tag: "Edit", oldString: "40 ms", newString: "32 ms" }
  })
  const original = yield* documents.read(id, { version: first.version })
  return { second, original }
})

const DocumentsLive = Documents.layer.pipe(Layer.provide(DocumentStorage.layerMemory))
await Effect.runPromise(program.pipe(Effect.provide(DocumentsLive)))
```

[`examples/review.ts`](examples/review.ts) also opens an anchored discussion, and
[`examples/live.ts`](examples/live.ts) has two people typing while an agent edits.

## Modules

| Module               | What it is                                                 |
| -------------------- | ---------------------------------------------------------- |
| `Documents`          | The engine: `create`, `read`, `apply`, `history`, `remove` |
| `Collaboration`      | Live editing alongside commands                            |
| `DocumentStorage`    | The storage service and its contract; `layerMemory`        |
| `SqlDocumentStorage` | Durable storage on SQLite, D1 and PostgreSQL               |
| `Document`           | What a reader sees at one version                          |
| `Revision`           | An immutable history record                                |
| `Thread`             | An anchored discussion                                     |
| `Actor`              | Who a change is attributed to                              |

Import from the root (`import { Documents } from "@jpowersdev/effect-documents"`) or by module
(`import * as Documents from "@jpowersdev/effect-documents/Documents"`).

## Commands

Every successful command appends one attributed revision. A rejected, failed or interrupted one leaves content and
history unchanged, and invalid input fails with a `SchemaError`.

| Command   | What it does                                               | Names a version | Fails with                                                  |
| --------- | ---------------------------------------------------------- | --------------- | ----------------------------------------------------------- |
| `Edit`    | Replaces exact, literal text; `replaceAll` for every match | No              | `OldStringNotFound`, `AmbiguousOldString`, `Unchanged`      |
| `Update`  | Replaces the title, the body or both                       | Yes             | `Conflict`, `Unchanged`                                     |
| `Restore` | Copies an earlier title and body into a new revision       | Yes             | `Conflict`                                                  |
| `Open`    | Starts a discussion on an exact quote at a UTF-16 offset   | No              | `QuoteChanged`, `ThreadAlreadyExists`                       |
| `Reply`   | Adds to a discussion, and reopens it if it was resolved    | No              | `ThreadNotFound`                                            |
| `Resolve` | Closes a discussion                                        | Yes             | `Conflict` if the discussion has moved on, `ThreadNotFound` |
| `Reopen`  | Opens a resolved discussion again                          | No              | `ThreadNotFound`                                            |

- **Versions.** `Update` and `Restore` fail on a stale version. `Resolve` fails only over a reply its caller hasn't seen.
  Other commands apply to the current text.
- **Anchors** follow their original characters. `Edit` keeps the characters between matches, and `Update` diffs by line
  and keeps the common start and end of each changed region, so anchors on unchanged text survive. A very large change
  becomes one replacement, losing the anchors inside it. When every anchored character is deleted, the range becomes
  `None`, and the quote and discussion remain. `Restore` doesn't bring back deleted anchors.
- **Attribution.** `actors` starts with the person, and optionally the agent harness, model and session, that ran the
  command. `note` defaults to `""`, and timestamps come from Effect's clock.
- **Characters.** An edit that would split a surrogate pair fails with `SplitsSurrogatePair`.

`read(id)` returns the current version, and `read(id, { version })` a historical one. `history(id)` returns every entry,
oldest first, without content. `remove(id)` deletes a document and its whole history, leaving no trace.

## What a host owns

- **Identity.** It allocates document and thread ids, and supplies the `actor`. `Command` has no actor or document id,
  so it can be an HTTP or RPC payload as is, and a client can't claim to be someone else.

  ```ts
  const payload = Schema.Struct({
    note: Schema.optionalKey(Schema.String),
    command: Documents.Command
  })
  ```

- **Authorization**, before calling the service.
- **Organization, listing and search**, in its own tables, as a projection of each revision (see below).
- **Last-write-wins, if it wants that**, by reading the current version and passing it to `Update`.
- **Transport and UI**, including the editor. A binding loads a client's text and applies each `Remote` and `Rejected`
  patch from `ReplicatedText.subscribe`.
- **A record of removals**, if it needs one.

## Live editing

`Collaboration.layer` replaces `Documents.layer` where people edit at the same time. It also provides `Documents`, so
commands keep working, and an effect-delta `Authority` for clients to sync through. It needs `SecureRandom` from `effect/crypto`; plain
`Documents` doesn't.
[`examples/live.ts`](examples/live.ts) is a complete run.

```ts
import { Authority, Sync } from "@jpowersdev/effect-delta"
import { SecureRandom } from "effect/crypto"
import { RpcServer } from "effect/rpc"

// One instance for all of a document's writers.
const CollaborationLive = Collaboration.layer({
  // Optional: decide whether a live change is accepted.
  check: ({ user }) =>
    canEdit(user) ? Effect.void : Effect.fail(new Authority.Rejected({ message: "Read only" }))
}).pipe(Layer.provide(SqlDocumentStorage.layerStorage({})), Layer.provide(SecureRandom.layerWebCrypto))

// Serve it over any RPC protocol, saying who's connecting and what they may do.
const ServerLive = RpcServer.layer(Sync.Rpcs).pipe(
  Layer.provide(Authority.layerHandlers),
  Layer.provide([CollaborationLive, YourAuthorization]),
  Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/sync" }))
)

// In the client, the text follows everyone else's and sends its own.
const text = yield* ReplicatedText.makeConfirmed({ document: Replica.DocumentId.make(id) })
yield* ReplicatedText.insert(text, 0, "Draft: ")
```

- **Saving.** A change is saved as a staged change before it's acknowledged or sent to anyone else. A process that dies
  loses nothing acknowledged: the next session, or the next command, picks it up.
- **History.** Staged changes become one `Merge` revision crediting everyone in them. That happens after a pause (`idle`,
  five seconds), at least every minute (`every`), before any command, when a document is released, and when a `read`
  finds some. `Collaboration.checkpoint` does it on demand.
- **Conflicting edits** merge but can read badly: "24 hours" changed to "8 hours" and to "12 hours" at once gives
  "812 hours". `ReplicatedText.subscribe` reports each such overlap, so an editor can point it out.
- **Presence**, meaning who's here and their selections, is effect-delta's `Presence` module. Merge `Presence.Rpcs` with
  `Sync.Rpcs` to serve both from one server; a client opens a connection for each.

### On Cloudflare Workers

Run one Durable Object per document. Each upgrade request hands its socket to the RPC server, which you run with the
`protocol` from `RpcServer.makeProtocolWithHttpEffectWebsocket`:

```ts
const { 0: client, 1: server } = new WebSocketPair()
server.accept()
const base = HttpServerRequest.fromWeb(request)
const upgraded = Object.create(base, {
  upgrade: { value: Socket.fromWebSocket(Effect.succeed(server)) },
  headers: { value: base.headers }
})
runtime.runFork(httpEffect.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, upgraded)))
return new Response(null, { status: 101, webSocket: client })
```

Provide `SecureRandom.layerWebCrypto`. These sockets don't hibernate, so an object stays in
memory while anyone is connected. Timers don't survive eviction, but nothing is lost: staged changes wait for the next
visitor, or call `checkpoint` from an alarm.

This has run under workerd on D1, but not on Cloudflare itself.

## Storage

### `SqlDocumentStorage`

Works on SQLite (including D1) and PostgreSQL.

```ts
// Create the tables on startup...
const DocumentsLive = Documents.layer.pipe(Layer.provide(SqlDocumentStorage.layer))
// ...or separately, in a deploy step or a migration file, and use it without DDL.
const DocumentsWithoutDdl = Documents.layer.pipe(Layer.provide(SqlDocumentStorage.layerStorage({})))
```

The tables, for a host's migration files (with the default prefix):

```sql
CREATE TABLE IF NOT EXISTS documents_revisions (
  document_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  info TEXT NOT NULL,
  document TEXT NOT NULL,
  changes TEXT NOT NULL,
  PRIMARY KEY (document_id, version)
);
CREATE TABLE IF NOT EXISTS documents_staged (
  document_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  changes TEXT NOT NULL,
  PRIMARY KEY (document_id, position)
);
CREATE TABLE IF NOT EXISTS documents_writers (
  document_id TEXT NOT NULL,
  replica TEXT NOT NULL,
  owner TEXT NOT NULL,
  PRIMARY KEY (document_id, replica)
);
```

### Projecting into a host's tables

`commit` commits a revision and a host's own write atomically, so a list or search table can't disagree with the
document:

```ts
SqlDocumentStorage.layerStorage({
  commit: (statement, revision) =>
    sql.batch([
      statement,
      sql`UPDATE my_documents SET title = ${revision.document.title}, body = ${revision.document.body}
        WHERE id = ${revision.document.id}`
    ])
})
```

A conflict rolls back the host's write. A host write that fails rolls back the revision, and surfaces as a
`StorageFailure`.

To bring existing documents in, `create` each one, up front or the first time it's used.

### Other stores

Implement `DocumentStorage`. `append` must compare the current version with `revision.version - 1` (zero means the
document doesn't exist) and commit the whole record atomically, or fail with `Conflict`, reporting both versions and
leaving storage unchanged. `stage` must be durable by the time it returns. Readers must receive isolated values.
[`test/utils/storageContract.ts`](test/utils/storageContract.ts) is the contract as tests, which memory, SQLite,
PostgreSQL and D1 all run.

An interrupted commit may still have landed, as with any database write, so read again before deciding to retry.

## Limits

- **One writer process per document**, such as one Durable Object per document. Compare-and-append protects revisions
  from a second process, but not clients from each other.
- **Plain text.** The body is one string. Formatting and undo aren't built.
- **Memory.** An open document holds its text's tree twice on the server, and character history is never pruned.
- **A write per push.** Each acknowledged push writes a staged row. Clients send what gathered while the last push was
  out, so a slow store gets fewer, larger writes.
- **A removed document's id** can't be reused until a minute after its last client has gone.
- **Live editing on PostgreSQL** is untested, and racing writers there are tested only on PGlite, which has one
  connection.

## Development

See [`docs/development.md`](docs/development.md).

## License

MIT
