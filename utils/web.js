// What a search box does with typed text: something that looks like an address opens as one, anything
// else is searched on Google. Used by the switcher's search box and the command palette.

/** A Google search for `text`. */
export const googleUrl = (text) => 'https://www.google.com/search?q=' + encodeURIComponent(text);

/** The address `s` stands for ("example.com" -> "https://example.com"), or null if it doesn't look like one. */
export function asUrl(text) {
  if (!text || /\s/.test(text)) return null;
  if (/^[a-z][\w+.-]*:\/\//i.test(text)) return text;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/.*)?$/i.test(text)) return 'http://' + text;
  if (/^[\w-]+(\.[\w-]+)*\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(text)) return 'https://' + text;
  return null;
}
