/**
 * The `Thread` module describes anchored discussions: a conversation attached to
 * a passage of a document that follows its characters through later edits.
 *
 * @stability unstable
 * @since 0.1.0
 */
import * as ReplicatedText from "effect-delta/ReplicatedText"
import * as Schema from "effect/Schema"
import * as Actor from "./Actor.ts"

/**
 * A discussion's identity within a document, allocated by the host application.
 *
 * @stability unstable
 * @category schemas
 * @since 0.1.0
 */
export const Id = Schema.NonEmptyString.pipe(Schema.brand("effect-documents/ThreadId"))

/**
 * A discussion's identity within a document.
 *
 * @stability unstable
 * @category models
 * @since 0.1.0
 */
export type Id = typeof Id.Type

/**
 * A review action, attributed to the person or agent that made it.
 *
 * @stability unstable
 * @category schemas
 * @since 0.1.0
 */
export const Event = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  actor: Actor.Actor,
  at: Schema.Int,
  action: Schema.Literals(["Open", "Reply", "Resolve", "Reopen"]),
  body: Schema.OptionFromNullOr(Schema.NonEmptyString)
})

/**
 * A review action in a discussion.
 *
 * @stability unstable
 * @category models
 * @since 0.1.0
 */
export type Event = typeof Event.Type

/**
 * A discussion with its original quote, stable anchor and every review action.
 *
 * @stability unstable
 * @category schemas
 * @since 0.1.0
 */
export const Thread = Schema.Struct({
  id: Id,
  anchor: ReplicatedText.AnchorRange,
  quote: Schema.NonEmptyString,
  events: Schema.NonEmptyArray(Event)
})

/**
 * A discussion on a passage of a document.
 *
 * @stability unstable
 * @category models
 * @since 0.1.0
 */
export type Thread = typeof Thread.Type

/**
 * Returns whether a discussion is open or resolved. A later reply or explicit
 * reopen opens a resolved discussion again.
 *
 * @stability unstable
 * @category getters
 * @since 0.1.0
 */
export const status = (self: Thread): "open" | "resolved" =>
  self.events[self.events.length - 1]!.action === "Resolve" ? "resolved" : "open"

/**
 * A discussion and where its passage is in one revision, as UTF-16 offsets. The
 * range is `None` once every anchored character has been deleted.
 *
 * @stability unstable
 * @category schemas
 * @since 0.1.0
 */
export const Located = Schema.Struct({
  thread: Thread,
  range: Schema.OptionFromNullOr(Schema.Struct({ start: Schema.Natural, end: Schema.Natural }))
})

/**
 * A discussion and its location in one revision.
 *
 * @stability unstable
 * @category models
 * @since 0.1.0
 */
export type Located = typeof Located.Type
