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
 * Replaces `oldString` at each of `positions`, keeping every character between them,
 * and what `oldString` and `replacement` have in common at their start and end, and
 * so the anchors on those characters. A diff of the whole string would replace the
 * span from the first match to the last.
 *
 * @internal
 */
export const replaceAt = (
  positions: ReadonlyArray<number>,
  oldString: string,
  replacement: string
): TextPatch.TextPatch => {
  const hunk = TextPatch.get(oldString, replacement)
  const consumed = hunk.reduce((total, op) => op._tag === "Insert" ? total : total + op.length, 0)
  const patch: Array<TextPatch.TextPatchOperation> = []
  let cursor = 0
  for (const position of positions) {
    if (position > cursor) patch.push({ _tag: "Retain", length: position - cursor })
    patch.push(...hunk)
    // A patch leaves what it keeps at the end implicit, but more may follow this one.
    if (consumed < oldString.length) patch.push({ _tag: "Retain", length: oldString.length - consumed })
    cursor = position + oldString.length
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

/**
 * Where a passage is after a patch, and whether what's at either end of it was
 * replaced, rather than kept or only deleted. Text inserted at an edge with
 * nothing removed stays outside, as anchors lean inward. Where an end was
 * replaced, the passage takes in what replaced it.
 *
 * @internal
 */
export const followed = (
  patch: TextPatch.TextPatch,
  range: { readonly start: number; readonly end: number }
): { readonly start: number; readonly end: number; readonly replaced: boolean } => {
  let before = 0
  let after = 0
  let start: number | undefined
  let end: number | undefined
  let replaced = false
  for (let index = 0; index < patch.length;) {
    const op = patch[index]!
    if (op._tag === "Retain") {
      if (start === undefined && range.start < before + op.length) start = after + range.start - before
      if (end === undefined && range.end - 1 < before + op.length) end = after + range.end - before
      before += op.length
      after += op.length
      index++
      continue
    }
    // Everything up to the next kept text is one replacement
    let inserted = 0
    let removed = 0
    for (; index < patch.length && patch[index]!._tag !== "Retain"; index++) {
      const hunk = patch[index]!
      if (hunk._tag === "Insert") inserted += hunk.text.length
      else if (hunk._tag === "Remove") removed += hunk.length
    }
    if (removed > 0) {
      if (start === undefined && range.start < before + removed) {
        start = after
        if (inserted > 0) replaced = true
      }
      if (end === undefined && range.end - 1 < before + removed) {
        end = after + inserted
        if (inserted > 0) replaced = true
      }
    }
    before += removed
    after += inserted
  }
  return {
    start: start ?? after + range.start - before,
    end: end ?? after + range.end - before,
    replaced
  }
}
