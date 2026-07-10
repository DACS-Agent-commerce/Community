/**
 * Serialize JSON-LD for a <script type="application/ld+json"> element.
 *
 * JSON.stringify escapes quotes and backslashes but NOT `<`. Listing titles,
 * descriptions, and seller display names are seller-controlled (the listing
 * signature proves ownership, not content safety), so a value containing
 * `</script>` would terminate the script element early and inject live markup
 * into the page (stored XSS). Escaping every `<` as the JSON sequence
 * backslash-u003c closes that hole — including `</script>` and `<!--` breakout
 * variants — while JSON.parse still yields byte-identical data for consumers.
 * (JSON-LD blocks are data, not executed script, so no JS-specific escapes
 * are needed beyond this.)
 */
export const safeJsonLd = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, "\\u003c");
