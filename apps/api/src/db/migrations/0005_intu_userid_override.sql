-- Phase 23 item 17 — admin override of the synthetic INTU.USERID
-- emitted in QFX exports. When NULL we derive a deterministic value
-- from accounts.id ('VTC' + UUID without dashes). When set, the value
-- is emitted verbatim so operators can match Quicken's existing record.

ALTER TABLE vibetc.accounts
  ADD COLUMN IF NOT EXISTS intu_userid_override text;
