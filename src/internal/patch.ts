import * as TextPatch from "@jpowersdev/effect-delta/TextPatch"
import * as TextDiff from "effect/TextDiff"

// A whole document can come from a caller, so bound the diff's work. Past this,
// a changed region becomes one replacement: the result stays exact, and only
// anchors inside that region are lost.
const maxEdits = 5000

/** @internal */
export const occurrences = (text: string, needle: string): ReadonlyArray<number> => {
  const found: Array<number> = []
  for (
    let index = text.indexOf(needle);
    index !== -1;
    index = text.indexOf(needle, index + needle.length)
  ) found.push(index)
  return found
}

/**
 * Replaces `length` characters at each of `positions`, keeping every character
 * between them, and so the anchors on those characters. A diff of the whole
 * string would replace the span from the first match to the last.
 *
 * @internal
 */
export const replaceAt = (
  positions: ReadonlyArray<number>,
  length: number,
  replacement: string
): TextPatch.TextPatch => {
  const patch: Array<TextPatch.TextPatchOperation> = []
  let cursor = 0
  for (const position of positions) {
    if (position > cursor) patch.push({ _tag: "Retain", length: position - cursor })
    patch.push({ _tag: "Remove", length })
    if (replacement.length > 0) patch.push({ _tag: "Insert", text: replacement })
    cursor = position + length
  }
  return patch
}

/**
 * Turns `before` into `after`, keeping every unchanged line and the common start
 * and end of each changed region, and so the anchors on those characters.
 *
 * @internal
 */
export const between = (before: string, after: string): TextPatch.TextPatch => {
  const patch: Array<TextPatch.TextPatchOperation> = []
  let removed = ""
  const flush = (inserted: string) => {
    const hunk = TextPatch.get(removed, inserted)
    patch.push(...hunk)
    // A patch leaves what it keeps at the end implicit, but more follows this one.
    const consumed = hunk.reduce((total, op) => op._tag === "Insert" ? total : total + op.length, 0)
    if (consumed < removed.length) patch.push({ _tag: "Retain", length: removed.length - consumed })
    removed = ""
  }
  for (const edit of TextDiff.lines(before, after, { maxEdits })) {
    const text = edit.items.join("")
    switch (edit._tag) {
      case "Equal":
        flush("")
        patch.push({ _tag: "Retain", length: text.length })
        break
      case "Delete":
        flush("")
        removed = text
        break
      case "Insert":
        flush(text)
        break
    }
  }
  flush("")
  return patch
}
