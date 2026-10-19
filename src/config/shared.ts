/**
 * Presupuestos y metas compartidos — flag (kill switch) y constantes.
 *
 * El dueño (Plus o Pro) comparte un presupuesto o una meta suya con hasta 3
 * personas más. Decisiones de producto en
 * presupuestos-y-metas-compartidos-finzen-v2.html, en la raíz del repo.
 *
 * El flag solo controla quién puede INVITAR (y, por lo tanto, quién puede
 * aceptar: la invitación hereda el flag de quien la creó). Leer un compartido
 * que ya existe y recalcularlo funciona siempre; apagar el flag no deja a nadie
 * con datos a medias.
 *
 * Env vars:
 *   SHARED_ENABLED   = 'true' | 'false'      (default: 'false')
 *   SHARED_WHITELIST = 'userId1,userId2,...'  (default: '') — lo activa para
 *                      esos usuarios aunque el flag global esté apagado
 *                      (dogfood / QA).
 */
function sharedWhitelist(): string[] {
  return (process.env.SHARED_WHITELIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isSharedEnabled(userId?: string): boolean {
  if (userId && sharedWhitelist().includes(userId)) return true;

  return process.env.SHARED_ENABLED === 'true';
}

/**
 * Cuántos compartidos (presupuestos y metas juntos) conserva activos quien
 * terminó el trial sin pagar. Default 0: se pausan todos, con aviso a los
 * invitados.
 *
 * Es el "disparador escrito" de la v2: si los primeros 30 dueños muestran mucha
 * actividad durante el trial y cero después, se pone en 1 (un presupuesto o una
 * meta compartida sin pagar) sin sacar versión de la app. Conserva los primeros
 * que compartió; no le deja compartir nada nuevo.
 *
 * Env: SHARED_TRIAL_KEEP (entero, 0–10)
 */
export function compartidosQueConservaTrasElTrial(): number {
  const crudo = parseInt(process.env.SHARED_TRIAL_KEEP || '', 10);
  if (!Number.isFinite(crudo)) return 0;
  return Math.max(0, Math.min(10, crudo));
}

/** Personas por presupuesto o meta, contando al dueño. */
export const SHARED_MAX_MEMBERS = 4;

/** Días que vale una invitación. */
export const SHARED_INVITE_TTL_DAYS = 7;

/**
 * Alfabeto del código de invitación: sin 0/O, 1/I/L, que se confunden al
 * dictarlo o copiarlo de un mensaje.
 */
export const SHARED_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const SHARED_CODE_LENGTH = 6;

/** Enlace que se manda por WhatsApp. La página de la landing abre la app. */
export function sharedInviteLink(code: string): string {
  const base = process.env.SHARED_INVITE_BASE_URL || 'https://www.finzenai.com/invite';
  return `${base}/${code}`;
}
