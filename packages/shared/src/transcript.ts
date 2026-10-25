// GPT-Live's transcription marks sounds that aren't words in square brackets,
// such as "[tongue click]", "[laughs]" or "[background noise]". The worker's
// own notes in a phone call's transcript look the same and stay: "[pressed 1]",
// "[pressed a key]" and "[typed a PIN]". A tag goes with the space before it,
// so the words on either side keep one space between them.
const SOUND_TAG = /\s?\[(?!pressed |typed a PIN\])[^[\]]{0,60}\]/g;
// A tag still arriving at the end of a turn, or cut off by the call's end.
const OPEN_SOUND_TAG = /\s?\[(?!pressed |typed a PIN\])[^[\]]{0,60}$/;

/**
 * A call transcript's text without the sounds GPT-Live marks in it, for the
 * widget's captions, the saved transcript and the agent's view of the call.
 */
export function withoutSoundTags(text: string): string {
  return text.replace(SOUND_TAG, "").replace(OPEN_SOUND_TAG, "");
}
