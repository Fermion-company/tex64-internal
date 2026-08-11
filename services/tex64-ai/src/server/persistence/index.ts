import type { DocumentRepository } from "./types";
import { LocalDocumentRepository } from "./local-repository";
import { PostgresDocumentRepository } from "./postgres-repository";

export * from "./types";
export * from "./limits";
export * from "./pagination";

const repositoryGlobal = globalThis as typeof globalThis & {
  __tex64DocumentRepository?: DocumentRepository;
};

export function getDocumentRepository(): DocumentRepository {
  if (process.env.NODE_ENV === "production" && !process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required in production.");
  }
  repositoryGlobal.__tex64DocumentRepository ??= process.env.DATABASE_URL
    ? new PostgresDocumentRepository()
    : new LocalDocumentRepository();
  return repositoryGlobal.__tex64DocumentRepository;
}
