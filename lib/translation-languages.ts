export const TRANSLATION_LANGUAGE_OPTIONS = [
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "it", label: "Italian" },
  { value: "de", label: "German" },
] as const;

export type TranslationLanguage = (typeof TRANSLATION_LANGUAGE_OPTIONS)[number]["value"];

export const DEFAULT_TRANSLATION_LANGUAGE: TranslationLanguage = "es";

const TRANSLATION_LANGUAGE_CONFIG: Record<TranslationLanguage, { label: string }> = {
  es: { label: "Spanish" },
  fr: { label: "French" },
  it: { label: "Italian" },
  de: { label: "German" },
};

export function isTranslationLanguage(value: string | null | undefined): value is TranslationLanguage {
  return typeof value === "string" && value in TRANSLATION_LANGUAGE_CONFIG;
}

export function getTranslationLanguageConfig(value: string | null | undefined) {
  const code = isTranslationLanguage(value) ? value : DEFAULT_TRANSLATION_LANGUAGE;

  return {
    code,
    ...TRANSLATION_LANGUAGE_CONFIG[code],
  };
}

export function buildRealtimeTranslationSessionInstructions(languageLabel: string) {
  return `Translate English text into natural ${languageLabel} for live video dubbing. Respond only with the ${languageLabel} translation, keep it concise, and finish the full phrase before stopping.`;
}

export function buildRealtimeTranslationResponseInstructions(languageLabel: string) {
  return `Translate the provided English phrase into natural ${languageLabel} for live dubbing. Respond only with the ${languageLabel} translation. Keep the wording compact, and finish the full phrase before stopping.`;
}

export function buildTextTranslationInstructions(languageLabel: string) {
  return `Translate the user's English video transcript into natural ${languageLabel} for voice dubbing. Return only the ${languageLabel} translation text, with no commentary, no quotes, and no source-language text.`;
}

export function buildSpeechInstructions(languageLabel: string) {
  return `Speak in clear, natural ${languageLabel}. Finish the entire phrase completely, without truncating the ending.`;
}
