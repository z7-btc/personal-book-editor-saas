-- 0026 只换了「发号机器」，存量账号还挂着 SF + 32 位的老码（34 个字符，
-- 在返佣页上折成三行）。这一版把存量也统一换成 8 位。
--
-- 这一步要临时拆掉 0015 装的「邀请码不可变」触发器：它日常是护栏，
-- 防止误改已经发出去的码；这里是唯一一次有意的批量换号。ALTER TABLE 是
-- 事务性的，所以哪怕下面中途报错回滚，触发器也会跟着回来，不会留在关闭状态。
--
-- 旧码换掉后，已经散出去的旧邀请链接会失效——这是 2026-10-23 明确接受的
-- 代价（站点用户还少，早换损失小）。attributions 里的 invite_code 保持原样：
-- 那一列记的是「当初用哪个码绑上的」，是历史事实，不参与任何判定
-- （worker 现在按 inviter_user_id 认人，claimInvite 也只比邀请人）。
ALTER TABLE referral_profiles DISABLE TRIGGER referral_profile_code_no_update;
--> statement-breakpoint

DO $$
DECLARE
  alphabet CONSTANT text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  target_user text;
  candidate text;
  attempt integer;
BEGIN
  FOR target_user IN
    SELECT user_id FROM referral_profiles
    WHERE invite_code !~ '^[0-9A-Z]{8}$'
    ORDER BY user_id
  LOOP
    attempt := 0;
    LOOP
      attempt := attempt + 1;
      SELECT string_agg(substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1), '')
        INTO candidate
        FROM generate_series(1, 8);
      -- 每行都现查一次，所以前面刚发出去的码下一代就撞不上了。
      EXIT WHEN NOT EXISTS (SELECT 1 FROM referral_profiles WHERE invite_code = candidate);
      IF attempt >= 20 THEN
        RAISE EXCEPTION 'could not allocate a unique invite code';
      END IF;
    END LOOP;
    UPDATE referral_profiles SET invite_code = candidate WHERE user_id = target_user;
  END LOOP;
END $$;
--> statement-breakpoint

ALTER TABLE referral_profiles ENABLE TRIGGER referral_profile_code_no_update;
--> statement-breakpoint

-- 0015 那条插入校验要求「attribution 里记的码 = 邀请人此刻的码」。换号之后这句话
-- 不再成立：老归因里记的是历史码，而邀请人的码已经变了，于是任何一次迟到的认领
-- 都会被这条触发器打成 500。真正要守的不变式只有一条——邀请人存在。
-- 码本身是历史记录，谁邀请谁由 inviter_user_id 说了算（票是 HMAC 签过的，伪造不了）。
CREATE OR REPLACE FUNCTION validate_referral_attribution_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM referral_profiles WHERE user_id = NEW.inviter_user_id) THEN
    RAISE EXCEPTION 'referral inviter does not exist';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- 换了码就得让收款中心知道：每个用户升一版并重新排队，同步 worker 会把新码推过去。
-- referral_profile_outbox_insert 只挂在 INSERT 上，UPDATE 不会自动排队，所以这里显式插。
WITH bumped AS (
  UPDATE referral_profiles SET sync_version = sync_version + 1
  RETURNING user_id, sync_version
)
INSERT INTO referral_user_outbox (user_id, event_version)
SELECT user_id, sync_version FROM bumped
ON CONFLICT (user_id, event_version) DO NOTHING;
