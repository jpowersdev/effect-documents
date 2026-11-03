import { NodeRuntime } from "@effect/platform-node"
import { Replica, ReplicatedText, Sync } from "@jpowersdev/effect-delta"
import { Actor, Collaboration, Document, Documents, DocumentStorage } from "@jpowersdev/effect-documents"
import { Console, Effect, Layer, Option, Stream } from "effect"
import { SecureRandom } from "effect/crypto"

const id = Document.Id.make("spec")
const agent: Actor.Actor = { by: Actor.Id.make("@agent"), via: Option.none() }

const join = (user: string) =>
  Effect.gen(function*() {
    const text = yield* ReplicatedText.makeConfirmed({ document: Replica.DocumentId.make(id) }).pipe(
      Effect.provideService(Sync.CurrentUser, user)
    )
    yield* text.connection.status.pipe(Stream.filter((status) => status._tag === "Synced"), Stream.runHead)
    return text
  })

const saved = (text: ReplicatedText.Confirmed) =>
  text.connection.unconfirmed.pipe(Stream.filter((count) => count === 0), Stream.runHead)

const program = Effect.gen(function*() {
  const documents = yield* Documents.Documents
  yield* documents.create({ id, actor: agent, title: "Spec", body: "Sessions last 24 hours." })

  const ada = yield* join("@ada")
  const ben = yield* join("@ben")
  yield* ReplicatedText.insert(ada, 0, "Draft: ")
  yield* ReplicatedText.insert(ben, 0, "Ben here. ")
  yield* Effect.all([saved(ada), saved(ben)])

  // No version: the agent's edit applies to whatever the text is now, and fails
  // only if "24" has gone.
  const edited = yield* documents.apply({
    id,
    actor: agent,
    command: { _tag: "Edit", oldString: "24", newString: "8" }
  })
  yield* Console.log(edited.body)

  // [ "Create by @agent", "Merge by @ada, @ben", "Edit by @agent" ]
  const history = yield* documents.history(id)
  yield* Console.log(history.map(({ action, actors }) => `${action} by ${actors.map(({ by }) => by).join(", ")}`))
})

const Live = Collaboration.layer().pipe(
  Layer.provideMerge(DocumentStorage.layerMemory),
  Layer.provideMerge(SecureRandom.layerWebCrypto)
)
NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(Live)))
