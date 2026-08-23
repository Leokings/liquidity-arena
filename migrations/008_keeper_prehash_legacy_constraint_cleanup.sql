BEGIN;

LOCK TABLE arena_schema_migrations IN EXCLUSIVE MODE;

SELECT 1 / CASE
  WHEN EXISTS (
    SELECT 1
      FROM arena_schema_migrations
     WHERE version = 7
       AND name = 'keeper_prehash_abandonment'
       AND schema_checksum = '4fa4e8103a1b3caa7022cff2ea1b4868ea6128a4f6b359cdb93a8a6320e0a8f3'
  )
  AND NOT EXISTS (
    SELECT 1 FROM arena_schema_migrations WHERE version >= 8
  )
  THEN 1
  ELSE 0
END AS keeper_prehash_legacy_constraint_cleanup_guard;

-- KEEPER_PREHASH_LEGACY_CONSTRAINT_CLEANUP_SCHEMA_DIGEST_START
-- Digest algorithm: SHA-256 of the UTF-8 bytes strictly between the START and END
-- marker lines, after normalizing CRLF to LF. The marker lines are excluded.
ALTER TABLE arena_keeper_operations
  DROP CONSTRAINT arena_keeper_operations_check3;
-- KEEPER_PREHASH_LEGACY_CONSTRAINT_CLEANUP_SCHEMA_DIGEST_END

INSERT INTO arena_schema_migrations (version, name, schema_checksum)
VALUES (
  8,
  'keeper_prehash_legacy_constraint_cleanup',
  '030604d61f54ad9f6e388f497723d7eaa7118632866574cff976dd0bd43f680a'
);

COMMIT;
