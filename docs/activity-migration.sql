-- DRAFT ONLY. Root generates the formal table/index/check migration from
-- lib/db/activity-schema.ts, reviews it, then appends these trigger statements.
-- Do not run this document directly or change the migration journal here.
-- Every insert occurs in the same transaction as its source database fact.

CREATE FUNCTION record_account_activity_fact(
  actor_user_id text, activity_event text, activity_key text,
  activity_entity_type text, activity_entity_id text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- Old synthetic payment fixtures may reference a non-existent payer. Never
  -- let audit insertion fabricate a user or break such historical records.
  IF actor_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM "user" WHERE id = actor_user_id) THEN
    RETURN;
  END IF;
  INSERT INTO account_activity
    (user_id, event_type, source, operation_key, entity_type, entity_id)
  VALUES (actor_user_id, activity_event, 'database', activity_key,
    activity_entity_type, activity_entity_id)
  ON CONFLICT (user_id, operation_key) DO NOTHING;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION record_user_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM record_account_activity_fact(NEW.id, 'account_created',
      'user.created:' || NEW.id, 'user', NEW.id);
    RETURN NEW;
  END IF;
  IF OLD.name IS DISTINCT FROM NEW.name OR OLD.preferred_locale IS DISTINCT FROM NEW.preferred_locale
     OR OLD.locale_source IS DISTINCT FROM NEW.locale_source
     OR OLD.marketing_opt_in_requested IS DISTINCT FROM NEW.marketing_opt_in_requested THEN
    PERFORM record_account_activity_fact(NEW.id, 'account_profile_updated',
      'user.profile:' || NEW.id || ':' || txid_current()::text, 'user', NEW.id);
  END IF;
  IF OLD.email IS DISTINCT FROM NEW.email THEN
    PERFORM record_account_activity_fact(NEW.id, 'account_email_changed',
      'user.email:' || NEW.id || ':' || txid_current()::text, 'user', NEW.id);
  END IF;
  IF OLD.email_verified IS DISTINCT FROM NEW.email_verified THEN
    PERFORM record_account_activity_fact(NEW.id,
      CASE WHEN NEW.email_verified THEN 'security_email_verified' ELSE 'security_email_unverified' END,
      'user.email-verification:' || NEW.id || ':' || txid_current()::text, 'user', NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER user_activity_insert AFTER INSERT ON "user"
FOR EACH ROW EXECUTE FUNCTION record_user_activity();
--> statement-breakpoint
CREATE TRIGGER user_activity_update
AFTER UPDATE OF name, email, email_verified, preferred_locale, locale_source, marketing_opt_in_requested ON "user"
FOR EACH ROW EXECUTE FUNCTION record_user_activity();
--> statement-breakpoint
CREATE FUNCTION record_session_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Session creation also occurs during registration or verification flows.
  -- The label is deliberately "session created", never "password sign-in".
  PERFORM record_account_activity_fact(NEW.user_id, 'security_session_created',
    'session.created:' || NEW.id, 'session', NEW.id);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER session_activity_insert AFTER INSERT ON "session"
FOR EACH ROW EXECUTE FUNCTION record_session_activity();
--> statement-breakpoint
CREATE FUNCTION record_password_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provider_id = 'credential' AND OLD.password IS DISTINCT FROM NEW.password THEN
    PERFORM record_account_activity_fact(NEW.user_id, 'security_password_changed',
      'account.password:' || NEW.id || ':' || txid_current()::text, 'account', NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER account_password_activity_update AFTER UPDATE OF password ON account
FOR EACH ROW EXECUTE FUNCTION record_password_activity();
--> statement-breakpoint
CREATE FUNCTION record_checkout_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM billing_accounts b WHERE b.id = NEW.billing_account_id
    AND b.organization_id = NEW.organization_id AND b.original_payer_user_id = NEW.payer_user_id) THEN
    PERFORM record_account_activity_fact(NEW.payer_user_id, 'billing_checkout_created',
      'checkout.created:' || NEW.id, 'payment_intent', NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_intent_activity_insert AFTER INSERT ON payment_intents
FOR EACH ROW EXECUTE FUNCTION record_checkout_activity();
--> statement-breakpoint
CREATE FUNCTION record_payment_activity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE payer_id text; activity_event text;
BEGIN
  SELECT i.payer_user_id INTO payer_id FROM payment_intents i
    INNER JOIN billing_accounts b ON b.id = i.billing_account_id
    WHERE i.id = NEW.intent_id AND b.organization_id = i.organization_id
      AND b.original_payer_user_id = i.payer_user_id
      AND NEW.organization_id = i.organization_id
      AND NEW.center_order_id = i.payment_center_order_id AND NEW.currency = i.currency;
  IF payer_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    activity_event := CASE WHEN NEW.status = 'settled' THEN 'billing_payment_confirmed' ELSE 'billing_payment_reversed' END;
  ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
    activity_event := CASE WHEN NEW.status = 'settled' THEN 'billing_payment_restored' ELSE 'billing_payment_reversed' END;
  ELSE
    RETURN NEW;
  END IF;
  PERFORM record_account_activity_fact(payer_id, activity_event,
    'payment.state:' || NEW.id || ':' || activity_event || ':' || txid_current()::text,
    'payment_evidence', NEW.id);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_evidence_activity_insert AFTER INSERT ON payment_evidence
FOR EACH ROW EXECUTE FUNCTION record_payment_activity();
--> statement-breakpoint
CREATE TRIGGER payment_evidence_activity_update AFTER UPDATE OF status ON payment_evidence
FOR EACH ROW EXECUTE FUNCTION record_payment_activity();
--> statement-breakpoint
CREATE FUNCTION record_access_activity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE payer_id text; activity_event text;
BEGIN
  SELECT i.payer_user_id INTO payer_id FROM payment_evidence e
    INNER JOIN payment_intents i ON i.id = e.intent_id
    INNER JOIN billing_accounts b ON b.id = i.billing_account_id
    WHERE e.id = NEW.evidence_id AND b.organization_id = i.organization_id
      AND b.original_payer_user_id = i.payer_user_id
      AND e.organization_id = i.organization_id
      AND e.center_order_id = i.payment_center_order_id AND e.currency = i.currency
      AND NEW.organization_id = e.organization_id AND NEW.product_code = i.product_code
      AND NEW.payment_method = i.method
      AND NEW.provider_subscription_id IS NOT DISTINCT FROM e.provider_subscription_id
      AND NEW.period_start = e.service_period_start AND NEW.period_end = e.service_period_end
      AND ((NEW.status = 'active' AND e.status = 'settled') OR (NEW.status = 'reversed' AND e.status = 'reversed'));
  IF payer_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    activity_event := CASE WHEN NEW.status = 'active' THEN 'billing_access_granted' ELSE 'billing_access_revoked' END;
  ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
    activity_event := CASE WHEN NEW.status = 'active' THEN 'billing_access_restored' ELSE 'billing_access_revoked' END;
  ELSE
    RETURN NEW;
  END IF;
  PERFORM record_account_activity_fact(payer_id, activity_event,
    'access.state:' || NEW.id || ':' || activity_event || ':' || txid_current()::text,
    'subscription_grant', NEW.id);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER subscription_grant_activity_insert AFTER INSERT ON subscription_grants
FOR EACH ROW EXECUTE FUNCTION record_access_activity();
--> statement-breakpoint
CREATE TRIGGER subscription_grant_activity_update AFTER UPDATE OF status ON subscription_grants
FOR EACH ROW EXECUTE FUNCTION record_access_activity();
