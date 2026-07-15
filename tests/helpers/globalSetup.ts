/**
 * Starts one throwaway Postgres 16 container for the whole test run
 * (Testcontainers), unless TEST_DATABASE_URL points at an existing Postgres —
 * then that is used instead (e.g. a compose-managed test database in CI).
 */
import type { TestProject } from 'vitest/node';

let stop: (() => Promise<unknown>) | undefined;

export default async function setup(project: TestProject): Promise<void> {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const container = await new PostgreSqlContainer('postgres:16-alpine').start();
    stop = () => container.stop();
    url = container.getConnectionUri();
  }
  project.provide('adminDatabaseUrl', url);
}

export async function teardown(): Promise<void> {
  await stop?.();
}

declare module 'vitest' {
  export interface ProvidedContext {
    adminDatabaseUrl: string;
  }
}
