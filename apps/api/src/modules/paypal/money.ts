import type { Money } from "@keepwell/contracts";

// PayPal is inconsistent about decimals: a subscription's last_payment came back as "1.0" in
// sandbox while the transactions list said "1.00" (spike Q1). Our Money schema requires exactly
// two decimals, so every PayPal amount passes through here on its way in.

export interface PayPalMoney {
  currency_code: string;
  value: string;
}

export function toMoney(amount: PayPalMoney): Money {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount.value.trim());
  if (!match) throw new Error(`Unexpected PayPal amount "${amount.value}"`);
  const [, whole = "0", fraction = ""] = match;
  return { value: `${whole}.${fraction.padEnd(2, "0")}`, currency: amount.currency_code };
}

export function toPayPalMoney(money: Money): PayPalMoney {
  return { currency_code: money.currency, value: money.value };
}
