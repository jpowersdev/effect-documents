---
"@jpowersdev/effect-documents": minor
---

Discussions stay on their passages, and updates can merge.

- When an edit replaces either end of a discussion's passage, through a command or typed in a live session, the discussion follows to what replaced it. Before, replacing a whole passage lost its place, and replacing one end left it on what remained. Only deleting every character with nothing in its place loses it now.
- `Edit` keeps what its old and new text share at their start and end, so anchors on those characters survive and people typing nearby aren't disturbed.
- `Update` takes `merge`. On a stale version it brings what it changed from that version into the current text, as a concurrent edit would, and fails with the new `MergeOverlaps` if that text has changed since.
