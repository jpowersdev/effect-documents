/**
 * The `Document` module describes what a reader sees: a document's title, body
 * and discussions at one version.
 *
 * @stability unstable
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import * as Thread from "./Thread.ts"

/**
 * A document's stable identity, allocated by the host application.
 *
 * @stability unstable
 * @category schemas
 * @since 0.1.0
 */
export const Id = Schema.NonEmptyString.pipe(Schema.brand("effect-documents/DocumentId"))

/**
 * A document's stable identity.
 *
 * @stability unstable
 * @category models
 * @since 0.1.0
 */
export type Id = typeof Id.Type

/**
 * A positive revision number. Every accepted command advances it by exactly one.
 *
 * @stability unstable
 * @category schemas
 * @since 0.1.0
 */
export const Version = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/**
 * A consistent view of a document at one revision, including the version the next
 * command must name.
 *
 * @stability unstable
 * @category schemas
 * @since 0.1.0
 */
export const Document = Schema.Struct({
  id: Id,
  title: Schema.String,
  body: Schema.String,
  version: Version,
  threads: Schema.Array(Thread.Located)
})

/**
 * A document's content and review data at one revision.
 *
 * @stability unstable
 * @category models
 * @since 0.1.0
 */
export type Document = typeof Document.Type
