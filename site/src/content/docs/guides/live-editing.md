---
title: "Live editing"
description: "People typing at the same time, alongside commands."
sidebar:
  order: 3
---

`Collaboration.layer` replaces `Documents.layer` where people edit at the same time. It also provides `Documents`, so
commands keep working, and an effect-delta `Authority` for clients to sync through. It needs `SecureRandom` from
`effect/crypto`; plain `Documents` doesn't.

## In one process

```ts import.meta.vitest
import { Replica, ReplicatedText, Sync } from "@jpowersdev/effect-delta"
import { Actor, Collaboration, Document, Documents, DocumentStorage } from "@jpowersdev/effect-documents"
import { Effect, Layer, Option, Stream } from "effect"
import { SecureRandom } from "effect/crypto"

const id = Document.Id.make("spec")
const agent: Actor.Actor = { by: Actor.Id.make("@agent"), via: Option.none() }

const join = (user: string) =>
  Effect.gen(function*() {
    const text = yield* ReplicatedText.makeConfirmed({ document: Replica.DocumentId.make(id) }).pipe(
      Effect.provideService(Sync.CurrentUser, user)
    )
    yield* text.connection.status.pipe(Stream.filter((status) => status._tag === "Synced"), Stream.runHead)
    return text
  })

const saved = (text: ReplicatedText.Confirmed) =>
  text.connection.unconfirmed.pipe(Stream.filter((count) => count === 0), Stream.runHead)

const program = Effect.gen(function*() {
  const documents = yield* Documents.Documents
  yield* documents.create({ id, actor: agent, title: "Spec", body: "Sessions last 24 hours." })

  const ada = yield* join("@ada")
  const ben = yield* join("@ben")
  yield* ReplicatedText.insert(ada, 0, "Draft: ")
  yield* ReplicatedText.insert(ben, 0, "Ben here. ")
  yield* Effect.all([saved(ada), saved(ben)])

  // No version: the agent's edit applies to whatever the text is now
  yield* documents.apply({ id, actor: agent, command: { _tag: "Edit", oldString: "24", newString: "8" } })

  const history = yield* documents.history(id)
  return history.map(({ action, actors }) => `${action} by ${actors.map(({ by }) => by).join(", ")}`)
})

const CollaborationLive = Collaboration.layer().pipe(
  Layer.provideMerge(DocumentStorage.layerMemory),
  Layer.provideMerge(SecureRandom.layerWebCrypto)
)

const history = await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(CollaborationLive))) // => ["Create by @agent", "Merge by @ada, @ben", "Edit by @agent"]
console.log(history)
```

## Over a network

Serve it over any RPC protocol, saying who's connecting and what they may do. `check` is optional, and decides whether a
live change is accepted. This program also needs `@effect/platform-node`:

```sh
pnpm add @effect/platform-node
```

```ts import.meta.vitest
import { NodeHttpServer, NodeSocket } from "@effect/platform-node"
import { Authority, Replica, ReplicatedText, Sync } from "@jpowersdev/effect-delta"
import { Actor, Collaboration, Document, Documents, DocumentStorage } from "@jpowersdev/effect-documents"
import { Effect, Layer, Option, Stream } from "effect"
import { SecureRandom } from "effect/crypto"
import { Headers, HttpRouter } from "effect/http"
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc"
import { createServer } from "node:http"

// One instance for all of a document's writers
const CollaborationLive = Collaboration.layer({
  check: ({ user }) =>
    user === "@viewer" ? Effect.fail(new Authority.Rejected({ message: "Read only" })) : Effect.void
}).pipe(
  Layer.provideMerge(DocumentStorage.layerMemory),
  Layer.provide(SecureRandom.layerWebCrypto)
)

// A real app would check a session here
const Users = Layer.succeed(Sync.Authorization)({
  identify: (headers) =>
    Effect.fromOption(Headers.get(headers, "x-user")).pipe(
      Effect.mapError(() => new Sync.Forbidden({ message: "Sign in first" }))
    ),
  authorize: () => Effect.void
})

const ServerLive = HttpRouter.serve(
  RpcServer.layer(Sync.Rpcs).pipe(
    Layer.provide(Authority.layerHandlers),
    Layer.provide(Users),
    Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/sync" }))
  ),
  { disableListenLog: true, disableLogger: true }
).pipe(
  Layer.provideMerge(CollaborationLive),
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3102 })),
  Layer.provide(RpcSerialization.layerNdjson)
)

// What a client provides
const AuthorityRemote = Authority.layerRemote.pipe(
  Layer.provide(RpcClient.layerProtocolSocket()),
  Layer.provide(NodeSocket.layerWebSocket("ws://localhost:3102/sync", { headers: { "x-user": "@ada" } })),
  Layer.provide(RpcSerialization.layerNdjson)
)

const id = Document.Id.make("spec")
const agent: Actor.Actor = { by: Actor.Id.make("@agent"), via: Option.none() }

// In the client, the text follows everyone else's and sends its own
const typing = Effect.gen(function*() {
  const text = yield* ReplicatedText.makeConfirmed({ document: Replica.DocumentId.make(id) })
  yield* text.connection.status.pipe(Stream.filter((status) => status._tag === "Synced"), Stream.runHead)
  yield* ReplicatedText.insert(text, 0, "Draft: ")
  yield* text.connection.unconfirmed.pipe(Stream.filter((count) => count === 0), Stream.runHead)
}).pipe(Effect.scoped, Effect.provide(AuthorityRemote), Effect.provide(SecureRandom.layerWebCrypto))

const program = Effect.gen(function*() {
  const documents = yield* Documents.Documents
  yield* documents.create({ id, actor: agent, title: "Spec", body: "Sessions last 24 hours." })
  yield* typing
  return (yield* documents.read(id)).body
})

const body = await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(ServerLive))) // => "Draft: Sessions last 24 hours."
console.log(body)
```

The server and client share a process here so the example runs by itself.

## How changes are kept

- **Saving.** A change is saved as a staged change before it's acknowledged or sent to anyone else. A process that dies
  loses nothing acknowledged: the next session, or the next command, picks it up.
- **History.** Staged changes become one `Merge` revision crediting everyone in them. That happens after a pause (`idle`,
  five seconds), at least every minute (`every`), before any command, when a document is released, and when a `read`
  finds some. `Collaboration.checkpoint` does it on demand.
- **Conflicting edits** merge but can read badly: "24 hours" changed to "8 hours" and to "12 hours" at once gives
  "812 hours". `ReplicatedText.subscribe` reports each such overlap, so an editor can point it out.
- **Presence**, meaning who's here and their selections, is effect-delta's `Presence` module. Merge `Presence.Rpcs` with
  `Sync.Rpcs` to serve both from one server; a client opens a connection for each.
