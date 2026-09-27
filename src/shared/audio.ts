/** Audio summaries: what the settings and the paper page need to know. */

/** Gemini's voices (https://ai.google.dev/gemini-api/docs/speech-generation), with their character. */
export const GEMINI_VOICES: { name: string; style: string }[] = [
  ['Zephyr', 'Bright'],
  ['Puck', 'Upbeat'],
  ['Charon', 'Informative'],
  ['Kore', 'Firm'],
  ['Fenrir', 'Excitable'],
  ['Leda', 'Youthful'],
  ['Orus', 'Firm'],
  ['Aoede', 'Breezy'],
  ['Callirrhoe', 'Easy-going'],
  ['Autonoe', 'Bright'],
  ['Enceladus', 'Breathy'],
  ['Iapetus', 'Clear'],
  ['Umbriel', 'Easy-going'],
  ['Algieba', 'Smooth'],
  ['Despina', 'Smooth'],
  ['Erinome', 'Clear'],
  ['Algenib', 'Gravelly'],
  ['Rasalgethi', 'Informative'],
  ['Laomedeia', 'Upbeat'],
  ['Achernar', 'Soft'],
  ['Alnilam', 'Firm'],
  ['Schedar', 'Even'],
  ['Gacrux', 'Mature'],
  ['Pulcherrima', 'Forward'],
  ['Achird', 'Friendly'],
  ['Zubenelgenubi', 'Casual'],
  ['Vindemiatrix', 'Gentle'],
  ['Sadachbia', 'Lively'],
  ['Sadaltager', 'Knowledgeable'],
  ['Sulafat', 'Warm'],
].map(([name, style]) => ({ name, style }));

/** The hosts' voices by default (Gemini), and their names in the conversation. */
export const DEFAULT_GEMINI_VOICES: [string, string] = ['Charon', 'Aoede'];
export const GEMINI_HOST_NAMES: [string, string] = ['Alex', 'Sam'];

/** Languages offered for the conversation (Gemini speaks many more). */
export const AUDIO_LANGUAGES = [
  'English',
  'French',
  'German',
  'Spanish',
  'Italian',
  'Portuguese',
  'Dutch',
  'Japanese',
  'Chinese',
  'Korean',
];
