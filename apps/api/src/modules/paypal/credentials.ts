// Where the gateway gets each merchant's PayPal REST credentials. Onboarding (#54) will store them
// encrypted in `merchants`; until then one sandbox app from the environment serves every merchant.

export interface PayPalCredentials {
  clientId: string;
  clientSecret: string;
}

export interface CredentialSource {
  forMerchant(merchantId: string): Promise<PayPalCredentials>;
}

/**
 * The key `/status` checks the platform's own sandbox app under. It has to be a valid id, because
 * `db.forMerchant` parses it, and no merchant has the nil UUID, so a DbCredentialSource finds no
 * stored app and falls back to PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET.
 */
export const PLATFORM_APP_ID = "00000000-0000-0000-0000-000000000000";

/** One app for all merchants:PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (or the mock's credentials). */
export function singleAppCredentials(credentials: PayPalCredentials): CredentialSource {
  return { forMerchant: () => Promise.resolve(credentials) };
}

/** paypal-mock's Pantry Plan app (see its README): not secrets, and only used against the mock. */
export const MOCK_CREDENTIALS: PayPalCredentials = {
  clientId: "pantry-plan-mock-client",
  clientSecret: "mock-secret",
};
