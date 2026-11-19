-- 邀请码太长（SF + 32 位十六进制，34 个字符），印刷、口述、手输都不现实。
-- 新码直接是「8 位大写字母数字」，字母表去掉了容易看错的 I / O / 0 / 1，
-- 32^8 ≈ 1.1e12 种组合；真撞上了循环还会重抽（下面最多试 8 次）。
-- 已经发出去的旧码保持原样：那一列有不可变触发器，换码会把别人手里的链接弄断。
CREATE OR REPLACE FUNCTION create_referral_profile() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  alphabet CONSTANT text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  candidate text;
  attempt integer := 0;
BEGIN
  LOOP
    attempt := attempt + 1;
    SELECT string_agg(substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1), '')
      INTO candidate
      FROM generate_series(1, 8);
    EXIT WHEN NOT EXISTS (SELECT 1 FROM referral_profiles WHERE invite_code = candidate);
    IF attempt >= 8 THEN
      RAISE EXCEPTION 'could not allocate a unique invite code';
    END IF;
  END LOOP;

  INSERT INTO referral_profiles (user_id, invite_code)
  VALUES (NEW.id, candidate)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;
