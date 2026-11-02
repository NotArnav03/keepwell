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
