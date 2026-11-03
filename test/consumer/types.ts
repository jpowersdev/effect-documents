import { Document, Documents, DocumentStorage } from "@jpowersdev/effect-documents"
import type { Effect } from "effect"
import * as EffectRuntime from "effect/Effect"
import type * as Schema from "effect/Schema"

/**
 * An external consumer sees the engine service and every recoverable failure.
 *
 * @stability unstable
 */
export const read: Effect.Effect<
  Document.Document,
  DocumentStorage.DocumentStorageError | Schema.SchemaError,
  Documents.Documents
> = EffectRuntime.flatMap(Documents.Documents, (documents) => documents.read(Document.Id.make("external-consumer")))
