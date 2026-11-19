CREATE FUNCTION validate_referral_attribution_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_code text;
BEGIN
  SELECT invite_code INTO expected_code
  FROM referral_profiles WHERE user_id = NEW.inviter_user_id;
  IF expected_code IS NULL OR expected_code <> NEW.invite_code THEN
    RAISE EXCEPTION 'referral inviter and invite code do not match';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER referral_attribution_validate_insert
BEFORE INSERT ON referral_attributions
FOR EACH ROW EXECUTE FUNCTION validate_referral_attribution_insert();
--> statement-breakpoint
CREATE FUNCTION prevent_referral_invite_code_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.invite_code IS DISTINCT FROM OLD.invite_code THEN
    RAISE EXCEPTION 'referral invite code is immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER referral_profile_code_no_update
BEFORE UPDATE OF invite_code ON referral_profiles
FOR EACH ROW EXECUTE FUNCTION prevent_referral_invite_code_update();
