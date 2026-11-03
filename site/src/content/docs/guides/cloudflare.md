---
title: "Cloudflare Workers"
description: "Live editing with one Durable Object per document."
sidebar:
  order: 4
---

Run one Durable Object per document, so each document has one writer. This is a complete Worker: requests to
`/documents/<id>` go to that document's object, which creates the document on a `POST` and serves live editing on a WebSocket
upgrade.

```sh
pnpm add @jpowersdev/effect-documents @jpowersdev/effect-delta @effect/sql-d1 effect
pnpm add -D wrangler @cloudflare/workers-types
```

## `wrangler.jsonc`

```jsonc
{
  "name": "documents",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-30",
  "d1_databases": [{ "binding": "DB", "database_name": "documents", "database_id": "<your database id>" }],
  "durable_objects": { "bindings": [{ "name": "DOCUMENTS", "class_name": "DocumentObject" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["DocumentObject"] }]
}
```

## `src/index.ts`

```ts
import { D1Client } from "@effect/sql-d1"
import { Authority, Sync } from "@jpowersdev/effect-delta"
import { Actor, Collaboration, Document, Documents, SqlDocumentStorage } from "@jpowersdev/effect-documents"
import { DurableObject } from "cloudflare:workers"
import { Context, Effect, Layer, ManagedRuntime, Option, Scope } from "effect"
import { SecureRandom } from "effect/crypto"
import { Headers, HttpServerRequest } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { Socket } from "effect/socket"

interface Env {
  readonly DB: D1Database
  readonly DOCUMENTS: DurableObjectNamespace<DocumentObject>
}

// A real app would check a session here
const Users = Layer.succeed(Sync.Authorization)({
  identify: (headers) =>
    Effect.fromOption(Headers.get(headers, "x-user")).pipe(
      Effect.mapError(() => new Sync.Forbidden({ message: "Sign in first" }))
    ),
  authorize: () => Effect.void
})

// Runs the RPC server, and hands sockets to it for as long as the object lives
class Sockets extends Context.Service<Sockets>()("Sockets", {
  make: Effect.gen(function*() {
    const { httpEffect, protocol } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket
    yield* RpcServer.make(Sync.Rpcs).pipe(
      Effect.provideService(RpcServer.Protocol, protocol),
      Effect.forkScoped
    )
    const scope = yield* Effect.scope
    return {
      accept: (request: HttpServerRequest.HttpServerRequest) =>
        httpEffect.pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, request),
          Effect.provideService(Scope.Scope, scope)
        )
    }
  })
}) {}

const ObjectLive = (db: D1Database) =>
  Layer.effect(Sockets, Sockets.make).pipe(
    Layer.provide(Authority.layerHandlers),
    Layer.provide(Users),
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provideMerge(Collaboration.layer()),
    Layer.provide(SqlDocumentStorage.layer),
    Layer.provide(D1Client.layer({ db })),
    Layer.provide(SecureRandom.layerWebCrypto)
  )

// One object per document, so each document has one writer
export class DocumentObject extends DurableObject<Env> {
  readonly runtime = ManagedRuntime.make(ObjectLive(this.env.DB))

  async fetch(request: Request): Promise<Response> {
    const id = Document.Id.make(new URL(request.url).pathname.split("/")[2]!)

    if (request.headers.get("upgrade") !== "websocket") {
      const actor: Actor.Actor = { by: Actor.Id.make("@owner"), via: Option.none() }
      const body = await request.text()
      const created = await this.runtime.runPromise(
        Effect.flatMap(Documents.Documents, (documents) => documents.create({ id, actor, title: id, body }))
      )
      return Response.json({ version: created.version })
    }

    const { 0: client, 1: server } = new WebSocketPair()
    server.accept()
    const base = HttpServerRequest.fromWeb(request)
    // The request, with this side of the pair as its socket
    const upgraded: HttpServerRequest.HttpServerRequest = Object.create(base, {
      upgrade: { value: Socket.fromWebSocket(Effect.succeed(server)) },
      headers: { value: base.headers }
    })
    this.runtime.runFork(Effect.flatMap(Sockets, ({ accept }) => accept(upgraded)))
    return new Response(null, { status: 101, webSocket: client })
  }
}

export default {
  // Requests to /documents/<id> go to that document's object
  fetch: (request: Request, env: Env) => {
    const name = new URL(request.url).pathname.split("/")[2]!
    return env.DOCUMENTS.get(env.DOCUMENTS.idFromName(name)).fetch(request)
  }
}
```

Run it with `pnpm wrangler dev`, then create a document:

```sh
curl -X POST localhost:8787/documents/spec -d "Sessions last 24 hours."
```

A client connects to `ws://localhost:8787/documents/spec`, with `Authority.layerRemote` as in
[Live editing](../live-editing/#over-a-network), sending its `x-user` header.

## Things to know

- **`SqlDocumentStorage.layer` runs DDL whenever an object starts.** Once the tables exist, `layerStorage({})` saves the round
  trip. [Storage](../storage/#on-a-database) has the tables for a migration file.
- **These sockets don't hibernate,** so an object stays in memory while anyone is connected.
- **Timers don't survive eviction,** but nothing is lost: staged changes wait for the next visitor, or call
  `Collaboration.checkpoint` from an alarm.

This has run under workerd on D1, with a real client over a WebSocket, but not on Cloudflare itself.
