import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ReasonCategory,
  type AgentStreamEvent,
  type SessionContext,
  type TranscriptTurn,
} from "@keepwell/contracts";
import { FakeAudit, FakeDomainEvents, PANTRY_PLAN, pantryPlanSubscription } from "@keepwell/contracts/fakes";
import { computeMenu } from "@keepwell/policy";
import { FakeLlmClient } from "./fake-llm.js";
import { LlmError, type AgentLogger } from "./llm.js";
import {
  CLASSIFY_SYSTEM,
  CONVERSE_SYSTEM,
  PROMPT_VERSION,
  type Classification,
  type Reply,
} from "./prompts.js";
import { AgentRuntime, TEMPLATES } from "./runtime.js";

const NOW = new Date("2026-11-01T10:00:00.000Z");
const silent: AgentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function session(
  overrides: Partial<SessionContext> = {},
  messages: string[] = ["I'm travelling for two months"],
): SessionContext {
  const transcript: TranscriptTurn[] = messages.map((text) => ({
    role: "subscriber",
    text,
    at: NOW.toISOString(),
  }));
  return {
    sessionId: "0199a1b2-c3d4-7e5f-8a6b-00000000aaaa",
    merchantId: PANTRY_PLAN.merchantId,
    channel: "widget",
    policy: PANTRY_PLAN.policy,
    subscription: pantryPlanSubscription(NOW),
    history: {
      savesLast365d: 0,
      pausesLast365d: 0,
      lastPauseEndedAt: null,
      refundedLast30d: { value: "0.00", currency: "USD" },
    },
    plans: PANTRY_PLAN.plans,
    menu: null,
    transcript,
    presentedOfferId: null,
    fallbackLevel: "L0",
    ...overrides,
  };
}

const classified = (over: Partial<Classification> = {}): { output: Classification } => ({
  output: { reason: "temporary", intent: "explaining", language: "en", flags: [], ...over },
});
const replied = (over: Partial<Reply> = {}): { output: Reply } => ({
  output: { action: "no_offer", offerId: null, message: "Thanks for letting me know.", ...over },
});

/** The menu the runtime will compute for this reason, so tests pick real ids. */
function menuFor(reason: Classification["reason"], s = session()) {
  return computeMenu(s.policy, {
    now: NOW.toISOString(),
    channel: s.channel,
    reason,
    cancelIntent: false,
    offersPresentedThisSession: 0,
    subscription: s.subscription,
    history: s.history,
    plans: s.plans,
  });
}

function setup(llm: FakeLlmClient | null = new FakeLlmClient(), deadlineMs?: number) {
  const events = new FakeDomainEvents(() => NOW);
  const audit = new FakeAudit(() => NOW);
  const runtime = new AgentRuntime({ llm, events, audit, log: silent, clock: () => NOW, deadlineMs });
  const stream: AgentStreamEvent[] = [];
  const push = (e: AgentStreamEvent) => {
    stream.push(e);
  };
  const text = () => stream.flatMap((e) => (e.type === "agent.delta" ? [e.text] : [])).join("");
  const offers = () => stream.filter((e) => e.type === "offer.presented");
  return { runtime, events, audit, stream, push, text, offers };
}

describe("AgentRuntime.start", () => {
  it("computes the full menu and starts in L0 when a model is configured", async () => {
    const { runtime } = setup();
    const started = await runtime.start(session());
    expect(started.fallbackLevel).toBe("L0");
    expect(started.menu).toEqual(menuFor("unknown"));
    expect(started.menu.offers.length).toBeGreaterThan(0);
  });

  it("starts in L1 without a model", async () => {
    const { runtime } = setup(null);
    expect((await runtime.start(session())).fallbackLevel).toBe("L1");
  });
});

