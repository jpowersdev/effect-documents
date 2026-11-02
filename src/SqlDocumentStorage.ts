/**
 * The `SqlDocumentStorage` module keeps revisions in one SQL table, on SQLite
 * (including Cloudflare D1) and PostgreSQL.
 *
 * Every append is a single statement, because not every client has transactions:
 * D1 only has atomic batches. Its primary key and a compare inside the statement
 * make it fail unless the document is at exactly the previous version, so an
 * atomic group the statement joins rolls back with it.
 *
 * `layer`, `layerWith` and `make` create the tables before building the storage. To
 * create them elsewhere, such as a deploy step or a host's migration files, use
 * `layerMigrations` there, or the DDL below, and `layerStorage` in the runtime.
 *
 * ```sql
 * CREATE TABLE IF NOT EXISTS documents_revisions (
 *   document_id TEXT NOT NULL,
 *   version INTEGER NOT NULL,
 *   info TEXT NOT NULL,
 *   document TEXT NOT NULL,
 *   changes TEXT NOT NULL,
 *   PRIMARY KEY (document_id, version)
 * )
 * CREATE TABLE IF NOT EXISTS documents_staged (
 *   document_id TEXT NOT NULL,
 *   position INTEGER NOT NULL,
 *   changes TEXT NOT NULL,
 *   PRIMARY KEY (document_id, position)
 * )
 * CREATE TABLE IF NOT EXISTS documents_writers (
 *   document_id TEXT NOT NULL,
 *   replica TEXT NOT NULL,
 *   owner TEXT NOT NULL,
 *   PRIMARY KEY (document_id, replica)
 * )
 * ```
 *
 * @stability unstable
 * @since 0.1.0
 */
import * as Delta from "effect-delta/Delta"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import type * as Statement from "effect/sql/Statement"
import * as Document from "./Document.ts"
import * as DocumentStorage from "./DocumentStorage.ts"
import * as Revision from "./Revision.ts"

/**
 * How SQL-backed storage names its table and commits a revision.
 *
 * @stability unstable
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /**
   * Starts each table's name: `<prefix>_revisions`, `<prefix>_staged` and
   * `<prefix>_writers`.
   *
   * @default "documents"
   */
  readonly prefix?: string | undefined

  /**
   * Runs the append statement, by default alone.
   *
   * Use it to commit the statement atomically with a host's own writes, in a D1
   * `batch` or a transaction that also updates a table of the host's. It must run
   * the statement and return its failure. The statement fails unless the document
   * is at the previous version, so the whole group rolls back.
   */
  readonly commit?:
    | ((statement: Statement.Statement<unknown>, revision: Revision.Revision) => Effect.Effect<unknown, SqlError>)
    | undefined
}

const InfoJson = Schema.fromJsonString(Revision.Info)
const DocumentJson = Schema.fromJsonString(Document.Document)
const ChangesJson = Schema.fromJsonString(Delta.Delta)

const decodeInfo = Schema.decodeEffect(InfoJson)
const decodeDocument = Schema.decodeEffect(DocumentJson)
const decodeChanges = Schema.decodeEffect(ChangesJson)
const encodeInfo = Schema.encodeEffect(InfoJson)
const encodeDocument = Schema.encodeEffect(DocumentJson)
const encodeChanges = Schema.encodeEffect(ChangesJson)

const fail = (reason: DocumentStorage.NotFound | DocumentStorage.Conflict | DocumentStorage.StorageFailure) =>
  new DocumentStorage.DocumentStorageError({ reason })
const failure = (cause: unknown) => fail(new DocumentStorage.StorageFailure({ cause }))

const makeTable = (options: Pick<Options, "prefix">) =>
  Effect.gen(function*() {
    const sql = (yield* SqlClient.SqlClient).withoutTransforms()
    const prefix = options.prefix ?? "documents"
    const create = Effect.all([
      sql`CREATE TABLE IF NOT EXISTS ${sql(`${prefix}_revisions`)} (
        document_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        info TEXT NOT NULL,
        document TEXT NOT NULL,
        changes TEXT NOT NULL,
        PRIMARY KEY (document_id, version)
      )`,
      sql`CREATE TABLE IF NOT EXISTS ${sql(`${prefix}_staged`)} (
        document_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        changes TEXT NOT NULL,
        PRIMARY KEY (document_id, position)
      )`,
      sql`CREATE TABLE IF NOT EXISTS ${sql(`${prefix}_writers`)} (
        document_id TEXT NOT NULL,
        replica TEXT NOT NULL,
        owner TEXT NOT NULL,
        PRIMARY KEY (document_id, replica)
      )`
    ], { discard: true })
    yield* sql.onDialectOrElse({
      pg: () => create,
      sqlite: () => create,
      orElse: () => Effect.die(new Error("SqlDocumentStorage supports SQLite and PostgreSQL"))
    })
  })

