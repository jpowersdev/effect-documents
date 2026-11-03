import { D1Client } from "@effect/sql-d1"
import { PgliteClient } from "@effect/sql-pglite"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import type * as Statement from "effect/sql/Statement"
import { DocumentStorage, SqlDocumentStorage } from "../src/index.ts"
import { layerD1 } from "./utils/d1.ts"
import { layerPostgres } from "./utils/postgres.ts"
import { freshId, revisionOf, storageContract } from "./utils/storageContract.ts"

const sqlite = SqliteClient.layer({ filename: ":memory:" })
const pglite = PgliteClient.layer({})

storageContract("layerMemory", DocumentStorage.layerMemory)
storageContract("SqlDocumentStorage on SQLite", SqlDocumentStorage.layer.pipe(Layer.provide(sqlite)))
storageContract("SqlDocumentStorage on PGlite", SqlDocumentStorage.layer.pipe(Layer.provide(pglite)))
storageContract("SqlDocumentStorage on PostgreSQL", SqlDocumentStorage.layer.pipe(Layer.provide(layerPostgres)))
storageContract("SqlDocumentStorage on D1", SqlDocumentStorage.layer.pipe(Layer.provide(layerD1)))

describe("SqlDocumentStorage", () => {
  it.effect("names its table with the prefix, so hosts can run several apart", () =>
    Effect.gen(function*() {
      const id = freshId()
      const first = yield* SqlDocumentStorage.make({ prefix: "first" })
      const second = yield* SqlDocumentStorage.make({ prefix: "second" })
      yield* first.append(revisionOf(id, 1))
      assert.isTrue(Result.isFailure(yield* Effect.result(second.read(id))))
    }).pipe(Effect.provide(sqlite)))

  it.effect("layerStorage runs no DDL; it uses the table layerMigrations made", () =>
    Effect.gen(function*() {
      const id = freshId()
      const before = yield* SqlDocumentStorage.layerStorage({}).pipe(
        Layer.build,
        Effect.flatMap((context) =>
          Effect.result(
            Effect.flatMap(DocumentStorage.DocumentStorage, (storage) => storage.read(id)).pipe(
              Effect.provide(context)
            )
          )
        )
      )
      assert.strictEqual(
        Option.getOrThrow(Result.getFailure(before)).reason._tag,
        "StorageFailure",
        "the table doesn't exist yet"
      )
      yield* Layer.build(SqlDocumentStorage.layerMigrations({}))
      yield* Effect.flatMap(DocumentStorage.DocumentStorage, (storage) => storage.append(revisionOf(id, 1))).pipe(
        Effect.provide(SqlDocumentStorage.layerStorage({}))
      )
    }).pipe(Effect.provide(sqlite)))

  it.effect("appends without branching on dialect, so it works through clients that defer their calls", () =>
    Effect.gen(function*() {
      // A deferred client hands back a proxy from a dialect's callback, which `commit` can't put in a batch.
      const sql = yield* SqlClient.SqlClient
      const deferred: SqlClient.SqlClient = new Proxy(sql, {
        get: (target, property) =>
          property === "onDialectOrElse"
            ? () => assert.fail("append branched on dialect")
            : property === "withoutTransforms"
            ? () => deferred
            : Reflect.get(target, property)
      })
      yield* Layer.build(SqlDocumentStorage.layerMigrations({}))
      const storage = yield* SqlDocumentStorage.layerStorage({}).pipe(
        Layer.build,
        Effect.map(Context.get(DocumentStorage.DocumentStorage)),
        Effect.provideService(SqlClient.SqlClient, deferred)
      )
      yield* storage.append(revisionOf(freshId(), 1))
    }).pipe(Effect.provide(sqlite)))

  // Each database groups statements its own way: a batch on D1, a transaction elsewhere.
  const commitOn = <E>(
    name: string,
    client: Layer.Layer<SqlClient.SqlClient, E>,
    group: (
      statements: readonly [Statement.Statement<unknown>, Statement.Statement<unknown>]
    ) => Effect.Effect<unknown, SqlError, SqlClient.SqlClient>
  ) =>
    it.layer(
      Layer.effectDiscard(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) => sql`CREATE TABLE projected (id TEXT PRIMARY KEY, title TEXT NOT NULL CHECK (title <> 'refused'))`
        )
      ).pipe(Layer.provideMerge(client))
    )(`commit on ${name}`, (it) => {
      const projection = Effect.gen(function*() {
        const context = yield* Effect.context<SqlClient.SqlClient>()
        const sql = yield* SqlClient.SqlClient
        return yield* SqlDocumentStorage.make({
          commit: (statement, revision) =>
            group([
              statement,
              sql`INSERT INTO projected (id, title) VALUES (${revision.document.id}, ${revision.document.title})
                ON CONFLICT (id) DO UPDATE SET title = excluded.title`
            ]).pipe(Effect.provideContext(context))
        })
      })

      const projectedTitle = (id: string) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          const rows = yield* sql`SELECT title FROM projected WHERE id = ${id}`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ title: Schema.String }))))
          )
          return rows[0]?.title
        })

      it.effect("commits a revision together with the host's own write", () =>
        Effect.gen(function*() {
          const storage = yield* projection
          const id = freshId()
          yield* storage.append(revisionOf(id, 1))
          assert.strictEqual(yield* projectedTitle(id), "v1")
        }))

      it.effect("a conflicting append rolls back the host's write", () =>
        Effect.gen(function*() {
          const storage = yield* projection
          const id = freshId()
          yield* storage.append(revisionOf(id, 1))
          yield* storage.append(revisionOf(id, 2))
          const stale = yield* Effect.result(storage.append(revisionOf(id, 2, "stale")))
          assert.deepStrictEqual(
            Option.getOrThrow(Result.getFailure(stale)).reason,
            new DocumentStorage.Conflict({ id, expected: 1, actual: 2 })
          )
          assert.strictEqual(yield* projectedTitle(id), "v2")
        }))

      it.effect("a failing host write rolls back the revision, as a storage failure and not a conflict", () =>
        Effect.gen(function*() {
          const storage = yield* projection
          const id = freshId()
          yield* storage.append(revisionOf(id, 1))
          const failed = yield* Effect.result(storage.append(revisionOf(id, 2, "refused")))
          assert.strictEqual(Option.getOrThrow(Result.getFailure(failed)).reason._tag, "StorageFailure")
          assert.strictEqual((yield* storage.read(id)).version, 1)
          assert.strictEqual(yield* projectedTitle(id), "v1")
        }))
    })

  const inTransaction = ([first, second]: readonly [Statement.Statement<unknown>, Statement.Statement<unknown>]) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(Effect.andThen(first, second)))

  commitOn("D1", layerD1, (statements) => Effect.flatMap(D1Client.D1Client, (sql) => sql.batch(statements)))
  commitOn("SQLite", SqliteClient.layer({ filename: ":memory:" }), inTransaction)
  commitOn("PostgreSQL", layerPostgres, inTransaction)
})
