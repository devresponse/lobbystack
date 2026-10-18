-- Records which platform key made a webhook endpoint or an account. Platform
-- keys live in PLATFORM_API_KEYS, not in rows, so neither column has a foreign
-- key, as in platform_partner_businesses. A handover turns off the endpoints a
-- partner set up, since the partner loses the business, and an account made
-- through POST /users can be traced to the key and partner that asked for it.
ALTER TABLE public.webhook_endpoints
  ADD COLUMN IF NOT EXISTS created_by_platform_key_id uuid,
  ADD COLUMN IF NOT EXISTS created_by_partner_id varchar(40);

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS created_by_platform_key_id uuid,
  ADD COLUMN IF NOT EXISTS created_by_partner_id varchar(40);

-- Endpoints made before this recorded their platform key only in the audit
-- row written with them. Copy it over. Running this file again changes nothing.
--
-- Reading every business's rows needs a role that sees them all, like 0101.
DO $$
DECLARE
  recorded integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE NOTICE 'Skipping the webhook endpoint platform key backfill: % is subject to row-level security.', current_user;
    RETURN;
  END IF;

  UPDATE public.webhook_endpoints endpoint
  SET created_by_platform_key_id = (audit.payload ->> 'platformKeyId')::uuid,
      created_by_partner_id = left(audit.payload ->> 'partnerId', 40)
  FROM public.audit_logs audit
  WHERE audit.business_id = endpoint.business_id
    AND audit.entity_type = 'webhook_endpoint'
    AND audit.entity_id = endpoint.id
    AND audit.event_type = 'webhook_endpoint.created'
    AND audit.payload ->> 'actor' = 'platform_key'
    AND audit.payload ->> 'platformKeyId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND endpoint.created_by_platform_key_id IS NULL;
  GET DIAGNOSTICS recorded = ROW_COUNT;

  RAISE NOTICE 'Webhook endpoints: % platform keys recorded.', recorded;
END
$$;
