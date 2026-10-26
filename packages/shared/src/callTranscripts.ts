import type { RuntimeLocale } from "./locales";

/** Who may get an email after each call, as each business chooses. */
export const callTranscriptRecipientChoices = ["nobody", "owners_and_admins", "team"] as const;
export type CallTranscriptRecipients = (typeof callTranscriptRecipientChoices)[number];

/** What that email holds: the summary and a link to the call, or the whole conversation too. */
export const callTranscriptContentChoices = ["summary", "transcript"] as const;
export type CallTranscriptContent = (typeof callTranscriptContentChoices)[number];

/** Why someone on the team can't get the email: the business turned it off, or sends it to owners and admins alone. */
export type CallTranscriptUnavailableReason = "turned_off" | "owners_and_admins_only";

export function isCallTranscriptRecipients(value: unknown): value is CallTranscriptRecipients {
  return typeof value === "string" && (callTranscriptRecipientChoices as readonly string[]).includes(value);
}

export function isCallTranscriptContent(value: unknown): value is CallTranscriptContent {
  return typeof value === "string" && (callTranscriptContentChoices as readonly string[]).includes(value);
}

/** Null when someone with this role on the team may get the email after each call. */
export function callTranscriptUnavailableReason(recipients: CallTranscriptRecipients, role: string): CallTranscriptUnavailableReason | null {
  if (recipients === "nobody") return "turned_off";
  if (recipients === "owners_and_admins" && role !== "business_owner" && role !== "business_admin") return "owners_and_admins_only";
  return null;
}

// The email after a call leaves out card numbers, which PCI DSS forbids
// emailing, and social security or social insurance numbers. Callers say them
// as digits, the transcription writes them in groups ("4111 1111 1111 1111",
// "123-45-6789", "4,111,111,111,111,111") or one at a time ("4 1 1 1", "four
// one one one"), so a number is a run of digits and digit words with at most a
// few spaces or marks between them. The saved transcript keeps every word.

const DIGIT_WORDS: Record<string, string> = {
  zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  zéro: "0", un: "1", deux: "2", trois: "3", quatre: "4", cinq: "5", sept: "7", huit: "8", neuf: "9",
  cero: "0", uno: "1", dos: "2", tres: "3", cuatro: "4", cinco: "5", seis: "6", siete: "7", ocho: "8", nueve: "9",
  nula: "0", jedan: "1", dva: "2", tri: "3", četiri: "4", pet: "5", šest: "6", sedam: "7", osam: "8", devet: "9",
};
const NUMBER_PART = /\d+|\p{L}+/gu;
const BETWEEN_DIGITS = /^[\s,.\-–—/]{1,3}$/u;

type NumberPart = { start: number; end: number; digits: string };

/** The text's runs of numbers, each a list of its parts in order. */
function numberRuns(text: string): NumberPart[][] {
  const runs: NumberPart[][] = [];
  let run: NumberPart[] = [];
  for (const match of text.matchAll(NUMBER_PART)) {
    const digits = /^\d/u.test(match[0]) ? match[0] : DIGIT_WORDS[match[0].toLowerCase()];
    const previous = run.at(-1);
    if (digits === undefined || (previous && !BETWEEN_DIGITS.test(text.slice(previous.end, match.index)))) {
      if (run.length > 0) runs.push(run);
      run = [];
    }
    if (digits !== undefined) run.push({ start: match.index, end: match.index + match[0].length, digits });
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

/** The card checksum. */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
    sum += digit;
  }
  return sum % 10 === 0;
}

/**
 * A US social security number (123-45-6789) or a Canadian social insurance
 * number (046 454 286): nine digits, said together, in those groups or one at
 * a time. A phone number said a digit at a time is ten, so it's left alone.
 */
function isIdNumber(parts: NumberPart[]): boolean {
  const digits = parts.map((part) => part.digits).join("");
  if (digits.length !== 9) return false;
  const groups = parts.map((part) => part.digits.length).join("-");
  if (!["9", "3-2-4", "3-3-3"].includes(groups) && parts.some((part) => part.digits.length !== 1)) return false;
  const socialSecurity = !/^(000|666|9)/u.test(digits) && digits.slice(3, 5) !== "00" && digits.slice(5) !== "0000";
  return socialSecurity || passesLuhn(digits);
}

