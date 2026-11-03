import type { Authority } from "@jpowersdev/effect-delta"
import type { Document } from "@jpowersdev/effect-documents"
import { Collaboration, Documents, DocumentStorage, SqlDocumentStorage } from "@jpowersdev/effect-documents"
import type { Effect, Layer, Schema } from "effect"
import type { SecureRandom } from "effect/crypto/SecureRandom"
import type { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { describe, expect, it } from "tstyche"

declare const documents: Documents.Documents["Service"]
declare const id: Document.Id

type Rejected = Documents.DocumentsError | DocumentStorage.DocumentStorageError | Schema.SchemaError

describe("Documents", () => {
  it("needs only storage, and no platform services", () => {
    expect(Documents.layer).type.toBe<
      Layer.Layer<Documents.Documents, never, DocumentStorage.DocumentStorage>
    >()
  })

  it("the memory store needs nothing", () => {
    expect(DocumentStorage.layerMemory).type.toBe<Layer.Layer<DocumentStorage.DocumentStorage>>()
  })

  it("a command has no actor or document id, which the host supplies", () => {
    expect<Documents.Command>().type.not.toBeAssignableFrom({ _tag: "Reply" as const })
    expect<Extract<Documents.Command, { _tag: "Reopen" }>>().type.toBe<
      { readonly _tag: "Reopen"; readonly thread: Extract<Documents.Command, { _tag: "Reply" }>["thread"] }
    >()
  })

  it("exposes each failure in the error channel", () => {
    expect(documents.apply).type.toBe<(input: Documents.Apply) => Effect.Effect<Document.Document, Rejected>>()
    expect(documents.remove(id)).type.toBe<Effect.Effect<void, DocumentStorage.DocumentStorageError>>()
  })
})

describe("Collaboration", () => {
  it("provides everything a document's writers go through, and needs storage and SecureRandom", () => {
    expect(Collaboration.layer()).type.toBe<
      Layer.Layer<
        Collaboration.Collaboration | Documents.Documents | Authority.Authority,
        never,
        DocumentStorage.DocumentStorage | SecureRandom
      >
    >()
  })

  it("only a command that could overwrite unseen work names a version", () => {
    expect<Extract<Documents.Command, { _tag: "Edit" }>>().type.not.toHaveProperty("version")
    expect<Extract<Documents.Command, { _tag: "Reply" }>>().type.not.toHaveProperty("version")
    expect<Extract<Documents.Command, { _tag: "Update" }>>().type.toHaveProperty("version")
    expect<Extract<Documents.Command, { _tag: "Restore" }>>().type.toHaveProperty("version")
    expect<Extract<Documents.Command, { _tag: "Resolve" }>>().type.toHaveProperty("version")
  })
})

describe("SqlDocumentStorage", () => {
  it("creating the table can fail, and using an existing one can't", () => {
    expect(SqlDocumentStorage.layer).type.toBe<
      Layer.Layer<DocumentStorage.DocumentStorage, SqlError, SqlClient>
    >()
    expect(SqlDocumentStorage.layerStorage({})).type.toBe<
      Layer.Layer<DocumentStorage.DocumentStorage, never, SqlClient>
    >()
    expect(SqlDocumentStorage.layerMigrations({})).type.toBe<Layer.Layer<never, SqlError, SqlClient>>()
  })
})
