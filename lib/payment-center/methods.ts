/**
 * The one channel rule the host still has to enforce itself.
 *
 * Payment methods are no longer a local list: the Payment Center catalogue
 * publishes a capability card for every enabled channel and this application
 * follows it (see `catalog.ts`). What the remote catalogue cannot know is that
 * this deployment's card checkout cannot charge a crypto-denominated price.
 * Keep `CRYPTO_ASSETS` in step with
 * `payment-center/app/utils/validators.py` (`supported_currencies`).
 */

/** Assets a crypto channel may transfer (`payment-center/app/utils/validators.py`). */
export const CRYPTO_ASSETS = ['USDT', 'USDC', 'BUSD', 'DAI'] as const;

export function isCryptoAsset(currency: string): boolean {
  return (CRYPTO_ASSETS as readonly string[]).includes(currency.trim().toUpperCase());
}
