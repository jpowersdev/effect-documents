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

  it("replaceAt keeps what the old and new text have in common at each match", () => {
    const before = "a old b old c"
    const patch = InternalPatch.replaceAt(InternalPatch.occurrences(before, "old"), "old", "older")
    assert.strictEqual(TextPatch.apply(patch, before), "a older b older c")
    assert.isFalse(patch.some((op) => op._tag === "Remove"))
  })

  it("between keeps every unchanged line, not only a common start and end", () => {
    const patch = InternalPatch.between("one\nkeep\nthree\n", "1\nkeep\n3\n")
    assert.strictEqual(retained(patch), "keep\n".length + "\n".length * 2)
  })

  it("replaceAt keeps the text between matches", () => {
    const before = "old keep old"
    const patch = InternalPatch.replaceAt(InternalPatch.occurrences(before, "old"), "old", "new")
    assert.strictEqual(TextPatch.apply(patch, before), "new keep new")
    assert.strictEqual(retained(patch), " keep ".length)
  })

  describe("followed", () => {
    const after = (before: string, next: string, start: number, end: number) => {
      const moved = InternalPatch.followed(InternalPatch.between(before, next), { start, end })
      return { text: next.slice(moved.start, moved.end), replaced: moved.replaced }
    }

    it("takes in what replaced the whole of a passage", () => {
      assert.deepStrictEqual(after("Sessions last 24 hours.", "Sessions last one day.", 14, 22), {
        text: "one day",
        replaced: true
      })
    })

    it("takes in what replaced either end of one", () => {
      assert.deepStrictEqual(after("Sessions last 24 hours.", "Sessions last 8 hours.", 14, 22), {
        text: "8 hours",
        replaced: true
      })
      assert.deepStrictEqual(after("Sessions last 24 hour.", "Sessions last 24 day.", 14, 21), {
        text: "24 day",
        replaced: true
      })
    })

    it("moves with what's kept when text changes elsewhere", () => {
      assert.deepStrictEqual(after("one\nkeep\nthree\n", "1\nkeep\n3\n", 4, 8), { text: "keep", replaced: false })
    })

    it("leaves out text inserted at an edge with nothing removed", () => {
      assert.deepStrictEqual(after("ab cd ef", "ab xcd ef", 3, 5), { text: "cd", replaced: false })
    })

    it("has nothing to follow when a passage is only deleted", () => {
      assert.deepStrictEqual(after("ab cd ef", "ab  ef", 3, 5), { text: "", replaced: false })
    })

    it.prop("stays within the text, in order", [text, text], ([a, b]) => {
      const before = a.join("")
      const next = b.join("")
      if (before.length === 0) return
      const moved = InternalPatch.followed(InternalPatch.between(before, next), { start: 0, end: before.length })
      assert.isTrue(moved.start >= 0 && moved.end <= next.length && moved.start <= moved.end)
    })
  })
})