const makeStorage = (
  options: Options
): Effect.Effect<DocumentStorage.DocumentStorage["Service"], never, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = (yield* SqlClient.SqlClient).withoutTransforms()
    const prefix = options.prefix ?? "documents"
    const table = sql(`${prefix}_revisions`)
    const stagedTable = sql(`${prefix}_staged`)
    const writersTable = sql(`${prefix}_writers`)
    const commit = options.commit ?? ((statement) => statement)

    const currentVersion = (id: Document.Id) =>
      sql<{ readonly version: number | string }>`
        SELECT COALESCE(MAX(version), 0) AS version FROM ${table} WHERE document_id = ${id}
      `.pipe(
        Effect.map((rows) => Number(rows[0]?.version ?? 0)),
        Effect.mapError(failure)
      )

    const notFound = (id: Document.Id, version: Option.Option<number> = Option.none()) =>
      fail(new DocumentStorage.NotFound({ id, version }))

    return DocumentStorage.DocumentStorage.of({
      read: Effect.fnUntraced(function*(id, options) {
        const version = options?.version
        const rows = yield* sql<{ readonly info: string; readonly document: string; readonly changes: string }>`
          SELECT info, document, changes FROM ${table}
          WHERE ${
          version === undefined
            ? sql`document_id = ${id} ORDER BY version DESC LIMIT 1`
            : sql`document_id = ${id} AND version = ${version}`
        }
        `.pipe(Effect.mapError(failure))
        const row = rows[0]
        if (row === undefined) return yield* notFound(id, Option.fromUndefinedOr(version))
        const [info, document, changes] = yield* Effect.all([
          decodeInfo(row.info),
          decodeDocument(row.document),
          decodeChanges(row.changes)
        ]).pipe(Effect.mapError(failure))
        return { ...info, document, changes }
      }),

      history: Effect.fnUntraced(function*(id) {
        const rows = yield* sql<{ readonly info: string }>`
          SELECT info FROM ${table} WHERE document_id = ${id} ORDER BY version
        `.pipe(Effect.mapError(failure))
        if (rows.length === 0) return yield* notFound(id)
        return yield* Effect.forEach(rows, (row) => decodeInfo(row.info)).pipe(Effect.mapError(failure))
      }),

      changes: Effect.fnUntraced(function*(id, { through }) {
        const rows = yield* sql<{ readonly changes: string }>`
          SELECT changes FROM ${table} WHERE document_id = ${id} AND version <= ${through} ORDER BY version
        `.pipe(Effect.mapError(failure))
        if (rows.length === 0) return yield* notFound(id)
        return yield* Effect.forEach(rows, (row) => decodeChanges(row.changes)).pipe(Effect.mapError(failure))
      }),

      append: Effect.fnUntraced(function*(revision) {
        const id = revision.document.id
        const expected = revision.version - 1
        const [info, document, changes] = yield* Effect.all([
          encodeInfo(Revision.info(revision)),
          encodeDocument(revision.document),
          encodeChanges(revision.changes)
        ]).pipe(Effect.mapError(failure))
        // When the document isn't at the expected version the CASE gives NULL, which
        // NOT NULL rejects. Failing, rather than inserting no rows, is what rolls back
        // a batch or transaction the statement joined. Racing writers both pass the
        // compare under PostgreSQL's isolation, and the primary key stops the second.
        // PostgreSQL can't infer the type of a parameter in a SELECT without the CASTs.
        const statement = sql`INSERT INTO ${table} (document_id, version, info, document, changes)
          SELECT CAST(${id} AS TEXT), CASE WHEN (
            SELECT COALESCE(MAX(version), 0) FROM ${table} WHERE document_id = CAST(${id} AS TEXT)
          ) = CAST(${expected} AS INTEGER) THEN CAST(${revision.version} AS INTEGER) END,
          CAST(${info} AS TEXT), CAST(${document} AS TEXT), CAST(${changes} AS TEXT)`
        // Decide from the version, not the error: D1 reports every failure as unknown.
        yield* commit(statement, revision).pipe(
          Effect.catchTag("SqlError", (cause) =>
            Effect.flatMap(
              currentVersion(id),
              (actual) =>
                Effect.fail(
                  actual === expected ? failure(cause) : fail(new DocumentStorage.Conflict({ id, expected, actual }))
                )
            ))
        )
      }),

      remove: Effect.fnUntraced(function*(id) {
        if ((yield* currentVersion(id)) === 0) return yield* notFound(id)
        // Revisions last: if this stops partway, the document still exists and
        // removing it can run again.
        yield* Effect.all([
          sql`DELETE FROM ${stagedTable} WHERE document_id = ${id}`,
          sql`DELETE FROM ${writersTable} WHERE document_id = ${id}`,
          sql`DELETE FROM ${table} WHERE document_id = ${id}`
        ], { discard: true }).pipe(Effect.mapError(failure))
      }),

      stage: (id, delta) =>
        encodeChanges(delta).pipe(
          Effect.flatMap((changes) =>
            sql`INSERT INTO ${stagedTable} (document_id, position, changes)
              SELECT CAST(${id} AS TEXT), COALESCE(MAX(position), 0) + 1, CAST(${changes} AS TEXT)
              FROM ${stagedTable} WHERE document_id = CAST(${id} AS TEXT)`
          ),
          Effect.asVoid,
          Effect.mapError(failure)
        ),

      staged: (id) =>
        sql<{ readonly position: number | string; readonly changes: string }>`
          SELECT position, changes FROM ${stagedTable} WHERE document_id = ${id} ORDER BY position
        `.pipe(
          Effect.flatMap(
            Effect.forEach((row) =>
              Effect.map(decodeChanges(row.changes), (changes) => ({ position: Number(row.position), changes }))
            )
          ),
          Effect.mapError(failure)
        ),

      unstage: (id, { through }) =>
        sql`DELETE FROM ${stagedTable} WHERE document_id = ${id} AND position <= ${through}`.pipe(
          Effect.asVoid,
          Effect.mapError(failure)
        ),

      addWriter: (id, replica, owner) =>
        sql`INSERT INTO ${writersTable} (document_id, replica, owner)
          VALUES (${id}, ${replica}, ${owner})
          ON CONFLICT (document_id, replica) DO NOTHING`.pipe(Effect.asVoid, Effect.mapError(failure)),

      writers: Effect.fnUntraced(function*(id) {
        const rows = yield* sql<{ readonly replica: string; readonly owner: string }>`
          SELECT replica, owner FROM ${writersTable} WHERE document_id = ${id}
        `.pipe(Effect.mapError(failure))
        return Object.fromEntries(rows.map((row) => [row.replica, row.owner]))
      })
    })
  })