describe("AgentRuntime.respond", () => {
  it("presents the picked offer with card text from the offer object, after recording it", async () => {
    const pause = menuFor("temporary").offers.find((o) => o.kind === "pause");
    if (!pause) throw new Error("fixture: Pantry Plan offers a pause for travel");
    const llm = new FakeLlmClient()
      .script("classify", classified())
      .script(
        "converse",
        replied({ action: "present_offer", offerId: pause.id, message: "A break might suit you better." }),
      );
    const { runtime, push, stream, text, offers, events, audit } = setup(llm);

    await runtime.respond(session(), "I'm travelling for two months", push);

    expect(text()).toBe("A break might suit you better.");
    const [presented] = offers();
    expect(presented?.offer).toEqual(pause);
    const resumes = new Intl.DateTimeFormat("en", { dateStyle: "long", timeZone: "UTC" }).format(
      new Date(pause.resumesOn),
    );
    expect(presented?.cardText).toBe(
      `Pause for ${pause.cycles} billing cycle${pause.cycles === 1 ? "" : "s"}. Billing resumes on ${resumes}.`,
    );
    const hash = createHash("sha256").update(`${text()}\n${presented?.cardText}`).digest("hex");
    expect(presented?.shownTextHash).toBe(hash);
    expect(stream.at(-1)?.type).toBe("agent.done");
    expect(events.ofType("session.offer_presented")).toHaveLength(1);
    expect(audit.byKind("offer.presented")[0]?.payload).toMatchObject({ offer: pause, reason: "temporary" });
    expect(llm.calls.map((c) => [c.purpose, c.system])).toEqual([
      ["classify", CLASSIFY_SYSTEM],
      ["converse", CONVERSE_SYSTEM],
    ]);
  });

  it("puts the transcript inside data tags and lists only menu ids", async () => {
    const llm = new FakeLlmClient().script("classify", classified()).script("converse", replied());
    const { runtime, push } = setup(llm);
    await runtime.respond(session(), "I'm travelling for two months", push);
    const input = llm.calls[1]?.input ?? "";
    expect(input).toContain("<transcript>\nsubscriber: I'm travelling for two months\n</transcript>");
    for (const offer of menuFor("temporary").offers) expect(input).toContain(`id: ${offer.id} |`);
    expect(input).toContain("ask_one_question allowed: yes");
  });

  it.each([
    ["cancel_now", classified({ intent: "cancel_now" }), TEMPLATES.en.close],
    ["abusive", classified({ flags: ["abusive"] }), TEMPLATES.en.close],
    ["distress", classified({ flags: ["distress"] }), TEMPLATES.en.care],
  ])("closes on %s with no offer and no conversation call", async (_name, step, template) => {
    const llm = new FakeLlmClient().script("classify", step);
    const { runtime, push, text, offers, events } = setup(llm);
    await runtime.respond(session(), "just cancel it", push);
    expect(text()).toBe(template);
    expect(offers()).toHaveLength(0);
    expect(events.emitted).toHaveLength(0);
    expect(llm.calls.map((c) => c.purpose)).toEqual(["classify"]);
  });

  it("denies an invented offer, retries once, then closes without an offer", async () => {
    const invented = replied({
      action: "present_offer",
      offerId: "offer-a-year-free",
      message: "Have a year on us.",
    });
    const llm = new FakeLlmClient().script("classify", classified()).script("converse", invented, invented);
    const { runtime, push, text, offers, events } = setup(llm);
    await runtime.respond(session(), "I'm travelling", push);
    expect(llm.calls.filter((c) => c.purpose === "converse")).toHaveLength(2);
    expect(offers()).toHaveLength(0);
    expect(events.emitted).toHaveLength(0);
    expect(text()).toBe(TEMPLATES.en.close);
  });

  it("denies a real offer id that the policy rules out for this reason", async () => {
    const allowed = new Set(menuFor("temporary").offers.map((o) => o.id));
    const ruledOut = menuFor("unknown").offers.find((o) => !allowed.has(o.id));
    if (!ruledOut) throw new Error("fixture: some kind is ruled out for travel");
    const pick = replied({ action: "present_offer", offerId: ruledOut.id, message: "Here is an option." });
    const llm = new FakeLlmClient().script("classify", classified()).script("converse", pick, pick);
    const { runtime, push, offers, text } = setup(llm);
    await runtime.respond(session(), "travelling", push);
    expect(offers()).toHaveLength(0);
    expect(text()).toBe(TEMPLATES.en.close);
  });

  it("closes without asking the model when the subscription isn't active", async () => {
    const s = session({ subscription: pantryPlanSubscription(NOW, { status: "SUSPENDED" }) });
    const llm = new FakeLlmClient().script("classify", classified({ reason: "price" }));
    const { runtime, push, offers, text } = setup(llm);
    await runtime.respond(s, "too expensive", push);
    expect(offers()).toHaveLength(0);
    expect(text()).toBe(TEMPLATES.en.close);
    expect(llm.calls.map((c) => c.purpose)).toEqual(["classify"]);
  });

  it("keeps the first allowed pick when the retry breaks the text rule without an offer", async () => {
    const pause = menuFor("temporary").offers.find((o) => o.kind === "pause");
    if (!pause) throw new Error("fixture: pause");
    const llm = new FakeLlmClient()
      .script("classify", classified())
      .script(
        "converse",
        replied({ action: "present_offer", offerId: pause.id, message: "Pause for 2 months!" }),
        replied({ action: "no_offer", message: "Cancel within 24 hours." }),
      );
    const { runtime, push, text, offers } = setup(llm);
    await runtime.respond(session(), "travelling", push);
    expect(offers()[0]?.offer).toEqual(pause);
    expect(text()).toBe(TEMPLATES.en.offer);
  });

  it("keeps an allowed pick with template text when the model writes figures twice", async () => {
    const pause = menuFor("temporary").offers.find((o) => o.kind === "pause");
    if (!pause) throw new Error("fixture: pause");
    const withFigures = replied({
      action: "present_offer",
      offerId: pause.id,
      message: "Pause for 2 months for $0!",
    });
    const llm = new FakeLlmClient()
      .script("classify", classified())
      .script("converse", withFigures, withFigures);
    const { runtime, push, text, offers } = setup(llm);
    await runtime.respond(session(), "travelling", push);
    expect(text()).toBe(TEMPLATES.en.offer);
    expect(offers()[0]?.offer).toEqual(pause);
  });

  it("speaks the subscriber's language on the card", async () => {
    const pause = menuFor("temporary").offers.find((o) => o.kind === "pause");
    if (!pause) throw new Error("fixture: pause");
    const message = "थोड़ा विराम आपकी यात्रा के लिए ठीक रहेगा।";
    const llm = new FakeLlmClient()
      .script("classify", classified({ language: "hi-IN" }))
      .script("converse", replied({ action: "present_offer", offerId: pause.id, message }));
    const { runtime, push, text, offers } = setup(llm);
    await runtime.respond(session(), "मैं दो महीने बाहर रहूँगा", push);
    expect(text()).toBe(message);
    expect(offers()[0]?.cardText).toContain("बिलिंग चक्र के लिए रोकें");
  });

  it("closes in the subscriber's language", async () => {
    const llm = new FakeLlmClient().script("classify", classified({ language: "es", intent: "cancel_now" }));
    const { runtime, push, text } = setup(llm);
    await runtime.respond(session(), "quiero cancelar", push);
    expect(text()).toBe(TEMPLATES.es.close);
  });

  it("retries a reply that talks about an offer it didn't present", async () => {
    const pause = menuFor("temporary").offers.find((o) => o.kind === "pause");
    if (!pause) throw new Error("fixture: pause");
    const offTopic = replied({
      action: "present_offer",
      offerId: pause.id,
      message: "Or I could refund you.",
    });
    const llm = new FakeLlmClient().script("classify", classified()).script("converse", offTopic, offTopic);
    const { runtime, push, text, offers } = setup(llm);
    await runtime.respond(session(), "travelling", push);
    expect(llm.calls.filter((c) => c.purpose === "converse")).toHaveLength(2);
    expect(text()).toBe(TEMPLATES.en.offer);
    expect(offers()[0]?.offer).toEqual(pause);
  });

  it("accepts the retry when the first reply breaks a rule", async () => {
    const llm = new FakeLlmClient()
      .script("classify", classified())
      .script(
        "converse",
        replied({ message: "Only 3 days left!" }),
        replied({ message: "Understood, take care." }),
      );
    const { runtime, push, text } = setup(llm);
    await runtime.respond(session(), "travelling", push);
    expect(text()).toBe("Understood, take care.");
  });

  it("allows one question only as the agent's first turn", async () => {
    const question = replied({
      action: "ask_one_question",
      message: "Is it the price or how often you use it?",
    });
    const llm = new FakeLlmClient()
      .script("classify", classified({ reason: "unknown" }))
      .script("converse", question, question);
    const { runtime, push, text } = setup(llm);
    const s = session({}, ["I want to leave", "not sure"]);
    s.transcript.splice(1, 0, { role: "agent", text: "What made you decide?", at: NOW.toISOString() });
    await runtime.respond(s, "not sure", push);
    expect(llm.calls[1]?.input).toContain("ask_one_question allowed: no");
    expect(text()).toBe(TEMPLATES.en.close);
  });

  it("offers nothing more once an offer was presented", async () => {
    const llm = new FakeLlmClient().script("classify", classified());
    const { runtime, push, text, offers } = setup(llm);
    await runtime.respond(session({ presentedOfferId: "offer-pause-1" }), "what about a discount?", push);
    expect(offers()).toHaveLength(0);
    expect(text()).toBe(TEMPLATES.en.close);
    expect(llm.calls.map((c) => c.purpose)).toEqual(["classify"]);
  });

  it("answers a fourth message with the limit text and no model call", async () => {
    const llm = new FakeLlmClient();
    const { runtime, push, text } = setup(llm);
    await runtime.respond(session({}, ["a", "b", "c", "d"]), "d", push);
    expect(text()).toBe(TEMPLATES.en.limit);
    expect(llm.calls).toHaveLength(0);
  });

  it.each([
    ["unavailable", { error: new LlmError("unavailable", "503") }],
    ["refused", { error: new LlmError("refused", "declined") }],
  ])("falls to L1 when the classifier is %s", async (_name, step) => {
    const llm = new FakeLlmClient().script("classify", step);
    const { runtime, push, stream, text } = setup(llm);
    await runtime.respond(session(), "travelling", push);
    expect(stream[0]).toEqual({ type: "fallback.changed", level: "L1" });
    expect(text()).toBe(TEMPLATES.en.l1);
    expect(stream.at(-1)).toMatchObject({ type: "reason.chips" });
    expect(stream.at(-1)).not.toMatchObject({ reasons: expect.arrayContaining(["unknown"]) as unknown });
  });

  it("falls to L1 after two invalid classifier outputs", async () => {
    const bad = { output: { reason: "bored", intent: "explaining", language: "en", flags: [] } };
    const llm = new FakeLlmClient().script("classify", bad, bad);
    const { runtime, push, stream } = setup(llm);
    await runtime.respond(session(), "travelling", push);
    expect(llm.calls).toHaveLength(2);
    expect(stream[0]).toEqual({ type: "fallback.changed", level: "L1" });
  });

  it("falls to L1 when the model misses the deadline", async () => {
    const llm = new FakeLlmClient().script("classify", classified()).script("converse", { hang: true });
    const { runtime, push, stream, offers } = setup(llm, 20);
    await runtime.respond(session(), "travelling", push);
    expect(stream[0]).toEqual({ type: "fallback.changed", level: "L1" });
    expect(offers()).toHaveLength(0);
  });

  it("never calls the model in an L1 session", async () => {
    const llm = new FakeLlmClient();
    const { runtime, push, stream } = setup(llm);
    await runtime.respond(session({ fallbackLevel: "L1" }), "hello", push);
    expect(llm.calls).toHaveLength(0);
    expect(stream.some((e) => e.type === "fallback.changed")).toBe(false);
    expect(stream.at(-1)?.type).toBe("reason.chips");
  });
});

