-- The receptionist's snapshot names the number it gives out, and the website
-- widget offers calls from the browser only while it names one. Getting or
-- releasing a number didn't refresh the snapshot, so a business that got its
-- number after its last refresh had no call button in its widget. Both now
-- refresh it; this queues one refresh for each business whose newest snapshot
-- names a different number from the one it has now. Running this file again
-- queues nothing new.
--
-- Queuing for every business needs a role that sees every row, like 0085.
DO $$
DECLARE
  queued integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE NOTICE 'Skipping the phone number snapshot refresh: % is subject to row-level security.', current_user;
    RETURN;
  END IF;

  INSERT INTO public.outbox_messages (topic, payload, business_id, aggregate_type, aggregate_id, dedupe_key)
  SELECT
    'snapshot.refresh',
    jsonb_build_object('businessId', b.id, 'reason', 'phone_number_backfill'),
    b.id,
    'business',
    b.id,
    'business:' || b.id || ':snapshot:phone-number-backfill'
  FROM public.businesses b
  -- The number the snapshot would name, picked as the snapshot picks it.
  WHERE (
    SELECT n.e164 FROM public.phone_numbers n
    WHERE n.business_id = b.id AND n.status = 'active' AND n.voice_enabled
    ORDER BY n.created_at DESC, n.id ASC
    LIMIT 1
  ) IS DISTINCT FROM (
    SELECT s.snapshot -> 'contactChannels' ->> 'phoneNumber' FROM public.business_context_snapshots s
    WHERE s.business_id = b.id
    ORDER BY s.generated_at DESC
    LIMIT 1
  )
  ON CONFLICT (dedupe_key) DO NOTHING;
  GET DIAGNOSTICS queued = ROW_COUNT;

  RAISE NOTICE 'Business snapshots: % refreshes queued for phone numbers.', queued;
END
$$;
