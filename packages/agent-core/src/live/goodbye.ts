// Whether a receptionist's line says goodbye, in the languages calls open in
// (runtimeLocales in @lobbystack/shared). The call controller asks it whether
// GPT-Live already said goodbye to a caller who is done, so the result that
// ends the call doesn't get a second one, and pnpm voice:eval counts goodbyes
// with it. Words that also greet, such as "ciao", "salut" or "namaste", aren't
// goodbyes here, and neither is "see you", which also confirms a booking.
// A goodbye this misses gets a second one, as every goodbye did before.

// Languages that write words apart: the phrase has to stand alone.
const SPACED = [
  // English
  "good[ -]?bye",
  "bye(?:[ -]bye)?",
  "take care(?! of(?! yourself))",
  "have an? (?:good|great|nice|wonderful|lovely|fantastic|pleasant|safe) (?:day|one|evening|night|afternoon|morning|weekend|time|rest of (?:your|the) (?:day|evening|week))",
  "enjoy (?:your|the rest of your) (?:day|evening|weekend)",
  "thanks? (?:you )?for calling",
  // Spanish
  "adi[oó]s",
  "hasta (?:luego|pronto|mañana|la pr[oó]xima)",
  "cu[ií]d(?:ese|ate|ense)",
  "que (?:tenga|tengas|tengan|pase|pases|pasen) (?:un |una )?(?:buen|buena|bonito|bonita|lindo|linda|excelente|feliz)",
  "gracias por (?:llamar|su llamada|tu llamada)",
  "cha[ou]",
  // French
  "au revoir",
  "bonne (?:journ[ée]e|soir[ée]e|nuit|fin de journ[ée]e|continuation|semaine)",
  "[àa] (?:bient[ôo]t|la prochaine|plus tard)",
  "prenez soin de vous",
  "merci (?:de|pour) votre appel",
  "merci d['’]avoir appel[ée]",
  // German
  "auf wieder(?:sehen|h[öo]ren)",
  "tsch[üu]ss?",
  "(?:einen )?sch[öo]nen (?:tag|abend|feierabend)",
  "bis (?:bald|dann|sp[äa]ter)",
  "danke f[üu]r (?:ihren|deinen) anruf",
  // Portuguese
  "tchau",
  "adeus",
  "at[ée] (?:logo|mais|breve|a pr[óo]xima)",
  "(?:tenha|tenham) um (?:bom|[óo]timo|excelente) dia",
  "obrigad[oa] por (?:ligar|sua liga[çc][ãa]o)",
  "cuide-se",
  // Italian
  "arrivederci",
  "arrivederla",
  "buona (?:giornata|serata|notte|continuazione)",
  "a presto",
  "grazie per (?:aver chiamato|la chiamata)",
  // Russian
  "до свидания",
  "всего (?:доброго|хорошего|наилучшего)",
  "хорошего (?:дня|вечера)",
  "спасибо за звонок",
  // Ukrainian
  "до побачення",
  "на все добре",
  "бувайте",
  "бувай",
  "гарного (?:дня|вечора)",
  "всього (?:найкращого|доброго)",
  "дякую за дзвінок",
  // Hindi, in Devanagari or in Latin letters
  "अलविदा",
  "फिर मिलेंगे",
  "आपका दिन शुभ हो",
  "alvida",
  "phir milenge",
];

// Languages written without spaces, or whose words take prefixes: the phrase can sit inside a longer run of letters.
const RUN_IN = [
  // Japanese
  "さようなら",
  "さよなら",
  "失礼(?:いた)?します",
  "(?:良い|よい)一日を",
  "お元気で",
  "バイバイ",
  "では、?また",
  "お電話ありがとうございました",
  // Korean
  "안녕히 (?:계세요|가세요|계십시오|가십시오)",
  "좋은 하루 (?:되세요|보내세요)",
  "전화 주셔서 감사합니다",
  // Chinese
  "再见",
  "再見",
  "拜拜",
  "回头见",
  "回頭見",
  "祝[您你].{0,8}?(?:愉快|美好|顺利|順利|开心|開心)",
  "感谢(?:您的)?来电",
  "感謝(?:您的)?來電",
  // Arabic
  "مع السلامة",
  "إلى اللقاء",
  "الى اللقاء",
  "في أمان الله",
  "شكرا لاتصالك",
  "شكراً لاتصالك",
];

const GOODBYE = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])(?:${SPACED.join("|")})(?![\\p{L}\\p{M}\\p{N}])|${RUN_IN.join("|")}`, "iu");

/** Whether the line says goodbye, in any of the languages calls open in. */
export function saysGoodbye(text: string): boolean {
  return GOODBYE.test(text);
}
