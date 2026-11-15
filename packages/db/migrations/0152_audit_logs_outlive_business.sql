-- A business's audit log outlives the business (docs/features/business-deletion.md).
-- Deleting a business used to delete its audit rows with it, through the
-- foreign key's ON DELETE CASCADE, so nothing was left to show what its team
-- had done or who deleted it. The foreign key goes. Each row keeps the
-- business ID it was written with, unchanged, and deleteBusiness writes a
-- last business.deleted row naming the business and who deleted it, so one
-- business_id finds the whole history.
--
-- Row-level security still binds each row to its business, and nobody is a
-- member of a deleted business, so the dashboard and the API never show these
-- rows again. The deployment's operator reads them signed in to the database
-- as postgres. Nothing else changes: business_id stays NOT NULL, inserts still
-- need the transaction's own business, and a release from before this
-- migration runs on the database as it did, except that the business it
-- deletes leaves its audit rows behind.

SET LOCAL lock_timeout = '5s';

-- Dropped by what it is rather than by name, so a database whose constraint
-- has another name loses it too.
DO $$
DECLARE
  foreign_key text;
BEGIN
  FOR foreign_key IN
    SELECT con.conname
    FROM pg_catalog.pg_constraint con
    WHERE con.conrelid = 'public.audit_logs'::regclass
      AND con.confrelid = 'public.businesses'::regclass
      AND con.contype = 'f'
  LOOP
    EXECUTE format('ALTER TABLE public.audit_logs DROP CONSTRAINT %I', foreign_key);
  END LOOP;
END
$$;
