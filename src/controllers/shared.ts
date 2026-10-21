import { Request, Response } from 'express';
import { logger } from '../utils/logger';
import * as shared from '../services/sharedService';
import { SharedError } from '../services/sharedService';
import * as sharedGoals from '../services/sharedGoalService';

/**
 * Presupuestos compartidos. La lógica vive en services/sharedService.ts; aquí
 * solo se traduce a HTTP. Los errores esperados salen como
 * `{ error: CODIGO, message: texto para el usuario, ...extra }` con su status.
 */
function manejar(res: Response, error: unknown, contexto: string) {
  if (error instanceof SharedError) {
    return res.status(error.status).json({ error: error.code, message: error.message, ...error.extra });
  }
  logger.error(`[Shared] ${contexto}:`, error);
  return res.status(500).json({ error: 'Internal server error', message: 'Algo salió mal. Intenta de nuevo.' });
}

export const invitarPresupuesto = async (req: Request, res: Response) => {
  try {
    return res.status(201).json(await shared.invitarAPresupuesto(req.user!.id, req.params.budgetId));
  } catch (error) {
    return manejar(res, error, 'invitar a presupuesto');
  }
};

export const verInvitacion = async (req: Request, res: Response) => {
  try {
    return res.json(await shared.verInvitacion(req.params.code, req.user!.id));
  } catch (error) {
    return manejar(res, error, 'ver invitación');
  }
};

/** Sin sesión: lo usa la página pública de la invitación. */
export const vistaPublicaInvitacion = async (req: Request, res: Response) => {
  try {
    res.set('Cache-Control', 'public, max-age=60');
    return res.json(await shared.vistaPublicaInvitacion(req.params.code));
  } catch (error) {
    return manejar(res, error, 'vista pública de invitación');
  }
};

export const aceptarInvitacion = async (req: Request, res: Response) => {
  try {
    return res.json(await shared.aceptarInvitacion(req.params.code, req.user!.id));
  } catch (error) {
    return manejar(res, error, 'aceptar invitación');
  }
};

export const invitacionPendiente = async (req: Request, res: Response) => {
  try {
    return res.json({ invitacion: await shared.invitacionPendiente(req.user!.id) });
  } catch (error) {
    return manejar(res, error, 'invitación pendiente');
  }
};

export const descartarInvitacionPendiente = async (req: Request, res: Response) => {
  try {
    await shared.descartarInvitacionPendiente(req.user!.id);
    return res.json({ ok: true });
  } catch (error) {
    return manejar(res, error, 'descartar invitación pendiente');
  }
};

export const compartidosConmigo = async (req: Request, res: Response) => {
  try {
    return res.json({ compartidos: await shared.compartidosConmigo(req.user!.id) });
  } catch (error) {
    return manejar(res, error, 'compartidos conmigo');
  }
};

export const detallePresupuesto = async (req: Request, res: Response) => {
  try {
    return res.json(await shared.detallePresupuestoCompartido(req.params.budgetId, req.user!.id));
  } catch (error) {
    return manejar(res, error, 'detalle de presupuesto compartido');
  }
};

export const salir = async (req: Request, res: Response) => {
  try {
    // En metas dice cuánto había aportado y si puede pasarlo a una meta personal.
    return res.json({ ok: true, ...(await shared.salirDeCompartido(req.params.groupId, req.user!.id)) });
  } catch (error) {
    return manejar(res, error, 'salir de compartido');
  }
};

export const quitarMiembro = async (req: Request, res: Response) => {
  try {
    await shared.quitarMiembro(req.params.groupId, req.user!.id, req.params.userId);
    return res.json({ ok: true });
  } catch (error) {
    return manejar(res, error, 'quitar miembro');
  }
};

export const dejarDeCompartir = async (req: Request, res: Response) => {
  try {
    await shared.dejarDeCompartir(req.params.groupId, req.user!.id);
    return res.json({ ok: true });
  } catch (error) {
    return manejar(res, error, 'dejar de compartir');
  }
};

export const porConfirmar = async (req: Request, res: Response) => {
  try {
    return res.json({ gastos: await shared.porConfirmarDe(req.user!.id) });
  } catch (error) {
    return manejar(res, error, 'gastos por confirmar');
  }
};

export const confirmarGasto = async (req: Request, res: Response) => {
  try {
    await shared.confirmarGasto(req.params.transactionId, req.user!.id);
    return res.json({ ok: true });
  } catch (error) {
    return manejar(res, error, 'confirmar gasto');
  }
};

export const sacarDelCompartido = async (req: Request, res: Response) => {
  try {
    await shared.sacarDelCompartido(req.params.transactionId, req.user!.id);
    return res.json({ ok: true });
  } catch (error) {
    return manejar(res, error, 'sacar gasto del compartido');
  }
};

export const volverAContar = async (req: Request, res: Response) => {
  try {
    await shared.volverAContar(req.params.transactionId, req.user!.id);
    return res.json({ ok: true });
  } catch (error) {
    return manejar(res, error, 'volver a contar gasto');
  }
};

export const compartidoDeCategoria = async (req: Request, res: Response) => {
  try {
    const transactionId = typeof req.query.transactionId === 'string' ? req.query.transactionId : undefined;
    return res.json({ compartido: await shared.compartidoDeCategoria(req.user!.id, req.params.categoryId, transactionId) });
  } catch (error) {
    return manejar(res, error, 'compartido de categoría');
  }
};

export const resumenDeDueno = async (req: Request, res: Response) => {
  try {
    return res.json({ compartidos: await shared.resumenDeDueno(req.user!.id) });
  } catch (error) {
    return manejar(res, error, 'resumen de compartidos del dueño');
  }
};

// ─── Metas compartidas (services/sharedGoalService.ts) ───────────────────────

export const invitarMeta = async (req: Request, res: Response) => {
  try {
    return res.status(201).json(await sharedGoals.invitarAMeta(req.user!.id, req.params.goalId));
  } catch (error) {
    return manejar(res, error, 'invitar a meta');
  }
};

export const metasCompartidasConmigo = async (req: Request, res: Response) => {
  try {
    return res.json({ compartidas: await sharedGoals.metasCompartidasConmigo(req.user!.id) });
  } catch (error) {
    return manejar(res, error, 'metas compartidas conmigo');
  }
};

export const detalleMeta = async (req: Request, res: Response) => {
  try {
    return res.json(await sharedGoals.detalleMetaCompartida(req.params.goalId, req.user!.id));
  } catch (error) {
    return manejar(res, error, 'detalle de meta compartida');
  }
};

export const quitarAportesDeExMiembro = async (req: Request, res: Response) => {
  try {
    return res.json(await sharedGoals.quitarAportesDeExMiembro(req.params.goalId, req.user!.id, req.params.userId));
  } catch (error) {
    return manejar(res, error, 'quitar aportes de ex miembro');
  }
};

export const convertirAportes = async (req: Request, res: Response) => {
  try {
    return res.status(201).json({ goal: await sharedGoals.convertirAportesEnMetaPersonal(req.params.groupId, req.user!.id) });
  } catch (error) {
    return manejar(res, error, 'convertir aportes en meta personal');
  }
};

export const aportesConvertibles = async (req: Request, res: Response) => {
  try {
    return res.json({ convertibles: await sharedGoals.aportesConvertibles(req.user!.id) });
  } catch (error) {
    return manejar(res, error, 'aportes convertibles');
  }
};
