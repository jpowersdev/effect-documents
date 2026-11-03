/**
 * The `Revision` module describes the immutable records a document's history is
 * made of. A revision holds what a reader needs, the materialized document, and
 * what a writer needs, only the text changes it introduced. Reading any version
 * therefore never replays history, and no record grows with the ones before it.
 *
 * @stability unstable
 * @since 0.1.0
 */
import * as Delta from "@jpowersdev/effect-delta/Delta"
import * as Schema from "effect/Schema"
import * as Actor from "./Actor.ts"
import * as Document from "./Document.ts"

/**
 * What happened in a revision, without its content.
 *
 * **Details**
 *
 * `Merge` gathers live changes that came in since the last revision. `actors`
 * starts with whoever ran the command, then lists anyone else whose live changes
 * it holds. A merge has no command, so it lists only those, and none at all when
 * it recovers changes whose author wasn't recorded.
 *
 * @stability unstable
 * @category schemas
 * @since 0.1.0
 */
export const Info = Schema.Struct({
  version: Document.Version,
  action: Schema.Literals(["Create", "Edit", "Update", "Open", "Reply", "Resolve", "Reopen", "Restore", "Merge"]),
  actors: Schema.Array(Actor.Actor),
  at: Schema.Int,
  note: Schema.String,
  restoredFrom: Schema.OptionFromNullOr(Document.Version)
})

/**
 * A history entry: who did what, when and why.
 *
 * @stability unstable
 * @category models
 * @since 0.1.0
 */
export type Info = typeof Info.Type

/**
 * One accepted command or merge: its history entry, the document it produced, and
 * the text changes it introduced on top of the previous revision.
 *
 * @stability unstable
 * @category schemas
 * @since 0.1.0
 */
export const Revision = Schema.Struct({
  ...Info.fields,
  document: Document.Document,
  changes: Delta.Delta
})

/**
 * The stored record of a document change.
 *
 * @stability unstable
 * @category models
 * @since 0.1.0
 */
export type Revision = typeof Revision.Type

/**
 * Returns a revision's history entry.
 *
 * @stability unstable
 * @category getters
 * @since 0.1.0
 */
export const info = ({ changes: _changes, document: _document, ...entry }: Revision): Info => entry
