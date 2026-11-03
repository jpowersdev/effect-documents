import { PgClient } from "@effect/sql-pg"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Scope from "effect/Scope"
import * as SqlClient from "effect/sql/SqlClient"
import { inject } from "vitest"

/** A connection pool of its own, as a separate process would have. */
export const layerClient = (url: string) => PgClient.layer({ url: Redacted.make(url), maxConnections: 8 })

let databases = 0

/** The URL of a new database on the test server, dropped when the scope closes. */
export const database: Effect.Effect<string, never, Scope.Scope> = Effect.gen(function*() {
  const server = inject("postgresUrl")
  const name = `test_${process.pid}_${++databases}`
  const administer = (run: (sql: SqlClient.SqlClient) => Effect.Effect<unknown, unknown>) =>
    Effect.flatMap(SqlClient.SqlClient, run).pipe(
      Effect.scoped,
      Effect.provide(layerClient(server)),
      Effect.orDie
    )
  yield* Effect.acquireRelease(
    administer((sql) => sql`CREATE DATABASE ${sql(name)}`),
    () => administer((sql) => sql`DROP DATABASE ${sql(name)} WITH (FORCE)`)
  )
  const url = new URL(server)
  url.pathname = `/${name}`
  return url.href
})

/** A client on a new database of its own. */
export const layerPostgres = Layer.unwrap(Effect.map(database, layerClient))

/**
 * Closes every connection to the current database, as a restart or failover would, and says
 * how many there were.
 */
export const dropConnections: Effect.Effect<number, never, SqlClient.SqlClient> = Effect.gen(function*() {
  const current = yield* SqlClient.SqlClient
  const rows = yield* current<{ readonly name: string }>`SELECT current_database() AS name`
  const dropped = yield* Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${rows[0]!.name}`
  ).pipe(Effect.scoped, Effect.provide(layerClient(inject("postgresUrl"))))
  return dropped.length
}).pipe(Effect.orDie)
