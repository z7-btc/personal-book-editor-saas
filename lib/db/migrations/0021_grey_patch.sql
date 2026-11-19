-- The payout account of a terminal withdrawal is removed by the retention
-- scrub (lib/jobs/maintenance.ts). The request, its amount, its status and its
-- provider id are financial facts and stay; only the encrypted payload becomes
-- null, which is also what stops the dispatch worker from claiming the row
-- again (lib/referrals/withdrawal-worker.ts).
ALTER TABLE "referral_withdrawal_intents" ALTER COLUMN "account_ciphertext" DROP NOT NULL;
