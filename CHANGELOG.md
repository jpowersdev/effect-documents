# @jpowersdev/effect-documents

## 0.2.0

### Minor Changes

- [#2](https://github.com/jpowersdev/effect-documents/pull/2) [`cca619c`](https://github.com/jpowersdev/effect-documents/commit/cca619c3526829e4cf1140c7a26cd23b64580fc3) Thanks [@jpowersdev](https://github.com/jpowersdev)! - Discussions stay on their passages, and updates can merge.
  
  - When an edit replaces either end of a discussion's passage, through a command or typed in a live session, the discussion follows to what replaced it. Before, replacing a whole passage lost its place, and replacing one end left it on what remained. Only deleting every character with nothing in its place loses it now.
  - `Edit` keeps what its old and new text share at their start and end, so anchors on those characters survive and people typing nearby aren't disturbed.
  - `Update` takes `merge`. On a stale version it brings what it changed from that version into the current text, as a concurrent edit would, and fails with the new `MergeOverlaps` if that text has changed since.

## 0.1.1

### Patch Changes

- [`4a7efa6`](https://github.com/jpowersdev/effect-documents/commit/4a7efa66fdd7bde224889d412a4909dc432f5517) Thanks [@jpowersdev](https://github.com/jpowersdev)! - `SqlDocumentStorage` can create its tables from several processes at once on PostgreSQL. Starting together used to fail with a duplicate key error.
