/**
 * ─── "Meta" nunca es un presupuesto de ingresos ──────────────────────────────
 *
 * Son dos objetos distintos del producto y la gente los confunde porque durante
 * mucho tiempo los confundimos nosotros: la app llamaba "Meta de ingresos" a un
 * presupuesto de tipo INCOME, y la descripción de la herramienta de Zenio ponía
 * como ejemplo "mi meta de salario es 50 mil". Con eso, pedir "una meta de
 * ingresos" creaba un presupuesto, y quien quería una META DE AHORRO acababa
 * con un presupuesto que no se parecía en nada a lo que pidió.
 *
 * La regla, decidida con el socio: la palabra "meta" pertenece a las metas de
 * ahorro. Un presupuesto de ingresos se crea cuando la persona lo pide por su
 * nombre o describe facturación sin ambigüedad.
 *
 * Esta comprobación vive en código y no solo en el prompt a propósito: un prompt
 * se puede reescribir, un modelo se puede actualizar y la instrucción se diluye.
 * Aquí es determinista y se puede probar.
 */

const PALABRAS_DE_META = /\b(met(a|as)|objetivos?|ahorr\w*)\b/i;
const DICE_PRESUPUESTO = /\bpresupuesto?s?\b/i;

export interface VeredictoIngresos {
  /** ¿Se puede crear el presupuesto de ingresos con este mensaje? */
  permitido: boolean;
  /** Qué preguntarle si no. */
  pregunta?: string;
}

/**
 * Decide si un mensaje justifica crear un presupuesto de INGRESOS.
 *
 * Regla intermedia (la elegida): lo que bloquea es la AMBIGÜEDAD de "meta", no
 * la intención clara de facturar.
 *
 *   "mi meta de ingresos es 80 mil"        → bloquea y pregunta
 *   "quiero facturar 80 mil este mes"      → permite (no dice "meta")
 *   "presupuesto de ingresos de 80 mil"    → permite (lo pidió por su nombre)
 *   "meta de ahorro para el carro"         → bloquea (además es una meta real)
 *
 * La excepción de `DICE_PRESUPUESTO` existe porque "quiero un presupuesto de
 * ingresos, mi meta es 80 mil" es una petición explícita: la persona ya nombró
 * el objeto y "meta" ahí es solo la cifra que persigue.
 */
export function puedeCrearPresupuestoDeIngresos(mensaje?: string | null): VeredictoIngresos {
  if (!mensaje) return { permitido: true }; // sin texto no hay ambigüedad que resolver

  const hablaDeMeta = PALABRAS_DE_META.test(mensaje);
  if (!hablaDeMeta) return { permitido: true };

  if (DICE_PRESUPUESTO.test(mensaje)) return { permitido: true };

  return {
    permitido: false,
    pregunta:
      'Para no equivocarme: ¿quieres un **presupuesto de ingresos** (para seguir cuánto ' +
      'llevas facturado o cobrado en el período) o una **meta de ahorro** (juntar una ' +
      'cantidad para algo concreto)? Son cosas distintas y no quiero crearte la que no es.',
  };
}
