import { PostgreSqlContainer } from "@testcontainers/postgresql"
import type { TestProject } from "vitest/node"

declare module "vitest" {
  export interface ProvidedContext {
    readonly postgresUrl: string
  }
}

/** One real PostgreSQL server for the whole run. Each test makes its own database on it. */
export default (project: TestProject) =>
  new PostgreSqlContainer("postgres:17-alpine")
    // Nothing here needs to survive a crash of the machine.
    .withCommand(["postgres", "-c", "fsync=off"])
    .start()
    .then((container) => {
      project.provide("postgresUrl", container.getConnectionUri())
      return () => container.stop().then(() => undefined)
    })
