-- ============================================================
-- Migration: Marketing Attribution Phase 1
-- Date: 2026-04-27
-- Author: Alonso (CTO)
--
-- IMPORTANTE:
--   - NO modifica la tabla `users` (zero-risk para 297 usuarios)
--   - Crea 2 tablas nuevas con FK hacia users (CASCADE / SET NULL)
--   - Reversible con: DROP TABLE attribution_events; DROP TABLE user_attributions;
--
-- Cómo aplicar (Railway, horario de bajo tráfico):
--   1. Backup automático de Railway (verificar antes)
--   2. psql $DATABASE_URL -f 001_add_marketing_attribution.sql
--   3. O equivalente: pnpm run db:push  (solo si schema.prisma ya está actualizado)
-- ============================================================

BEGIN;

-- ─── Tabla 1: user_attributions (1:1 con users) ────────────
CREATE TABLE "user_attributions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "firstTouchSource" TEXT,
    "firstTouchMedium" TEXT,
    "firstTouchCampaign" TEXT,
    "firstTouchTerm" TEXT,
    "firstTouchContent" TEXT,
    "firstTouchLandingPage" TEXT,
    "firstTouchAt" TIMESTAMP(3),
    "lastTouchSource" TEXT,
    "lastTouchMedium" TEXT,
    "lastTouchCampaign" TEXT,
    "lastTouchAt" TIMESTAMP(3),
    "signupFbclid" TEXT,
    "signupTtclid" TEXT,
    "signupGclid" TEXT,
    "signupIpAddress" TEXT,
    "signupUserAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_attributions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_attributions_userId_key"
    ON "user_attributions"("userId");

CREATE INDEX "user_attributions_firstTouchSource_firstTouchCampaign_idx"
    ON "user_attributions"("firstTouchSource", "firstTouchCampaign");

CREATE INDEX "user_attributions_lastTouchSource_idx"
    ON "user_attributions"("lastTouchSource");

CREATE INDEX "user_attributions_signupFbclid_idx"
    ON "user_attributions"("signupFbclid");

CREATE INDEX "user_attributions_signupTtclid_idx"
    ON "user_attributions"("signupTtclid");

ALTER TABLE "user_attributions"
    ADD CONSTRAINT "user_attributions_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;


-- ─── Tabla 2: attribution_events (log granular) ────────────
CREATE TABLE "attribution_events" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "anonymousId" TEXT,
    "eventName" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventTime" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT,
    "medium" TEXT,
    "campaign" TEXT,
    "fbclid" TEXT,
    "ttclid" TEXT,
    "gclid" TEXT,
    "pageUrl" TEXT,
    "referrerUrl" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "sentToMeta" BOOLEAN NOT NULL DEFAULT false,
    "sentToTiktok" BOOLEAN NOT NULL DEFAULT false,
    "metaResponse" JSONB,
    "tiktokResponse" JSONB,
    "value" DOUBLE PRECISION,
    "currency" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attribution_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "attribution_events_eventId_key"
    ON "attribution_events"("eventId");

CREATE INDEX "attribution_events_userId_eventTime_idx"
    ON "attribution_events"("userId", "eventTime");

CREATE INDEX "attribution_events_anonymousId_eventTime_idx"
    ON "attribution_events"("anonymousId", "eventTime");

CREATE INDEX "attribution_events_eventName_eventTime_idx"
    ON "attribution_events"("eventName", "eventTime");

CREATE INDEX "attribution_events_sentToMeta_eventTime_idx"
    ON "attribution_events"("sentToMeta", "eventTime");

CREATE INDEX "attribution_events_sentToTiktok_eventTime_idx"
    ON "attribution_events"("sentToTiktok", "eventTime");

ALTER TABLE "attribution_events"
    ADD CONSTRAINT "attribution_events_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;


-- ============================================================
-- ROLLBACK (en caso de necesitar revertir):
-- ============================================================
-- BEGIN;
--   DROP TABLE IF EXISTS "attribution_events";
--   DROP TABLE IF EXISTS "user_attributions";
-- COMMIT;
