export const COMMON_LANGUAGES = [
  "en",
  "es",
  "fr",
  "de",
  "it",
  "pt",
  "ru",
  "uk",
  "sr",
  "tr",
  "ar",
  "hi",
  "zh",
  "ja",
  "ko",
];

export function browserLanguage() {
  return navigator.languages?.[0] || navigator.language || "en";
}
