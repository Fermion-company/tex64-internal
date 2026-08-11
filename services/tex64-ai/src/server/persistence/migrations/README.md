# Persistence migrations

Apply every numbered SQL file once, in order, with a schema-owner migration role.
For example:

```sh
for migration in src/server/persistence/migrations/[0-9]*.sql; do
  psql "$DATABASE_URL" --set ON_ERROR_STOP=1 --file "$migration"
done
```

The application connection must use a separate, least-privileged role without
`SUPERUSER` or `BYPASSRLS`. Runtime code intentionally performs no schema DDL.
Grant that role only the operation-specific privileges required on each
`public.tex64_*` table and sequence privileges if future migrations add
identity columns. Only grant bounded expiry-cleanup `DELETE` where the runtime
performs that cleanup. The shared rate-limit
tables contain only HMAC digests and counters; never persist raw client IPs.

`public.tex64_source_records` is an immutable evidence ledger. Grant the
application role only `SELECT` and `INSERT` on that table; its migration also
rejects row updates. Repository writes serialize per user/document, retain the
first row for each canonical locator, and enforce at most 100 source snapshots
and 20 MiB of UTF-8 evidence content per document.

`public.tex64_research_ledgers` stores immutable, digest-bound independent
evidence decisions for an exact document revision, plan, and source snapshot.
Grant the application role only `SELECT` and `INSERT`; updates are rejected by
the migration trigger and tenant isolation is enforced with forced RLS.

Completed runs created before `0009_artifact_release_binding.sql` intentionally
remain unpublished. A PDF is public to its owner only after a later run binds
its exact storage key, SHA-256 digest, byte size, page count, and quality version.