/**
 * The text with card numbers (13 to 19 digits that pass the card checksum) and
 * social security or insurance numbers replaced by the labels, in the
 * reader's language. A card number can sit in a longer run, before its expiry
 * date for one; an ID number is a run on its own.
 */
export function withoutCardAndIdNumbers(text: string, labels: { card: string; id: string } = { card: "[card number removed]", id: "[ID number removed]" }): string {
  const removed: Array<{ start: number; end: number; label: string }> = [];
  for (const run of numberRuns(text)) {
    let rest: NumberPart[] = [];
    for (let first = 0; first < run.length; first += 1) {
      let card: number | undefined;
      // The longest card number that starts here.
      for (let last = first, length = 0; last < run.length && length + run[last]!.digits.length <= 19; last += 1) {
        length += run[last]!.digits.length;
        if (length >= 13 && passesLuhn(run.slice(first, last + 1).map((part) => part.digits).join(""))) card = last;
      }
      if (card === undefined) {
        rest.push(run[first]!);
        continue;
      }
      if (isIdNumber(rest)) removed.push({ start: rest[0]!.start, end: rest.at(-1)!.end, label: labels.id });
      rest = [];
      removed.push({ start: run[first]!.start, end: run[card]!.end, label: labels.card });
      first = card;
    }
    if (isIdNumber(rest)) removed.push({ start: rest[0]!.start, end: rest.at(-1)!.end, label: labels.id });
  }
  let result = "";
  let from = 0;
  for (const part of removed) {
    result += `${text.slice(from, part.start)}${part.label}`;
    from = part.end;
  }
  return `${result}${text.slice(from)}`;
}

/**
 * What a call says right after the greeting, in the language it opens in,
 * unless the business turns it off: that the caller is speaking with an AI,
 * and that the call is recorded and transcribed. Calls keep OpenAI's
 * recording, and the business reads the transcript and can have it emailed.
 */
export const callRecordingNotices: Record<RuntimeLocale, string> = {
  en: "You're speaking with an AI assistant, and this call is recorded and transcribed.",
  es: "Está hablando con un asistente de IA, y esta llamada se graba y se transcribe.",
  fr: "Vous parlez avec un assistant IA, et cet appel est enregistré et transcrit.",
  de: "Sie sprechen mit einem KI-Assistenten, und dieser Anruf wird aufgezeichnet und transkribiert.",
  hi: "आप एक AI सहायक से बात कर रहे हैं, और यह कॉल रिकॉर्ड और ट्रांसक्राइब की जा रही है।",
  ja: "こちらはAIアシスタントです。この通話は録音され、文字起こしされます。",
  ko: "AI 어시스턴트와 통화하고 계시며, 이 통화는 녹음되고 텍스트로 기록됩니다.",
  pt: "Você está falando com um assistente de IA, e esta chamada é gravada e transcrita.",
  zh: "您正在与AI助理通话，本次通话将被录音并转写成文字。",
  it: "Sta parlando con un assistente IA, e questa chiamata viene registrata e trascritta.",
  uk: "Ви розмовляєте з ШІ-асистентом, і ця розмова записується та розшифровується.",
  ru: "Вы разговариваете с ИИ-ассистентом, и этот звонок записывается и расшифровывается.",
  ar: "أنت تتحدث مع مساعد يعمل بالذكاء الاصطناعي، ويتم تسجيل هذه المكالمة وتحويلها إلى نص.",
};

/**
 * What a call opens with: the business greeting, then the notice in the
 * language the call opens in. A snapshot built before the switch existed
 * keeps the notice, which is on for every business until it's turned off.
 */
export function callOpening(snapshot: { greeting?: string | undefined; defaultLocale: RuntimeLocale; recordingNotice?: boolean | undefined }): string {
  const greeting = snapshot.greeting?.trim() ?? "";
  if (snapshot.recordingNotice === false) return greeting;
  return [greeting, callRecordingNotices[snapshot.defaultLocale] ?? callRecordingNotices.en].filter(Boolean).join(" ");
}