/**
 * Creates SQL-backed storage after creating its tables.
 *
 * **Gotchas**
 *
 * Commit a transaction inside `commit`, not around a call to the service. After a
 * failed statement, PostgreSQL rejects the query that tells a `Conflict` from other
 * failures until the transaction ends, and the caller sees a `StorageFailure`.
 *
 * @stability unstable
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  options: Options
): Effect.Effect<DocumentStorage.DocumentStorage["Service"], SqlError, SqlClient.SqlClient> =>
  Effect.andThen(makeTable(options), makeStorage(options))

/**
 * Creates the storage's tables if they don't exist.
 *
 * **Details**
 *
 * `prefix` must match the one given to the storage.
 *
 * @stability unstable
 * @category layers
 * @since 0.1.0
 */
export const layerMigrations = (options: Pick<Options, "prefix">): Layer.Layer<never, SqlError, SqlClient.SqlClient> =>
  Layer.effectDiscard(makeTable(options))

/**
 * Provides SQL-backed storage without creating its tables.
 *
 * **When to use**
 *
 * Use when the tables are created separately, or per request on a client where
 * running DDL each time would cost a round trip, such as D1 in a Worker.
 *
 * @stability unstable
 * @category layers
 * @since 0.1.0
 */
export const layerStorage = (
  options: Options
): Layer.Layer<DocumentStorage.DocumentStorage, never, SqlClient.SqlClient> =>
  Layer.effect(DocumentStorage.DocumentStorage, makeStorage(options))

/**
 * Provides SQL-backed storage with custom options, creating its tables first.
 *
 * @stability unstable
 * @category layers
 * @since 0.1.0
 */
export const layerWith = (
  options: Options
): Layer.Layer<DocumentStorage.DocumentStorage, SqlError, SqlClient.SqlClient> =>
  Layer.effect(DocumentStorage.DocumentStorage, make(options))

/**
 * Provides SQL-backed storage in tables starting `documents_`, creating them first.
 *
 * @stability unstable
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<DocumentStorage.DocumentStorage, SqlError, SqlClient.SqlClient> = layerWith({})
