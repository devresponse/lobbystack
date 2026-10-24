-- Polar keeps one customer per email. A person who pays for two businesses
-- gives the second its own billing email, which the worker makes that
-- business's Polar customer with.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.billing_checkout_requests
  ADD COLUMN IF NOT EXISTS billing_email varchar(320);

COMMENT ON COLUMN public.billing_checkout_requests.billing_email IS 'The email the business''s new Polar customer gets instead of the requester''s, which another customer has.';