describe("AgentRuntime.respondToReason (L1)", () => {
  it("presents the policy's default for the chip, re-checked and recorded", async () => {
    const full = menuFor("unknown");
    const defaultId = full.defaultByReason.temporary;
    const llm = new FakeLlmClient();
    const { runtime, push, text, offers, audit } = setup(llm);
    await runtime.respondToReason(session({ fallbackLevel: "L1" }), "temporary", push);
    expect(llm.calls).toHaveLength(0);
    expect(offers()[0]?.offer.id).toBe(defaultId);
    expect(text()).toBe(TEMPLATES.en.offer);
    expect(audit.byKind("offer.presented")).toHaveLength(1);
  });

  it("closes when the reason has no default (a missing feature isn't fixed by a discount)", async () => {
    const { runtime, push, text, offers } = setup();
    await runtime.respondToReason(session({ fallbackLevel: "L1" }), "missing_feature", push);
    expect(offers()).toHaveLength(0);
    expect(text()).toBe(TEMPLATES.en.close);
  });

  it("closes when an offer was already presented", async () => {
    const { runtime, push, offers } = setup();
    await runtime.respondToReason(session({ presentedOfferId: "offer-pause-1" }), "temporary", push);
    expect(offers()).toHaveLength(0);
  });
});

describe("every reason category (#24)", () => {
  const REASONS = ReasonCategory.options;

  it.each(REASONS)("L0, %s: presents a fitting offer from that reason's menu, or closes", async (reason) => {
    const menu = menuFor(reason);
    const first = menu.offers[0];
    const llm = new FakeLlmClient().script("classify", classified({ reason }));
    if (first)
      llm.script(
        "converse",
        replied({ action: "present_offer", offerId: first.id, message: "Here's an option." }),
      );
    const { runtime, push, text, offers, audit } = setup(llm);

    await runtime.respond(session(), "I'm leaving", push);

    if (first) {
      expect(offers()[0]?.offer).toEqual(first);
      expect(audit.byKind("offer.presented")[0]?.payload).toMatchObject({ reason });
    } else {
      // Nothing fits this reason: a polite close, and no second model call.
      expect(offers()).toHaveLength(0);
      expect(text()).toBe(TEMPLATES.en.close);
      expect(llm.calls.filter((c) => c.purpose === "converse")).toHaveLength(0);
    }
  });

  it.each(REASONS)(
    "L0, %s: a cancel intent closes at once, with no offer and no reply call",
    async (reason) => {
      const llm = new FakeLlmClient().script("classify", classified({ reason, intent: "cancel_now" }));
      const { runtime, push, text, offers } = setup(llm);
      await runtime.respond(session(), "Just cancel it, please.", push);
      expect(offers()).toHaveLength(0);
      expect(text()).toBe(TEMPLATES.en.close);
      expect(llm.calls.map((c) => c.purpose)).toEqual(["classify"]);
    },
  );

  it.each(REASONS.filter((r) => r !== "unknown"))(
    "L1, %s: the chip shows the policy's default for it, or closes",
    async (reason) => {
      const defaultId = menuFor("unknown").defaultByReason[reason];
      const { runtime, push, text, offers } = setup(null);
      await runtime.respondToReason(session({ fallbackLevel: "L1" }), reason, push);
      if (defaultId) {
        expect(offers()[0]?.offer.id).toBe(defaultId);
        // The default must also be allowed for this specific reason, not just on the full menu.
        expect(menuFor(reason).offers.map((o) => o.id)).toContain(defaultId);
      } else {
        expect(offers()).toHaveLength(0);
        expect(text()).toBe(TEMPLATES.en.close);
      }
    },
  );

  it("covers both outcomes with the Pantry Plan policy", () => {
    const withOffers = REASONS.filter((r) => menuFor(r).offers.length > 0);
    expect(withOffers.length).toBeGreaterThan(0);
    expect(withOffers.length).toBeLessThan(REASONS.length);
  });
});

