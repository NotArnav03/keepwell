# modules/webhooks (owner: Arnav, M1)

PayPal webhooks (ARCHITECTURE.md §6.2). The events are hints, never state.

```
POST /webhooks/paypal/:merchantId   (intake.ts)
  store the raw body + PAYPAL-* headers in webhook_events, unique per (merchant, PayPal event id)
  queue webhook.process in the same transaction, answer 200
  a duplicate delivery hits the unique key and is answered 200 again

webhook.process   (processor.ts)
  verify with POST /v1/notifications/verify-webhook-signature: the raw body embedded byte for byte
    rejected → status "rejected", logged as an error, nothing acted on
  find the subscription (resource.id, or a sale's billing_agreement_id)
  SubscriptionSync (modules/reconcile/sync.ts): GET it from PayPal, store the snapshot, diff, emit
  status "processed"
```

**Diff-of-truth:** the domain events come from comparing our stored snapshot with what PayPal returns *now*, not from the webhook's `event_type`. A webhook that arrives late, twice or never can't put us in a wrong state. A suspend undone a second later produces no change events at all.

| Diff | Event |
|---|---|
| any field we track changed (or first sight) | `subscription.synced` with the snapshot |
| status | `subscription.status_changed`, plus `subscription.cancelled_externally` when it became CANCELLED with no Keepwell cancel Action (the win-back trigger) |
| plan id | `subscription.plan_changed` |
| `failed_payments_count` went up | `subscription.payment_failed` with PayPal's reason code and next retry |
| a newer `last_payment` | `subscription.payment_completed` |

Snapshots keep a hash of the subscriber's email (to match a portal login), never the address. The stored PayPal JSON has `email_address` and `payer_id` removed. The action engine registers `confirmFromSync` on `subscription.synced`, so a webhook showing the target status confirms APPLIED Actions with no extra PayPal call.

The tests run the whole pipeline. paypal-mock sends real signed webhooks to the intake over HTTP, and pg-boss processes them against a real Postgres. They cover duplicates, a forged body, PayPal-side versus Keepwell cancels, payments, late webhooks and a plan change.
