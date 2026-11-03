import { assert, describe, it } from "@effect/vitest"
import { TextPatch } from "@jpowersdev/effect-delta"
import * as Schema from "effect/Schema"
import * as InternalPatch from "../src/internal/patch.ts"

// Few distinct tokens, so generated texts share lines and prefixes worth keeping.
const text = Schema.Array(Schema.Literals(["a", "b", "\n", "\r\n", "😀", "same line\n"]))

const retained = (patch: TextPatch.TextPatch) =>
  patch.reduce((total, op) => op._tag === "Retain" ? total + op.length : total, 0)

describe("internal/patch", () => {
  it.prop("between always gives exactly the new text", [text, text], ([a, b]) => {
    const before = a.join("")
    const after = b.join("")
    assert.strictEqual(TextPatch.apply(InternalPatch.between(before, after), before), after)
  })

  it("between keeps every unchanged line, not only a common start and end", () => {
    const patch = InternalPatch.between("one\nkeep\nthree\n", "1\nkeep\n3\n")
    assert.strictEqual(retained(patch), "keep\n".length + "\n".length * 2)
  })

  it("replaceAt keeps the text between matches", () => {
    const before = "old keep old"
    const patch = InternalPatch.replaceAt(InternalPatch.occurrences(before, "old"), 3, "new")
    assert.strictEqual(TextPatch.apply(patch, before), "new keep new")
    assert.strictEqual(retained(patch), " keep ".length)
  })
})