describe("the session's language (#24)", () => {
  it("answers an L1 chip tap in the session's language", async () => {
    const { runtime, push, text, offers } = setup(null);
    await runtime.respondToReason(session({ fallbackLevel: "L1", locale: "es-MX" }), "temporary", push);
    expect(text()).toBe(TEMPLATES.es.offer);
    expect(offers()[0]?.cardText).toMatch(/^Pausa/);
  });

  it("falls to L1 in the session's language", async () => {
    const { runtime, push, text } = setup(null);
    await runtime.respond(session({ locale: "hi" }), "मुझे रद्द करना है", push);
    expect(text()).toBe(TEMPLATES.hi.l1);
  });

  it("uses the session's language when the classifier hears one we have no templates for", async () => {
    const llm = new FakeLlmClient().script("classify", classified({ language: "fr", intent: "cancel_now" }));
    const { runtime, push, text } = setup(llm);
    await runtime.respond(session({ locale: "es" }), "je veux annuler", push);
    expect(text()).toBe(TEMPLATES.es.close);
  });

  it("prefers the subscriber's own language over the session's", async () => {
    const llm = new FakeLlmClient().script("classify", classified({ language: "hi", intent: "cancel_now" }));
    const { runtime, push, text } = setup(llm);
    await runtime.respond(session({ locale: "en-US" }), "मुझे रद्द करना है", push);
    expect(text()).toBe(TEMPLATES.hi.close);
  });

  it("stays in English without a session language", async () => {
    const { runtime, push, text } = setup(null);
    await runtime.respondToReason(session({ fallbackLevel: "L1" }), "missing_feature", push);
    expect(text()).toBe(TEMPLATES.en.close);
  });
});

describe("prompt versions (#24)", () => {
  it("records the prompt version with every offer", async () => {
    const { runtime, push, audit } = setup(null);
    await runtime.respondToReason(session({ fallbackLevel: "L1" }), "temporary", push);
    expect(audit.byKind("offer.presented")[0]?.payload).toMatchObject({ promptVersion: PROMPT_VERSION });
  });
});
