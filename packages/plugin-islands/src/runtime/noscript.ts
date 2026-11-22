/**
 * With scripts off, a placeholder is only a stand-in for an island that will
 * never load. An island with no-JS content (`<noscript>`) says so on its
 * marker (`data-has-noscript`), and this rule hides its placeholders, which are
 * the marker's direct children: `fallback.placeholder` and the children shown
 * as one (`[data-island-placeholder]`).
 *
 * Embed it where scripts-off styles belong, the end of `<head>`:
 *
 *     <noscript><style>...this css...</style></noscript>
 *
 * `!important` because the placeholder wrapper carries an inline
 * `display: contents`, which would otherwise win.
 *
 * With scripts on the `<noscript>` is inert, so the rule never applies and the
 * placeholders show until their islands mount.
 */
export const NOSCRIPT_CSS =
  'vite-island[data-has-noscript]>[data-island-placeholder]{display:none!important}'
