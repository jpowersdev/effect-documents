---
title: "Limits"
description: "What this library doesn't do, and what costs more than you might expect."
sidebar:
  order: 7
---

- **One writer process per document**, such as one Durable Object per document. Compare-and-append protects revisions
  from a second process, but not clients from each other.
- **Plain text.** The body is one string. Formatting and undo aren't built.
- **Memory.** An open document holds its text's tree twice on the server, and character history is never pruned.
- **A write per push.** Each acknowledged push writes a staged row. Clients send what gathered while the last push was
  out, so a slow store gets fewer, larger writes.
- **A removed document's id** can't be reused until a minute after its last client has gone.
- **Live editing on PostgreSQL** is untested, and racing writers there are tested only on PGlite, which has one
  connection.
