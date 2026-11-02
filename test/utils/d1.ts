import { D1Client } from "@effect/sql-d1"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Miniflare } from "miniflare"

/** A real D1 database, in the workerd runtime, gone when the layer is released. */
export const layerD1 = Layer.unwrap(
  Effect.gen(function*() {
    const miniflare = yield* Effect.acquireRelease(
      Effect.sync(() =>
        new Miniflare({
          workers: [{
            config: {
              name: "test",
              compatibilityDate: "2026-08-30",
              manifest: {
                mainModule: "index.mjs",
                modules: { "index.mjs": { type: "esm", contents: "export default {}" } }
              },
              env: { DB: { type: "d1", id: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" } }
            }
          }]
        })
      ),
      (miniflare) => Effect.promise(() => miniflare.dispose())
    )
    const db = yield* Effect.promise(() => miniflare.getD1Database("DB"))
    return D1Client.layer({ db })
  })
)
