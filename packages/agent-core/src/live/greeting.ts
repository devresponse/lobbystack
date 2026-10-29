/**
 * The command that makes GPT-Live open the call with the business greeting.
 * GPT-Live waits for the caller by default. In tests against the API this
 * wording, placed in the session's starting history, made it greet about 2
 * seconds in every time; a command appended after session.started was often
 * ignored, and the shorter "Greet the caller now in <language>" wording failed
 * in the starting history.
 */
export function greetingCommand(greeting: string): string {
  return `Start the conversation now: say exactly "${greeting}" in the language of that greeting, then stop and listen to the caller.`;
}

/**
 * The command for a call whose starting history has the opening as already
 * said, when the caller spoke before its recording could play: GPT-Live
 * would otherwise answer them without it, and without the notice that the
 * call is with an AI and recorded. OpenAI's guide gives this wording for a
 * disclosure that has to be said in full before the model answers the caller.
 */
export function openingAfterCallerCommand(opening: string): string {
  return `The caller spoke before hearing the call's opening. Immediately say the following exactly and in full, in the language it's written in, before responding to the caller: ${opening}`;
}
