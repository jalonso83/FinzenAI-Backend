/**
 * HTML de un correo → texto plano, para poder buscar palabras clave en él.
 *
 * ─── Por qué existe (unificación, 2026-08-09) ────────────────────────────────
 *
 * Antes había una copia de esto en gmailService y otra en outlookService, y NO
 * hacían lo mismo: la de Outlook decodificaba entidades HTML y la de Gmail no.
 *
 * Los bancos maquetan sus correos con tablas y usan `&nbsp;` a montones para que
 * los montos, las fechas y los nombres de producto no se partan en dos líneas.
 * Sin decodificar, un cuerpo con `Retiro&nbsp;de&nbsp;efectivo` quedaba como
 * `retiro&nbsp;de&nbsp;efectivo`, que NO contiene la frase "retiro de efectivo".
 *
 * Eso evadía los TRES filtros de emailParserService a la vez, porque todas sus
 * frases son de varias palabras:
 *   - PAYMENT_KEYWORDS         → el pago de la tarjeta se registraba como gasto
 *   - DECLINED_KEYWORDS        → un consumo declinado inflaba el gasto
 *   - CASH_WITHDRAWAL_KEYWORDS → el retiro entraba como gasto
 *
 * Y afectaba justo a la mayoría de los usuarios, porque Gmail es el proveedor
 * dominante. Pasaba desapercibido porque el prompt de la IA repite esas reglas y
 * a veces atrapaba el correo igual — de ahí el clásico "a veces lo toma como
 * gasto y a veces no".
 */

/**
 * Decodifica las entidades HTML habituales en correos.
 *
 * OJO CON EL ORDEN: `&amp;` va AL FINAL. Si se decodificara primero, un
 * `&amp;nbsp;` escrito a propósito por el banco se convertiría en `&nbsp;` y la
 * pasada siguiente lo volvería un espacio — decodificando dos veces algo que era
 * texto literal. No reordenar esta lista.
 */
function decodeEntities(texto: string): string {
  return texto
    // Numéricas primero: muchos generadores emiten `&#160;` o `&#xA0;` en vez de
    // `&nbsp;`, y si no se tratan aquí sobreviven igual que sobrevivían antes.
    .replace(/&#(\d+);/g, (_, dec: string) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&aacute;/gi, 'á')
    .replace(/&eacute;/gi, 'é')
    .replace(/&iacute;/gi, 'í')
    .replace(/&oacute;/gi, 'ó')
    .replace(/&uacute;/gi, 'ú')
    .replace(/&ntilde;/gi, 'ñ')
    .replace(/&Ntilde;/g, 'Ñ')
    // Siempre la última (ver nota de arriba).
    .replace(/&amp;/gi, '&');
}

/** Un código inválido no debe reventar el parseo de un correo entero. */
function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ' ';
  try {
    // El espacio duro (160) se normaliza a espacio normal: si no, `\s` de las
    // expresiones regulares no lo colapsa y las frases siguen sin coincidir.
    if (code === 160) return ' ';
    return String.fromCodePoint(code);
  } catch {
    return ' ';
  }
}

/**
 * Convierte el HTML de un correo en texto plano de una sola línea, listo para
 * buscar frases en él. Quita `<style>` y `<script>` con su contenido, cambia
 * cualquier etiqueta por un espacio, decodifica entidades y colapsa los espacios.
 */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  const sinEtiquetas = String(html)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ');

  // Decodificar ANTES de colapsar espacios: así el `&nbsp;` convertido en espacio
  // se funde con los de alrededor y no quedan dobles.
  return decodeEntities(sinEtiquetas).replace(/\s+/g, ' ').trim();
}

export default htmlToText;
