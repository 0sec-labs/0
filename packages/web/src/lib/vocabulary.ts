/**
 * Single source of truth for the product nouns shown to users.
 * Change a word here and every vocabulary-derived string follows.
 * Code identifiers, routes, storage keys and API paths keep their stable names.
 */
export const VOCAB = {
  mission: { singular: "mission", plural: "missions", Singular: "Mission", Plural: "Missions" },
  sentinel: { singular: "sentinel", plural: "sentinels", Singular: "Sentinel", Plural: "Sentinels" },
} as const;

type Noun = { readonly singular: string; readonly plural: string; readonly Singular: string; readonly Plural: string };

const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function nounTokens(name: string, noun: Noun): Record<string, string> {
  return {
    [name]: noun.singular,
    [`${name}s`]: noun.plural,
    [capitalize(name)]: noun.Singular,
    [`${capitalize(name)}s`]: noun.Plural,
    [`a ${name}`]: `${article(noun.singular)} ${noun.singular}`,
    [`A ${name}`]: capitalize(`${article(noun.singular)} ${noun.singular}`),
  };
}

const TOKENS: Record<string, string> = { ...nounTokens("mission", VOCAB.mission), ...nounTokens("sentinel", VOCAB.sentinel) };

/** Expand `{mission}`, `{missions}`, `{Mission}`, `{Missions}`, `{a mission}` (and the sentinel equivalents). */
export function v(template: string): string {
  return template.replace(/\{([^{}]+)\}/g, (whole, key: string) => TOKENS[key] ?? whole);
}

export const newMission = v("New {mission}");
export const missionLabel = VOCAB.mission.Singular;

/** Titles stored before the rename; still treated as "untitled". */
export const LEGACY_NEW_CHAT_TITLE = "New chat";
export const isBlankMissionTitle = (title: string | undefined | null) =>
  !title || title === newMission || title === LEGACY_NEW_CHAT_TITLE;
