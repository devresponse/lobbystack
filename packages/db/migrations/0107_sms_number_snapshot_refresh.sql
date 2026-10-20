-- A cloud business with its own number now texts from it, where it used to
-- text only from the shared sender, and a business with a replaced number
-- texts from the new one. The receptionist's snapshot names the number texts
-- come from, and offers texts on calls only while it names one, so this queues
-- one refresh for each business whose newest snapshot names a different
-- number from its own. Running this file again queues nothing new.
--
-- Queuing for every business needs a role that sees every row, like 0101.
DO $$
DECLARE
  queued integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE NOTICE 'Skipping the SMS number snapshot refresh: % is subject to row-level security.', current_user;
    RETURN;
  END IF;

  INSERT INTO public.outbox_messages (topic, payload, business_id, aggregate_type, aggregate_id, dedupe_key)
  SELECT
    'snapshot.refresh',
    jsonb_build_object('businessId', b.id, 'reason', 'sms_number_backfill'),
    b.id,
    'business',
    b.id,
    'business:' || b.id || ':snapshot:sms-number-backfill'
  FROM public.businesses b
  -- The business's own number for texts, picked as businessSmsNumber picks it.
  CROSS JOIN LATERAL (
    SELECT n.e164 FROM public.phone_numbers n
    WHERE n.business_id = b.id AND n.status = 'active' AND n.sms_enabled
    ORDER BY n.reclaim_scheduled_at IS NOT NULL, n.created_at DESC, n.id ASC
    LIMIT 1
  ) own
  WHERE own.e164 IS DISTINCT FROM (
    SELECT s.snapshot -> 'contactChannels' ->> 'smsNumber' FROM public.business_context_snapshots s
    WHERE s.business_id = b.id
    ORDER BY s.generated_at DESC
    LIMIT 1
  )
  ON CONFLICT (dedupe_key) DO NOTHING;
  GET DIAGNOSTICS queued = ROW_COUNT;

  RAISE NOTICE 'Business snapshots: % refreshes queued for SMS numbers.', queued;
END
$$;
