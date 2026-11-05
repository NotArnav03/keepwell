import type { BillingInterval, InsightActionProposal, Money } from "@keepwell/contracts";

// The deterministic revenue estimate for an insight action (ARCHITECTURE.md §6.12). Every number
// comes from the merchant's own data plus the stated assumptions below, never from a model, and
// the arithmetic is exact: integer cents, with BigInt fractions that are rounded once at the end.

/** The assumptions a merchant can read in the estimate's `basis`. Rates are basis points (3000 = 30%). */
export interface EstimateAssumptions {
  /** Of the people who left citing price, the share a cheaper plan would have kept. */
  captureRateBp: number;
  /** Of the subscribers on a plan the new one undercuts, the share who would switch down. */
  downgradeRateBp: number;
}

export const DEFAULT_ASSUMPTIONS: EstimateAssumptions = { captureRateBp: 3000, downgradeRateBp: 1000 };
export const DEFAULT_LOOKBACK_DAYS = 30;

/** An existing plan with active subscribers, as the aggregates see it. */
export interface PlanFootprint {
  planName: string;
  activeSubscribers: number;
  price: Money;
  interval: BillingInterval;
}

/** What the estimate reads from the merchant's data. A SQL version is in sql-inputs.ts; tests use a fake. */
export interface EstimateInputs {
  /** Cancellations in the last `days` days whose reason was price. */
  priceCancellations(merchantId: string, days: number): Promise<number>;
  /** Active subscribers grouped by plan, in one currency. */
  planFootprints(merchantId: string, currency: string): Promise<PlanFootprint[]>;
}

export interface Estimate {
  monthlyRevenueImpact: Money;
  basis: string;
}

/** `estimate` is null when there is nothing to estimate from; `basis` always says why. */
export interface EstimateResult {
  estimate: Estimate | null;
  basis: string;
}

/** The copilot and the service both call this. */
export interface EstimateProvider {
  estimate(merchantId: string, proposal: InsightActionProposal): Promise<EstimateResult>;
}

// ---------- exact arithmetic ----------

interface Fraction {
  n: bigint;
  d: bigint;
}

const frac = (n: bigint | number, d: bigint | number = 1n): Fraction => ({ n: BigInt(n), d: BigInt(d) });
const mul = (a: Fraction, b: Fraction): Fraction => ({ n: a.n * b.n, d: a.d * b.d });
const add = (a: Fraction, b: Fraction): Fraction => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
const sub = (a: Fraction, b: Fraction): Fraction => ({ n: a.n * b.d - b.n * a.d, d: a.d * b.d });
const isPositive = (a: Fraction): boolean => a.n > 0n;
/** Nearest cent, halves up. Only called on non-negative values. */
const roundCents = (a: Fraction): bigint => (2n * a.n + a.d) / (2n * a.d);

const MONTHLY_FACTOR: Record<BillingInterval["unit"], Fraction> = {
  DAY: frac(365, 12),
  WEEK: frac(52, 12),
  MONTH: frac(1),
  YEAR: frac(1, 12),
};

export function toCents(money: Money): bigint {
  const [whole = "0", cents = "00"] = money.value.split(".");
  return BigInt(whole) * 100n + BigInt(cents);
}

export function fromCents(cents: bigint, currency: string): Money {
  const whole = cents / 100n;
  const rest = (cents % 100n).toString().padStart(2, "0");
  return { value: `${whole}.${rest}`, currency };
}

/** What one billing of `price` brings in per month. */
function monthlyOf(price: Money, interval: BillingInterval): Fraction {
  // price per cycle × cycles per month; a cycle is `count` units long.
  return mul(mul(frac(toCents(price)), MONTHLY_FACTOR[interval.unit]), frac(1, interval.count));
}

function show(cents: bigint, currency: string): string {
  const { value } = fromCents(cents, currency);
  return currency === "USD" ? `$${value}` : `${value} ${currency}`;
}

const pct = (bp: number): string => `${bp % 100 === 0 ? bp / 100 : (bp / 100).toFixed(2)}%`;
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

