# Design

How the library keeps the guarantees in the README.

## Revisions

Each revision stores its history entry, the materialized document and only the text changes it introduced, so reading
any version decodes one record, and no record grows with the ones before it. Only commands that change the text or place
an anchor rebuild the text's history, in a private replica that a failed commit can't leak into later reads.

An append is one statement, because D1 has no transactions, only atomic batches. It fails unless the document is at the
previous version, so an atomic group it joins rolls back with it.

## Versions

`Update` and `Restore` could undo work their caller never saw, so a stale version fails. `Resolve` fails only over a
reply its caller hasn't seen, because the text changing doesn't matter to it. Other commands are worked out again from
the current text if another writer gets in first.

## Live changes

Live changes wait as staged changes until they join a revision, alongside which user each replica belongs to. A revision
and the staged changes it holds aren't committed together, because holding a change in both places does no harm.

Gathering staged changes before a command keeps the command's revision to itself, plus any change that arrives while it
runs, whose author it credits too.
