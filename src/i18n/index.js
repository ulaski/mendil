import en from './en.js';
import tr from './tr.js';

export const LANGUAGES = { en, tr };

function format(template, vars) {
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match));
}

function lookup(dict, key) {
  return key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), dict);
}

/**
 * Returns a translator for `language`, falling back to English for unknown
 * languages and for keys a translation doesn't define.
 */
export function createI18n(language = 'en', defaults = {}) {
  const dict = LANGUAGES[language] ?? en;
  const t = (key, vars = {}) => {
    const value = lookup(dict, key) ?? lookup(en, key) ?? key;
    return typeof value === 'string' ? format(value, { ...defaults, ...vars }) : value;
  };
  return {
    language: LANGUAGES[language] ? language : 'en',
    t,
    commandAliases: dict.commandAliases ?? {},
    loopAliases: dict.loopAliases ?? {},
  };
}
