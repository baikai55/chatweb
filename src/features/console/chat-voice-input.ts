const LATIN_OR_NUMBER_AT_END = /[\p{Script=Latin}\p{N}]$/u;
const LATIN_OR_NUMBER_AT_START = /^[\p{Script=Latin}\p{N}]/u;

/** 把迟到的语音转写追加到当前草稿，绝不覆盖用户在识别期间输入的内容。 */
export function appendTranscriptionToDraft(draft: string, transcription: string): string {
  const text = transcription.trim();
  if (!text) return draft;
  if (!draft) return text;
  if (/\s$/u.test(draft)) return `${draft}${text}`;

  const separator = LATIN_OR_NUMBER_AT_END.test(draft) && LATIN_OR_NUMBER_AT_START.test(text)
    ? " "
    : "";
  return `${draft}${separator}${text}`;
}
