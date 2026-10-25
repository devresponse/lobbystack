// Scripted callers shared by live-call-eval.ts (GPT-Live over the API) and
// test-call.ts (a real phone call). Every call opens with OPENING, or the
// scenario's own opening, and waits for the receptionist's answer; then the
// scenario's lines play, each after pauseMs of the caller's silence.

export type CallerLine = { text: string; pauseMs?: number };

export type CallScenario = {
  name: string;
  /** "ends": the receptionist should hang up after the last line. "continues": the call should go on. */
  expect: "ends" | "continues";
  lines: CallerLine[];
  /** Replaces OPENING. The eval then checks the receptionist's answer to it as part of the scenario. */
  opening?: string;
  /** The caller's language, English unless set. The phone script reads the scenario's own opening and lines in a voice that speaks it. */
  language?: "en" | "es";
  /** The eval fails a run when any of the receptionist's lines matches this. The phone script can't check it. */
  mustNotSay?: RegExp;
  /**
   * The call's time limit, counted from when the worker attaches. Only the
   * eval can set it, so the phone script skips the scenario. The eval passes
   * a run only when the receptionist said goodbye before the call ended.
   */
  limitMs?: number;
};

export const OPENING = "Hi, are you open on Saturday?";

// Common English words that no Spanish reply has. A business or service name
// with one of them, as a --snapshot business can have, fails the run too.
const ENGLISH_WORDS = /\b(the|you|your|we|our|is|are|it|that|this|what|have|and|with|for|of|yes|please|sorry|moment|let|check|checking|hello|thanks)\b/i;

export const SCENARIOS: CallScenario[] = [
  { name: "thanks-bye", expect: "ends", lines: [{ text: "Okay, perfect. That is all I needed. Thanks, bye!" }] },
  { name: "goodbye", expect: "ends", lines: [{ text: "No, that's everything. Goodbye!" }] },
  { name: "good-day", expect: "ends", lines: [{ text: "Great, thank you so much. Have a good day, bye bye." }] },
  { name: "thats-it", expect: "ends", lines: [{ text: "Nope, that's it. Thanks." }] },
  // The caller answers the receptionist's goodbye with their own.
  { name: "trailing-goodbye", expect: "ends", lines: [{ text: "No, that's everything." }, { text: "Goodbye!", pauseMs: 1_500 }] },
  // The caller pauses before the question, so the receptionist mustn't hang up meanwhile.
  { name: "one-more-thing", expect: "continues", lines: [{ text: "No, that's everything." }, { text: "Oh wait, one more thing.", pauseMs: 3_000 }, { text: "Do you have parking?", pauseMs: 3_000 }] },
  // Spanish callers, so every reply must be in Spanish. The demo business's
  // facts don't say whether it takes cards or when it has openings, so
  // GPT-Live hands both questions to the backend, whose answers come back in
  // English. The first caller asks to switch after the English opening; the
  // second speaks Spanish from the first word, after the English greeting.
  { name: "spanish-switch", expect: "continues", language: "es", mustNotSay: ENGLISH_WORDS, lines: [{ text: "¿Podemos seguir en español? ¿Aceptan tarjeta de crédito?" }, { text: "¿Y tienen citas disponibles el martes por la mañana?", pauseMs: 15_000 }] },
  { name: "spanish-only", expect: "continues", language: "es", mustNotSay: ENGLISH_WORDS, opening: "Hola, ¿abren el sábado?", lines: [{ text: "¿Aceptan tarjeta de crédito?" }, { text: "¿Y tienen citas disponibles el martes por la mañana?", pauseMs: 15_000 }] },
];

// Scenarios that book a real appointment, so they run only by name.
const BOOKING_SCENARIOS: CallScenario[] = [
  // The caller turns down texts only after accepting the time, so the booking
  // can come before the answer. No confirmation text may follow. It asks for
  // staging's "Initial consultation"; check the contact's answer and the
  // texts, then cancel the appointment.
  { name: "book-no-texts", expect: "continues", lines: [{ text: "Okay. Can I book an initial consultation on Tuesday at 10 AM? My name is Sam Lee." }, { text: "Yes, please book it.", pauseMs: 15_000 }, { text: "And no text messages, please.", pauseMs: 12_000 }] },
];

// Scenarios that can put a real phone call through to the business's team, so
// they run only by name. The eval has no transfer tool, so its receptionist
// must never announce a transfer; run them with --browser for a widget call.
const PERSON_SCENARIOS: CallScenario[] = [
  { name: "ask-for-person", expect: "continues", lines: [{ text: "Okay, thanks. Can I speak to a real person, please?" }], mustNotSay: /\b(connecting you|transferring you|putting you through|(I'll|I will|let me) (connect|transfer) you)\b/i },
];

// Scenarios that run into the call's time limit, so they take a few minutes
// each and run only by name. The caller keeps asking questions past the
// 3-minute limit: the receptionist should warn them a minute before its
// goodbye, which starts at 2.5 minutes, then say goodbye.
const LIMIT_SCENARIOS: CallScenario[] = [
  {
    name: "time-limit",
    expect: "ends",
    limitMs: 180_000,
    lines: [
      "Do you take new patients?",
      "How long is a general checkup?",
      "And a vaccination visit?",
      "Where do I park?",
      "Can I bring my kids to the same appointment?",
      "Do you do referrals to specialists?",
      "Are you open on Sundays?",
      "What should I bring to my first visit?",
      "Do you have a wheelchair ramp?",
      "Can I pay by credit card?",
      "Do you send appointment reminders?",
      "Okay, and one last thing.",
    ].map((text) => ({ text, pauseMs: 16_000 })),
  },
];

export function findScenarios(names: string[]): CallScenario[] {
  if (!names.length) return SCENARIOS;
  const all = [...SCENARIOS, ...BOOKING_SCENARIOS, ...PERSON_SCENARIOS, ...LIMIT_SCENARIOS];
  return names.map((name) => {
    const scenario = all.find((item) => item.name === name);
    if (!scenario) throw new Error(`Unknown scenario "${name}". Scenarios: ${all.map((item) => item.name).join(", ")}.`);
    return scenario;
  });
}
