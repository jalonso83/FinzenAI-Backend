/**
 * ─── Red de seguridad: que nunca se le enseñe JSON al usuario ────────────────
 *
 * El agente operativo trabaja con PREVIEW: muestra un resumen, espera el "sí" y
 * ENTONCES llama la función. Esa instrucción —"no llames la función todavía"— le
 * sale a veces por la culata: en vez de esperar, escribe la llamada que pensaba
 * hacer dentro del mensaje. Al usuario le aparece en pantalla algo así:
 *
 *   ¿Confirmo?```json
 *   {"operation":"insert","goal_data":{"name":"Salario","target_amount":50000,...}}
 *
 * y parece que la app reventó. Visto en producción el 12-ago-2026.
 *
 * El prompt ya lo prohíbe explícitamente, pero un prompt es una petición, no una
 * garantía: basta con que cambie el modelo para que reaparezca. Esto lo corta
 * antes de que salga por la API, cueste lo que cueste el prompt.
 */

/** Bloque cercado ```…``` (con o sin etiqueta de lenguaje). */
const BLOQUE_CERCADO = /```[a-zA-Z]*\s*[\s\S]*?```/g;
/** Bloque cercado que quedó ABIERTO — el caso de la captura: nunca se cerró. */
const BLOQUE_SIN_CERRAR = /```[a-zA-Z]*\s*[\s\S]*$/;
/** Objeto JSON suelto que empieza por una clave nuestra, sin las comillas. */
const JSON_SUELTO = /\{\s*"(operation|goal_data|budget_data|transaction_data|filtros_busqueda|criterios_identificacion)"[\s\S]*$/;

/**
 * Quita de la respuesta visible cualquier JSON o bloque de código.
 *
 * No intenta "arreglar" el mensaje ni inventar texto: solo recorta lo técnico y
 * deja lo que el agente escribió en español. Si al recortar no queda nada útil,
 * devuelve una frase neutral en vez de un mensaje vacío, que en la app se ve
 * como una burbuja en blanco.
 */
export function limpiarRespuestaZenio(texto: string): string {
  if (!texto) return texto;

  let limpio = texto
    .replace(BLOQUE_CERCADO, '')
    .replace(BLOQUE_SIN_CERRAR, '')
    .replace(JSON_SUELTO, '');

  // Espacios y saltos que quedan colgando donde estaba el bloque.
  limpio = limpio.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  if (limpio.length === 0) {
    return 'Perdona, se me enredó la respuesta. ¿Me lo repites?';
  }

  return limpio;
}

/** Para poder registrar cuándo pasa sin tener que adivinarlo por los reportes. */
export function contieneJsonVisible(texto: string): boolean {
  if (!texto) return false;
  return /```/.test(texto) || JSON_SUELTO.test(texto);
}
