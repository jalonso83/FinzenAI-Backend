/**
 * ─── Perillas del trial ────────────────────────────────────────────────────────
 *
 * Todo lo que define CÓMO se comporta el trial vive aquí y sale de variables de
 * entorno, no de constantes regadas por el código. La razón no es estética: el
 * trial es lo único que empuja hacia el pago y va a haber que moverle los
 * números leyendo cohortes. Si cada ajuste exige tocar código, cada ajuste
 * cuesta un deploy; si además vive dentro de la app, cuesta un ciclo de tienda.
 *
 * Regla que gobierna este archivo: la app NUNCA trae estos valores cocidos por
 * dentro. Los pregunta. Así encender el aterrizaje suave —o cambiar 21 días por
 * 30— es cambiar una variable en Railway, no compilar y esperar a Apple.
 *
 * OJO CON LOS DEFAULTS: son el comportamiento VIEJO (7 días, Plus), no las
 * decisiones nuevas. Es deliberado y sigue la regla del corte: lo que el usuario
 * no ve sale ya; lo que contradice un texto de la app espera al build.
 *
 * Un trial de 21 días en Pro sobre la app actual —que en pantalla dice 7 días y
 * ofrece elegir Plus— crea una cohorte híbrida: recibe una cosa mientras lee
 * otra. Esa gente no se puede medir, y poder medir es el punto entero de este
 * proyecto. Así que este archivo desplegado NO cambia nada; las decisiones D1 y
 * D4 se encienden poniendo las variables el día que salga la app nueva.
 *
 * Contrapartida asumida: si ese día a alguien se le olvidan las variables, el
 * build sale con el trial viejo. Por eso `describirConfigTrial()` se loguea al
 * arrancar — para que el estado activo se vea, en vez de tener que deducirlo.
 */

/** Lee un entero de una env var, acotado a un rango. Vuelve al default si viene basura. */
function enteroDeEntorno(nombre: string, porDefecto: number, min: number, max: number): number {
  const crudo = parseInt(process.env[nombre] || '', 10);
  if (!Number.isFinite(crudo)) return porDefecto;
  return Math.max(min, Math.min(max, crudo));
}

/**
 * D4 — Duración del trial. Pasó de 7 a 21 días.
 *
 * El 7 no daba tiempo: conectar el correo, esperar a que entren compras reales y
 * darse cuenta de que ya no anotas nada a mano no ocurre en una semana.
 *
 * Default 7 = lo de hoy. Se pone en 21 el día del build (ver cabecera).
 *
 * Env: TRIAL_DURATION_DAYS (tope 90)
 */
export function duracionTrialDias(): number {
  return enteroDeEntorno('TRIAL_DURATION_DAYS', 7, 1, 90);
}

/**
 * D1 — Qué plan concede el trial, ignorando el que pida el cliente.
 *
 * Antes la app mandaba PREMIUM o PRO según lo que el usuario tocara en la
 * pantalla. El problema no era que no pudiera elegir Pro —sí podía— sino que la
 * elección existía: quien elegía Plus se quedaba sin Gastos en automático, que
 * es la única función que justifica pagar, y probaba un trial que no le
 * entregaba nada que no tuviera gratis.
 *
 * Devuelve `null` cuando NO hay que forzar nada: ese es el comportamiento de
 * hoy, en el que manda lo que el usuario tocó en la pantalla. Es importante que
 * el default sea `null` y no 'PREMIUM': forzar Plus le quitaría Pro a quien hoy
 * sí lo elige, o sea que "no cambiar nada" y "conceder Plus" no son lo mismo.
 *
 * Se pone en 'PRO' el día del build (ver cabecera).
 *
 * Env: TRIAL_GRANTED_PLAN = 'PRO' | 'PREMIUM' | (sin poner = respeta al cliente)
 */
export function planQueConcedeElTrial(): 'PREMIUM' | 'PRO' | null {
  const v = process.env.TRIAL_GRANTED_PLAN;
  if (v === 'PRO' || v === 'PREMIUM') return v;
  return null;
}

