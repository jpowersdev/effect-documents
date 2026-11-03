---
"@jpowersdev/effect-documents": patch
---

`SqlDocumentStorage` can create its tables from several processes at once on PostgreSQL. Starting together used to fail with a duplicate key error.
