import { PolicyDocument } from "@keepwell/contracts";

/**
 * The demo merchant's starting policy (Pantry Plan: Lite 6/mo, Standard 12/mo, Standard Annual
 * 120/yr). Plan ids are passed in because they come from the sandbox seed. Reason rankings are
 * left to the engine's defaults.
 */
export function pantryPlanPolicy(planIds: {
  lite: string;
  standard: string;
  standardAnnual: string;
}): PolicyDocument {
  return PolicyDocument.parse({
    version: 1,
    offers: {
      pause: { enabled: true, maxCycles: 3, cooldownDays: 90 },
      downgrade: { enabled: true, targets: { [planIds.standard]: [planIds.lite] } },
      switch_annual: { enabled: true, targets: { [planIds.standard]: planIds.standardAnnual } },
      discount: { enabled: true, maxPercent: 25, maxCycles: 3 },
      refund_partial: {
        enabled: true,
        maxPercentOfLastPayment: 50,
        maxPerMonth: { value: "12.00", currency: "USD" },
      },
    },
    eligibility: { minTenureDaysForDiscount: 60, maxSavesPerSubscriberPer365d: 2 },
    reasonPreferences: {},
    tone: "warm",
    supportContact: "help@pantryplan.example",
  });
}
