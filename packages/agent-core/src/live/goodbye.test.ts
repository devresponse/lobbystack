import { describe, expect, it } from "vitest";

import { saysGoodbye } from "./goodbye";

describe("saysGoodbye", () => {
  it("hears the goodbyes GPT-Live said in the eval's double goodbyes", () => {
    for (const line of ["Bye!", "Take care.", "You're welcome. Take care.", "Goodbye.", "Bye-bye!", "Okay, take care.", "You too. Goodbye.", "Bye. Take care.", "Good bye."]) expect(saysGoodbye(line), line).toBe(true);
  });

  it("hears closing wishes and thanks for calling", () => {
    for (const line of ["Have a good one!", "Have a great rest of your day.", "Enjoy your weekend!", "Thanks for calling.", "Thank you for calling, take care of yourself."]) expect(saysGoodbye(line), line).toBe(true);
  });

  it("hears a goodbye in each language calls open in", () => {
    const lines = [
      "¡Adiós! Que tenga un buen día.",
      "Hasta luego, cuídese.",
      "Merci, au revoir !",
      "Bonne journée !",
      "Auf Wiederhören!",
      "Tschüss und einen schönen Tag.",
      "Tchau, até logo!",
      "Arrivederci, buona giornata!",
      "До свидания! Всего доброго.",
      "До побачення!",
      "धन्यवाद, अलविदा!",
      "ありがとうございました。失礼いたします。",
      "안녕히 계세요.",
      "好的，再见！",
      "مع السلامة",
      "شكراً لاتصالك، مع السلامة.",
    ];
    for (const line of lines) expect(saysGoodbye(line), line).toBe(true);
  });

  it("doesn't take a wait, a thank-you or a task for a goodbye", () => {
    const lines = [
      "One moment.",
      "Okay.",
      "You're welcome!",
      "Okay, getting that.",
      "We'll take care of that for you.",
      "Stand by, please.",
      "We'll see you on Tuesday at ten.",
      "Ciao! How can I help?",
      "Salut, comment puis-je vous aider ?",
      "Un momento, por favor.",
      "Un instant, s'il vous plaît.",
      "Я сейчас проверю, пока подождите.",
      "少々お待ちください。",
    ];
    for (const line of lines) expect(saysGoodbye(line), line).toBe(false);
  });

  it("needs the word to stand alone where words are written apart", () => {
    expect(saysGoodbye("Maybe, but byelaws differ.")).toBe(false);
    expect(saysGoodbye("The chaos is over.")).toBe(false);
    expect(saysGoodbye("Visit Byers Street.")).toBe(false);
  });
});
