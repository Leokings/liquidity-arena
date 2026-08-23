\set ON_ERROR_STOP on

BEGIN;

CREATE TEMP TABLE arena_keeper_operations (
  operation_id text PRIMARY KEY,
  state text NOT NULL,
  transaction_hash text,
  CONSTRAINT arena_keeper_operations_check3 CHECK (
    state IN ('PREPARED', 'STATE_SATISFIED_UNPROVEN', 'QUARANTINED')
    OR transaction_hash IS NOT NULL
  )
);

INSERT INTO arena_keeper_operations (operation_id, state, transaction_hash)
VALUES ('legacy-prehash-regression', 'PREPARED', NULL);

DO $regression$
BEGIN
  BEGIN
    UPDATE arena_keeper_operations
       SET state = 'ABANDONED_PREHASH'
     WHERE operation_id = 'legacy-prehash-regression';
    RAISE EXCEPTION 'legacy constraint did not reject ABANDONED_PREHASH';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END
$regression$;

ALTER TABLE arena_keeper_operations
  DROP CONSTRAINT arena_keeper_operations_check3;

UPDATE arena_keeper_operations
   SET state = 'ABANDONED_PREHASH'
 WHERE operation_id = 'legacy-prehash-regression';

DO $regression$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM arena_keeper_operations
     WHERE operation_id = 'legacy-prehash-regression'
       AND state = 'ABANDONED_PREHASH'
       AND transaction_hash IS NULL
  ) THEN
    RAISE EXCEPTION 'migration 008 did not admit hashless ABANDONED_PREHASH';
  END IF;
END
$regression$;

ROLLBACK;
