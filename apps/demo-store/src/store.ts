import { StoreApiError, verifySubscription } from "./api.js";
import { config, type StorePlan } from "./config.js";
import { saveShopper } from "./shopper.js";

// The plans page: one PayPal subscribe button per plan (JS SDK v5; spike Q7 decides on v6).
// Access is granted only after the server has checked the subscription with PayPal.

interface PayPalSdk {
  Buttons(options: {
    style: Record<string, string>;
    createSubscription: (
      data: unknown,
      actions: { subscription: { create(o: { plan_id: string }): Promise<string> } },
    ) => Promise<string>;
    onApprove: (data: { subscriptionID?: string | null }) => Promise<void>;
    onError: (err: unknown) => void;
  }): { render(container: HTMLElement): Promise<void> };
}

declare global {
  interface Window {
    paypal?: PayPalSdk;
  }
}

const status = document.querySelector<HTMLElement>("#status");

function say(text: string, tone: "info" | "error" = "info"): void {
  if (!status) return;
  status.textContent = text;
  status.dataset.tone = tone;
}

async function approved(paypalSubscriptionId: string): Promise<void> {
  say("Checking your subscription with PayPal…");
  try {
    saveShopper(await verifySubscription(config.apiBase, paypalSubscriptionId));
    location.assign("account.html");
  } catch (err) {
    const message =
      err instanceof StoreApiError && err.code === "not_active"
        ? "PayPal hasn't activated the subscription yet. Refresh in a minute, or contact us."
        : "We couldn't confirm the subscription with PayPal. You haven't been given access yet.";
    say(message, "error");
  }
}

function loadPayPal(clientId: string): Promise<PayPalSdk> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const params = new URLSearchParams({ "client-id": clientId, vault: "true", intent: "subscription" });
    script.src = `https://www.paypal.com/sdk/js?${params.toString()}`;
    script.onload = () => (window.paypal ? resolve(window.paypal) : reject(new Error("PayPal SDK missing")));
    script.onerror = () => reject(new Error("PayPal SDK failed to load"));
    document.head.append(script);
  });
}

function card(plan: StorePlan): { card: HTMLElement; slot: HTMLElement } {
  const card = document.createElement("article");
  card.className = "plan";
  const name = document.createElement("h2");
  name.textContent = plan.name;
  const price = document.createElement("p");
  price.className = "price";
  price.textContent = plan.priceLabel;
  const slot = document.createElement("div");
  slot.className = "button-slot";
  card.append(name, price, slot);
  return { card, slot };
}

/** No client id configured: a clearly labelled fake button against the fake sessions server. */
function fakeButton(slot: HTMLElement): void {
  const scenario = new URLSearchParams(location.search).get("scenario") ?? "pause";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Subscribe (FAKE PAYPAL)";
  button.addEventListener("click", () => void approved(`I-FAKE-${scenario.toUpperCase()}`));
  slot.append(button);
}

async function main(): Promise<void> {
  const list = document.querySelector<HTMLElement>("#plans");
  if (!list) return;
  const slots = config.plans.map((plan) => {
    const { card: element, slot } = card(plan);
    list.append(element);
    return { plan, slot };
  });

  if (config.paypalClientId === null) {
    document.body.dataset.fake = "true";
    for (const { slot } of slots) fakeButton(slot);
    return;
  }
  try {
    const paypal = await loadPayPal(config.paypalClientId);
    for (const { plan, slot } of slots) {
      await paypal
        .Buttons({
          style: { shape: "rect", label: "subscribe", layout: "vertical" },
          createSubscription: (_data, actions) => actions.subscription.create({ plan_id: plan.paypalPlanId }),
          onApprove: async (data) => {
            if (data.subscriptionID) await approved(data.subscriptionID);
            else say("PayPal didn't return a subscription. Nothing was charged here.", "error");
          },
          onError: () => say("PayPal ran into a problem. Please try again.", "error"),
        })
        .render(slot);
    }
  } catch {
    say("PayPal's buttons couldn't load. Please refresh the page.", "error");
  }
}

void main();
