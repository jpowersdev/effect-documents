/**
 * The `Actor` module describes who a document change is attributed to: the
 * person it was made for, and the agent that made it for them, if any.
 *
 * The library records actors but never checks them. Authenticating an actor and
 * deciding what they may do belong to the host application.
 *
 * @stability unstable
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/**
 * The stable identity of a person, allocated by the host application.
 *
 * @stability unstable
 * @category schemas
 * @since 0.1.0
 */
export const Id = Schema.NonEmptyString.pipe(Schema.brand("effect-documents/ActorId"))

/**
 * The stable identity of a person.
 *
 * @stability unstable
 * @category models
 * @since 0.1.0
 */
export type Id = typeof Id.Type

/**
 * Details supplied by an agent's harness when it acts for a person.
 *
 * @stability unstable
 * @category schemas
 * @since 0.1.0
 */
export const Agent = Schema.Struct({
  harness: Schema.NonEmptyString,
  model: Schema.OptionFromNullOr(Schema.NonEmptyString),
  session: Schema.OptionFromNullOr(Schema.NonEmptyString)
})

/**
 * Details of the agent acting for a person.
 *
 * @stability unstable
 * @category models
 * @since 0.1.0
 */
export type Agent = typeof Agent.Type

/**
 * The attribution retained on every revision and review action.
 *
 * @stability unstable
 * @category schemas
 * @since 0.1.0
 */
export const Actor = Schema.Struct({
  by: Id,
  via: Schema.OptionFromNullOr(Agent)
})

/**
 * The person, and the optional agent, that made a change.
 *
 * @stability unstable
 * @category models
 * @since 0.1.0
 */
export type Actor = typeof Actor.Type
