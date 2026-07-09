import { Router } from 'express';
import type { Router as ExpressRouter } from 'express';
import { authenticateAdminOrPdfToken } from '../middlewares/adminAuth';
import { strictApiLimiter } from '../config/rateLimiter';
import { getPulse, getUsersAnalytics, getRevenueAnalytics, getEngagement, getUnitEconomics, getFinancialHealth, getUsersList, getDistinctCountries, bulkResendVerification, getAcquisition, generateDashboardPdf, getCampaignCosts, upsertCampaignCost, deleteCampaignCost, setCampaignHidden } from '../controllers/admin';
import { getFeedbackList, updateFeedback } from '../controllers/feedback';
import { createBroadcast, listBroadcasts, previewBroadcast, sendBroadcast, getBroadcastStats, approveBroadcast, rejectBroadcast } from '../controllers/broadcasts';
import { getH10Stats } from '../controllers/experiments';

const router: ExpressRouter = Router();

// All admin routes accept either admin auth (cookie/JWT) or pdfToken (Puppeteer
// during PDF generation). The compound middleware decides at runtime.
router.use(authenticateAdminOrPdfToken);
router.use(strictApiLimiter);

router.get('/pulse', getPulse);
router.get('/users/list', getUsersList);
router.get('/users/countries', getDistinctCountries);
router.get('/users', getUsersAnalytics);
router.get('/revenue', getRevenueAnalytics);
router.get('/engagement', getEngagement);
router.get('/acquisition', getAcquisition);
router.get('/unit-economics', getUnitEconomics);
router.get('/financial-health', getFinancialHealth);
router.post('/users/resend-verification-bulk', bulkResendVerification);

// PDF export (Hito 1: dummy PDF para validar Puppeteer infrastructure)
router.post('/dashboard/pdf', generateDashboardPdf);

// Feedback management
router.get('/feedback', getFeedbackList);
router.patch('/feedback/:id', updateFeedback);

// Broadcasts (notificaciones masivas)
router.get('/broadcasts', listBroadcasts);
router.post('/broadcasts', createBroadcast);
router.post('/broadcasts/preview', previewBroadcast);
router.post('/broadcasts/:id/send', sendBroadcast);
router.post('/broadcasts/:id/approve', approveBroadcast); // agente: PENDING_APPROVAL → DRAFT
router.post('/broadcasts/:id/reject', rejectBroadcast);   // agente: PENDING_APPROVAL → REJECTED
router.get('/broadcasts/:id/stats', getBroadcastStats);

// Experimentos
router.get('/experiments/h10/stats', getH10Stats);

// Campaign costs (manual cost entry per source/campaign — lifetime, no date filter)
router.get('/campaign-costs', getCampaignCosts);
router.put('/campaign-costs', upsertCampaignCost);
router.post('/campaign-costs/hidden', setCampaignHidden);
router.delete('/campaign-costs/:id', deleteCampaignCost);

export default router;
