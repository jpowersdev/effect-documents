---
title: "Commands"
description: "Everything that changes a document, and how each one can fail."
sidebar:
  order: 1
---

Every successful command appends one attributed revision. A rejected, failed or interrupted one leaves content and
history unchanged, and invalid input fails with a `SchemaError`.

| Command   | What it does                                               | Names a version | Fails with                                                  |
| --------- | ---------------------------------------------------------- | --------------- | ----------------------------------------------------------- |
| `Edit`    | Replaces exact, literal text; `replaceAll` for every match | No              | `OldStringNotFound`, `AmbiguousOldString`, `Unchanged`      |
| `Update`  | Replaces the title, the body or both                       | Yes             | `Conflict`, `Unchanged`, `MergeOverlaps` with `merge`       |
| `Restore` | Copies an earlier title and body into a new revision       | Yes             | `Conflict`                                                  |
| `Open`    | Starts a discussion on an exact quote at a UTF-16 offset   | No              | `QuoteChanged`, `ThreadAlreadyExists`                       |
| `Reply`   | Adds to a discussion, and reopens it if it was resolved    | No              | `ThreadNotFound`                                            |
| `Resolve` | Closes a discussion                                        | Yes             | `Conflict` if the discussion has moved on, `ThreadNotFound` |
| `Reopen`  | Opens a resolved discussion again                          | No              | `ThreadNotFound`                                            |

An edit that would split a surrogate pair fails with `SplitsSurrogatePair`.

## Versions

`Update` and `Restore` fail on a stale version, because they could undo work their caller never saw. `Resolve` fails only
over a reply its caller hasn't seen. Other commands apply to the current text.

`Update` with `merge` doesn't fail on a stale version unless it has to. It brings what it changed from the version it names
into the current text, as a concurrent edit would, so someone else's work stands. If text it changed has changed since, it
fails with `MergeOverlaps`, naming those passages, and changes nothing. A title is one value: a new one replaces whatever
is there, and leaving it alone doesn't undo a change since.

```ts import.meta.vitest
import {
  Actor,
  Document,
  Documents,
  DocumentStorage
} from "@jpowersdev/effect-documents"
import { Effect, Layer, Option } from "effect"

const program = Effect.gen(function*() {
  const documents = yield* Documents.Documents
  const actor: Actor.Actor = {
    by: Actor.Id.make("@owner"),
    via: Option.none()
  }
  const id = Document.Id.make("spec")

  const first = yield* documents.create({
    id,
    actor,
    title: "Spec",
    body: "Sessions last 24 hours."
  })
  yield* documents.apply({
    id,
    actor,
    command: {
      _tag: "Edit",
      oldString: "24",
      newString: "8"
    }
  })

  // Named a version that's no longer current
  const result = yield* documents.apply({
    id,
    actor,
    command: {
      _tag: "Update",
      version: first.version,
      body: "Sessions never end."
    }
  }).pipe(
    Effect.map(() => "Updated"),
    Effect.catchReason(
      "DocumentStorageError",
      "Conflict",
      () => Effect.succeed("Someone else got there first")
    )
  )
  yield* Effect.log(result)
})

const DocumentsLive = Documents.layer.pipe(Layer.provide(DocumentStorage.layerMemory))

await Effect.runPromise(program.pipe(Effect.provide(DocumentsLive)))
```

## Discuss a passage

`Open` anchors a discussion to its original characters. `Edit` keeps the characters between matches and what its old and new
text share at their start and end, and `Update` diffs by line and keeps the common start and end of each changed region, so
anchors on unchanged text survive.

When an edit replaces either end of a passage, however it's made, the discussion follows to what replaced it, so a passage
reworded by a command or retyped in a live session keeps its discussion, narrowed to the passage's own words if they're still
there. A very large change becomes one replacement, which
the discussions inside it then cover whole. The quote stays what was first quoted.

When every anchored character is deleted and nothing replaces them, the range becomes `None`, and the quote and discussion
remain. `Restore` doesn't bring back anchors that went that way.

```ts import.meta.vitest
import {
  Actor,
  Document,
  Documents,
  DocumentStorage,
  Thread
} from "@jpowersdev/effect-documents"
import { Effect, Layer, Option } from "effect"

const program = Effect.gen(function*() {
  const documents = yield* Documents.Documents
  const actor: Actor.Actor = {
    by: Actor.Id.make("@owner"),
    via: Option.none()
  }
  const id = Document.Id.make("performance-map")
  const thread = Thread.Id.make("measurement")

  yield* documents.create({
    id,
    actor,
    title: "Performance map",
    body: "Clicks take 40 ms."
  })
  yield* documents.apply({
    id,
    actor,
    command: {
      _tag: "Open",
      thread,
      start: 12,
      quote: "40 ms",
      body: "Which browser?"
    }
  })

  // The anchor follows its characters as the text moves around them
  const edited = yield* documents.apply({
    id,
    actor,
    command: {
      _tag: "Edit",
      oldString: "Clicks take",
      newString: "On Chromium, clicks take"
    }
  })
  const range = Option.getOrThrow(edited.threads[0]!.range)
  yield* Effect.log(edited.body.slice(range.start, range.end))
})

const DocumentsLive = Documents.layer.pipe(Layer.provide(DocumentStorage.layerMemory))

await Effect.runPromise(program.pipe(Effect.provide(DocumentsLive)))
```

## Attribution

`actors` starts with the person, and optionally the agent harness, model and session, that ran the command. `note` defaults
to `""`, and timestamps come from Effect's clock.

## Read a document

`read(id)` returns the current version, and `read(id, { version })` a historical one. `history(id)` returns every entry,
oldest first, without content. `remove(id)` deletes a document and its whole history, leaving no trace.
