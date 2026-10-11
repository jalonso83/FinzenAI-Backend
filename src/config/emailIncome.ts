/**
 * Ingresos desde correo — flag (kill switch).
 *
 * Hasta ahora la sincronización de correos solo registraba GASTOS: las
 * transferencias recibidas y los depósitos se descartaban a propósito. Con este
 * flag encendido, esos correos pasan a la IA y se registran como INGRESO, salvo
 * las transferencias entre cuentas del propio usuario (no son dinero nuevo).
 *
 * Apagado, la sincronización se comporta exactamente igual que antes.
 *
 * Env vars:
 *   EMAIL_INCOME_ENABLED   = 'true' | 'false'      (default: 'false')
 *   EMAIL_INCOME_WHITELIST = 'userId1,userId2,...'  (default: '') — lo activa para
 *                            esos usuarios aunque el flag global esté apagado
 *                            (dogfood / QA).
 */
function emailIncomeWhitelist(): string[] {
  return (process.env.EMAIL_INCOME_WHITELIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isEmailIncomeEnabled(userId?: string): boolean {
  if (userId && emailIncomeWhitelist().includes(userId)) return true;

  return process.env.EMAIL_INCOME_ENABLED === 'true';
}
