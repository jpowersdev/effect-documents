---
title: "Storage"
description: "Durable storage on SQLite, D1 and PostgreSQL, or your own."
sidebar:
  order: 5
---

## On a database

`SqlDocumentStorage` works on SQLite (including D1) and PostgreSQL, with any `SqlClient`. `layer` creates its tables on
startup. These programs also need a client, here `@effect/sql-sqlite-node`:

```sh
pnpm add @effect/sql-sqlite-node
```

```ts import.meta.vitest
import { SqliteClient } from "@effect/sql-sqlite-node"
import {
  Actor,
  Document,
  Documents,
  SqlDocumentStorage
} from "@jpowersdev/effect-documents"
import { Effect, Layer, Option } from "effect"

const program = Effect.gen(function*() {
  const documents = yield* Documents.Documents
  const actor: Actor.Actor = { by: Actor.Id.make("@owner"), via: Option.none() }
  const created = yield* documents.create({
    id: Document.Id.make("spec"),
    actor,
    title: "Spec",
    body: "Sessions last 24 hours."
  })
  const version = created.version
  yield* Effect.log(version)
  return version
})

const DocumentsLive = Documents.layer.pipe(
  Layer.provide(SqlDocumentStorage.layer),
  // A file name keeps it between runs
  Layer.provide(SqliteClient.layer({ filename: ":memory:" }))
)

await Effect.runPromise(program.pipe(Effect.provide(DocumentsLive))) // => 1
```

To create the tables in a deploy step or a migration file instead, use `layerStorage`, which runs no DDL. With the default
prefix, the tables are:

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

## Project into your own tables

`commit` commits a revision and your own write atomically, so a list or search table can't disagree with the document. Use a
transaction, or `batch` on D1.

```ts import.meta.vitest
import { SqliteClient } from "@effect/sql-sqlite-node"
import {
  Actor,
  Document,
  Documents,
  SqlDocumentStorage
} from "@jpowersdev/effect-documents"
import { Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"

const StorageLive = Layer.unwrap(Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE IF NOT EXISTS my_documents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL
  )`
  return SqlDocumentStorage.layerWith({
    commit: (statement, revision) =>
      sql.withTransaction(Effect.andThen(
        statement,
        sql`INSERT INTO my_documents (id, title)
          VALUES (${revision.document.id}, ${revision.document.title})
          ON CONFLICT (id) DO UPDATE SET title = excluded.title`
      ))
  })
}))

const program = Effect.gen(function*() {
  const documents = yield* Documents.Documents
  const actor: Actor.Actor = { by: Actor.Id.make("@owner"), via: Option.none() }
  yield* documents.create({
    id: Document.Id.make("spec"),
    actor,
    title: "Spec",
    body: "Sessions last 24 hours."
  })

  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ readonly title: string }>`SELECT title FROM my_documents`
  yield* Effect.log(rows)
  return rows
})

const DocumentsLive = Documents.layer.pipe(
  Layer.provide(StorageLive),
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" }))
)

await Effect.runPromise(program.pipe(Effect.provide(DocumentsLive))) // => [{ title: "Spec" }]
```

A conflict rolls back your write. A write of yours that fails rolls back the revision, and surfaces as a `StorageFailure`.

Commit a transaction inside `commit`, not around a call to the service. After a failed statement, PostgreSQL rejects the query
that tells a `Conflict` from other failures until the transaction ends.

To bring existing documents in, `create` each one, up front or the first time it's used.

## Other stores

Implement `DocumentStorage`. `append` must compare the current version with `revision.version - 1` (zero means the
document doesn't exist) and commit the whole record atomically, or fail with `Conflict`, reporting both versions and
leaving storage unchanged. `stage` must be durable by the time it returns. Readers must receive isolated values.
[`storageContract.ts`](https://github.com/jpowersdev/effect-documents/blob/main/test/utils/storageContract.ts) is the contract
as tests, which memory, SQLite, PostgreSQL and D1 all run.

An interrupted commit may still have landed, as with any database write, so read again before deciding to retry.
