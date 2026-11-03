// Where the gateway gets each merchant's PayPal REST credentials. Onboarding (#54) will store them
// encrypted in `merchants`; until then one sandbox app from the environment serves every merchant.

export interface PayPalCredentials {
  clientId: string;
  clientSecret: string;
}

export interface CredentialSource {
  forMerchant(merchantId: string): Promise<PayPalCredentials>;
}

/** One app for all merchants: PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (or the mock's credentials). */
export function singleAppCredentials(credentials: PayPalCredentials): CredentialSource {
  return { forMerchant: () => Promise.resolve(credentials) };
}

/** paypal-mock's Pantry Plan app (see its README): not secrets, and only used against the mock. */
export const MOCK_CREDENTIALS: PayPalCredentials = {
  clientId: "pantry-plan-mock-client",
  clientSecret: "mock-secret",
};