/**
 * Qué conserva el usuario cuando vence el trial — el "aterrizaje suave".
 *
 * Hoy el vencimiento es un apagón: se cae a FREE, se le borra la conexión de
 * correo y vuelve a los topes de siempre. De los 16 que llegaron al vencimiento
 * no sobrevivió ninguno.
 *
 * El aterrizaje suave —dejarle algo por encima de FREE para siempre— NO se
 * lanza junto con el trial nuevo, y es deliberado: si salen el mismo día, no hay
 * forma de saber cuál de los dos hizo qué. Pero queda montado para poder
 * encenderlo desde el servidor el día que la primera cohorte repita el patrón
 * (mucha actividad durante, cero después), sin otro ciclo de tienda.
 *
 * Env:
 *   TRIAL_SOFT_LANDING_ENABLED = 'true' | 'false'  (default 'false' = apagón)
 *   TRIAL_SOFT_LANDING_BUDGETS = entero            (default 6)
 *   TRIAL_SOFT_LANDING_GOALS   = entero            (default 4)
 *   TRIAL_SOFT_LANDING_ZENIO   = entero            (default 25)
 */
export interface AterrizajeTrial {
  /** false = apagón (comportamiento actual). true = conserva los topes de abajo. */
  activo: boolean;
  budgets: number;
  goals: number;
  zenioQueries: number;
}

export function aterrizajeTrial(): AterrizajeTrial {
  return {
    activo: process.env.TRIAL_SOFT_LANDING_ENABLED === 'true',
    budgets: enteroDeEntorno('TRIAL_SOFT_LANDING_BUDGETS', 6, 0, 100),
    goals: enteroDeEntorno('TRIAL_SOFT_LANDING_GOALS', 4, 0, 100),
    zenioQueries: enteroDeEntorno('TRIAL_SOFT_LANDING_ZENIO', 25, 0, 1000),
  };
}

/**
 * ¿El trial arranca solo al registrarse?
 *
 * Hasta ahora no: el usuario nuevo caía en FREE y tenía que ir a buscar el
 * trial en el menú, pasando por la pantalla de planes. Ese rodeo es donde se
 * cae el 95% — de 666 que vieron precios, solo 32 activaron.
 *
 * Con esto, quien se registra ya entra con Pro y los 21 días corriendo, y el
 * slot del dashboard lo lleva directo a conectar el correo sin ver un precio.
 *
 * Va atado a `TRIAL_GRANTED_PLAN` a propósito, sin variable propia: conceder
 * Pro, durar 21 días y arrancar solo son tres piezas del MISMO tratamiento.
 * Separarlas en tres flags permitiría encender media cosa y dejar una cohorte
 * a medio camino, que es justo lo que estamos evitando.
 *
 * Contrapartida asumida: el reloj corre desde el día 1 se use la app o no, y
 * se gasta el trial de quien nunca lo pidió (es uno por persona). A cambio,
 * nadie tiene que cruzar una pantalla de precios para probar el producto.
 */
export function elTrialArrancaSolo(): boolean {
  return planQueConcedeElTrial() != null;
}

/**
 * Cuántos días hacia atrás mira la PRIMERA sincronización del correo.
 *
 * Es el momento "wow" del producto: conectas y aparece tu historial ya anotado.
 * Cuanto más atrás llegue, más lleno se ve el resultado — y más honesto es el
 * titular de la pantalla de éxito, que promete un número.
 *
 * Este SÍ arranca en 90 (antes 30) sin esperar al build, a diferencia del plan y
 * la duración. No contradice ningún texto de la app —ninguna pantalla promete un
 * número de días de historial— así que no crea la cohorte híbrida que obliga a
 * esperar a las otras dos. Solo hace que al conectar entre más.
 *
 * Env: EMAIL_SYNC_FIRST_LOOKBACK_DAYS (default 90, tope 365)
 */
export function historialPrimeraSyncDias(): number {
  return enteroDeEntorno('EMAIL_SYNC_FIRST_LOOKBACK_DAYS', 90, 1, 365);
}

/**
 * Una línea con la configuración activa, para loguear al arrancar.
 *
 * Existe porque los defaults son el comportamiento viejo: si el día del build se
 * olvidan las variables, el trial sale en 7 días y Plus sin que nada falle ni
 * avise. Esto lo pone a la vista en el arranque de Railway en vez de dejar que
 * se descubra tres semanas después leyendo una cohorte que no cuadra.
 */
export function describirConfigTrial(): string {
  const plan = planQueConcedeElTrial();
  const a = aterrizajeTrial();
  return [
    `duración=${duracionTrialDias()}d`,
    `plan=${plan ?? 'el que pida el cliente'}`,
    `arranqueAutomático=${elTrialArrancaSolo() ? 'SÍ (al registrarse)' : 'no (lo activa el usuario)'}`,
    `aterrizajeSuave=${a.activo ? `ON (${a.budgets}p/${a.goals}m/${a.zenioQueries}z)` : 'OFF'}`,
    `historialPrimeraSync=${historialPrimeraSyncDias()}d`,
  ].join(' · ');
}
