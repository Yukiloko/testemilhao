/** Accent- and case-insensitive text used for keyword matching in PT-BR profiles. */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

export function matches(haystack: string, needles: string[]): string[] {
  const h = fold(haystack);
  return needles.filter((n) => n.trim() && h.includes(fold(n.trim())));
}
