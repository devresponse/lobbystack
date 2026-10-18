-- The call that verified a caller for an appointment change. A keypad PIN
-- accepted on a call counts again only on that same call: it used to count
-- for any call from the caller's number until the verification expired, so
-- anyone calling from that number, a spoofed one included, could cancel or
-- reschedule without the PIN. Verifications made before this have no call,
-- so their PIN never counts again.
ALTER TABLE public.appointment_change_verifications ADD COLUMN IF NOT EXISTS call_id uuid REFERENCES public.calls(id) ON DELETE SET NULL;