// ---------- create_plan ----------

export interface CreatePlanEstimateInput {
  price: Money;
  interval: BillingInterval;
  priceCancellations: number;
  lookbackDays: number;
  plans: PlanFootprint[];
  assumptions?: EstimateAssumptions;
}

/**
 * monthly impact = (price cancellations per 30 days × capture rate) × new monthly price
 *                  − Σ (subscribers on each pricier plan × downgrade rate × monthly saving).
 *
 * Money has no negative form (CONTRACTS.md §1), so a net loss is shown as 0.00 and the basis says
 * how large the loss is.
 */
export function estimateCreatePlan(input: CreatePlanEstimateInput): EstimateResult {
  const { price, interval, priceCancellations, lookbackDays } = input;
  const { captureRateBp, downgradeRateBp } = input.assumptions ?? DEFAULT_ASSUMPTIONS;
  const { currency } = price;

  if (priceCancellations <= 0) {
    const basis = `No cancellations citing price in the last ${lookbackDays} days, so there is nothing to estimate from.`;
    return { estimate: null, basis };
  }

  const newMonthly = monthlyOf(price, interval);
  const perMonth = frac(30, lookbackDays);
  const kept = mul(mul(frac(priceCancellations), perMonth), frac(captureRateBp, 10_000));
  const gain = mul(kept, newMonthly);

  let loss = frac(0);
  const lossParts: string[] = [];
  for (const plan of input.plans) {
    if (plan.price.currency !== currency || plan.activeSubscribers <= 0) continue;
    const saving = sub(monthlyOf(plan.price, plan.interval), newMonthly);
    if (!isPositive(saving)) continue;
    loss = add(loss, mul(mul(frac(plan.activeSubscribers), frac(downgradeRateBp, 10_000)), saving));
    lossParts.push(
      `${plural(plan.activeSubscribers, "subscriber", "subscribers")} on ${plan.planName} × ${pct(downgradeRateBp)} downgrading × ${show(roundCents(saving), currency)} saved`,
    );
  }

  // Round each side once, then subtract whole cents, so the figures in the basis add up.
  const gainCents = roundCents(gain);
  const lossCents = roundCents(loss);
  const net = gainCents - lossCents;

  const gainText = `${plural(priceCancellations, "price-reason cancellation", "price-reason cancellations")} in ${lookbackDays} days × ${pct(captureRateBp)} capture × ${show(roundCents(newMonthly), currency)} per month = ${show(gainCents, currency)}`;
  const lossText =
    lossParts.length > 0
      ? `cannibalisation: ${lossParts.join("; ")} = ${show(lossCents, currency)}`
      : "no cannibalisation (no subscribers on pricier plans)";
  const tail =
    net >= 0n
      ? `net ${show(net, currency)} per month`
      : `net a loss of ${show(-net, currency)} per month, shown as ${show(0n, currency)}`;
  const basis = `${gainText}; ${lossText}; ${tail}.`;

  return { estimate: { monthlyRevenueImpact: fromCents(net > 0n ? net : 0n, currency), basis }, basis };
}

// ---------- the provider ----------

export class DeterministicEstimateProvider implements EstimateProvider {
  constructor(
    private readonly inputs: EstimateInputs,
    private readonly options: { lookbackDays?: number; assumptions?: EstimateAssumptions } = {},
  ) {}

  async estimate(merchantId: string, proposal: InsightActionProposal): Promise<EstimateResult> {
    if (proposal.kind !== "create_plan") {
      return { estimate: null, basis: `A ${proposal.kind} action has no revenue estimate.` };
    }
    const lookbackDays = this.options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
    const { price, interval } = proposal.params;
    const [priceCancellations, plans] = await Promise.all([
      this.inputs.priceCancellations(merchantId, lookbackDays),
      this.inputs.planFootprints(merchantId, price.currency),
    ]);
    return estimateCreatePlan({
      price,
      interval,
      priceCancellations,
      lookbackDays,
      plans,
      ...(this.options.assumptions && { assumptions: this.options.assumptions }),
    });
  }
}
