/**
 * Elimina los marcadores de citación de `file_search` (OpenAI Responses API)
 * que el modelo inyecta inline cuando usa el vector store.
 *
 * Esos marcadores usan caracteres del Private Use Area (U+E200..U+E2FF) alrededor
 * de tokens como `filecite` y `turn0file12`. En el cliente se ven como basura
 * porque la fuente del dispositivo no tiene glifos para esos code points.
 *
 * Limpia el texto sin tocar el contenido normal (español, números, emojis).
 */

// Rango PUA de los delimitadores de citación. Se construye por código numérico
// (no con escapes literales) para evitar problemas de codificación del archivo.
const CITATION_DELIMITERS = new RegExp(
  `[${String.fromCharCode(0xe200)}-${String.fromCharCode(0xe2ff)}]`,
  'g',
);

export function stripFileCitations(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(CITATION_DELIMITERS, '')       // delimitadores invisibles (PUA)
    .replace(/filecite/gi, '')              // token literal residual
    .replace(/turn\d+file\d+/gi, '')        // token literal residual (turn0file12)
    .replace(/[ \t]{2,}/g, ' ')             // espacios dobles que queden
    .replace(/[ \t]+([.,;:!?])/g, '$1')     // espacio colgando antes de puntuación
    .trim();
}
