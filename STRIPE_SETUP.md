# Configuración de Stripe - FinZen AI Backend

## ✅ Implementación Completada

Se ha implementado completamente el sistema de suscripciones y pagos con Stripe en el backend.

---

## 📋 Tabla de Contenidos

1. [Archivos Creados](#archivos-creados)
2. [Configuración de Stripe](#configuración-de-stripe)
3. [Variables de Entorno](#variables-de-entorno)
4. [Endpoints Disponibles](#endpoints-disponibles)
5. [Webhooks](#webhooks)
6. [Middleware de Límites](#middleware-de-límites)
7. [Planes Disponibles](#planes-disponibles)
8. [Testing](#testing)

---

## 📁 Archivos Creados

### Modelos de Base de Datos
- `prisma/schema.prisma` - Modelos Subscription y Payment agregados

### Configuración
- `src/config/stripe.ts` - Configuración de Stripe y definición de planes

### Servicios
- `src/services/stripeService.ts` - Métodos para interactuar con Stripe API
- `src/services/subscriptionService.ts` - Lógica de negocio de suscripciones

### Controladores
- `src/controllers/subscriptions.ts` - Endpoints de suscripciones

### Webhooks
- `src/webhooks/stripeWebhook.ts` - Handler de eventos de Stripe

### Middleware
- `src/middleware/planLimits.ts` - Verificación de límites por plan

### Rutas
- `src/routes/subscriptions.ts` - Rutas de API

---

## 🔧 Configuración de Stripe

### 1. Crear cuenta en Stripe

1. Ve a [stripe.com](https://stripe.com)
2. Crea una cuenta o inicia sesión
3. Activa el modo de prueba (Test Mode)

### 2. Crear Productos y Precios

#### Producto Premium ($9.99/mes)

1. Ve a **Products** > **Add Product**
2. Nombre: `FinZen Premium`
3. Descripción: `Plan Premium con presupuestos y metas ilimitados`
4. Pricing:
   - Type: `Recurring`
   - Price: `$9.99`
   - Billing period: `Monthly`
5. Guarda y copia el **Price ID** (comienza con `price_`)

#### Producto Pro ($19.99/mes)

1. Ve a **Products** > **Add Product**
2. Nombre: `FinZen Pro`
3. Descripción: `Plan Pro con todas las features avanzadas`
4. Pricing:
   - Type: `Recurring`
   - Price: `$19.99`
   - Billing period: `Monthly`
5. Guarda y copia el **Price ID**

### 3. Configurar Webhook

1. Ve a **Developers** > **Webhooks**
2. Click **Add endpoint**
3. Endpoint URL: `https://tu-dominio.com/webhooks/stripe`
4. Description: `FinZen AI Webhook`
5. Events to send: Selecciona estos eventos:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_succeeded`
   - `invoice.payment_failed`
   - `customer.subscription.trial_will_end`
6. Guarda y copia el **Signing secret** (comienza con `whsec_`)

### 4. Obtener API Keys

1. Ve a **Developers** > **API keys**
2. Copia la **Secret key** (comienza con `sk_test_`)

---

## 🔐 Variables de Entorno

Agrega estas variables a tu archivo `.env`:

```env
# Stripe Configuration
STRIPE_SECRET_KEY=sk_test_tu_clave_secreta_aqui
STRIPE_WEBHOOK_SECRET=whsec_tu_webhook_secret_aqui
STRIPE_PREMIUM_PRICE_ID=price_premium_id_aqui
STRIPE_PRO_PRICE_ID=price_pro_id_aqui

# Frontend URL (para redirecciones)
FRONTEND_URL=https://tu-dominio.com
```

---

## 🔌 Endpoints Disponibles

### Públicos

#### GET /api/subscriptions/plans
Obtiene todos los planes disponibles.

**Response:**
```json
{
  "plans": [
    {
      "id": "FREE",
      "name": "Free",
      "price": 0,
      "limits": { ... },
      "features": [ ... ]
    },
    ...
  ]
}
```

### Privados (requieren autenticación)

#### POST /api/subscriptions/checkout
Crear sesión de checkout para upgrade.

**Body:**
```json
{
  "plan": "PREMIUM" // o "PRO"
}
```

**Response:**
```json
{
  "url": "https://checkout.stripe.com/...",
  "sessionId": "cs_test_..."
}
```

#### GET /api/subscriptions/current
Obtener suscripción actual del usuario.

**Response:**
```json
{
  "id": "...",
  "userId": "...",
  "plan": "PREMIUM",
  "status": "ACTIVE",
  "limits": {
    "budgets": -1,
    "goals": -1,
    "zenioQueries": -1
  },
  "features": [ ... ],
  "currentPeriodEnd": "2024-12-01T00:00:00.000Z"
}
```

#### POST /api/subscriptions/cancel
Cancelar suscripción (al final del período).

**Response:**
```json
{
  "message": "Suscripción cancelada. Tendrás acceso hasta el final del período de facturación.",
  "cancelAtPeriodEnd": true,
  "currentPeriodEnd": "2024-12-01T00:00:00.000Z"
}
```

#### POST /api/subscriptions/reactivate
Reactivar suscripción cancelada.

**Response:**
```json
{
  "message": "Suscripción reactivada exitosamente",
  "cancelAtPeriodEnd": false
}
```

#### POST /api/subscriptions/customer-portal
Crear sesión del portal de cliente de Stripe.

**Response:**
```json
{
  "url": "https://billing.stripe.com/..."
}
```

#### POST /api/subscriptions/change-plan
Cambiar de plan.

**Body:**
```json
{
  "newPlan": "PRO"
}
```

#### GET /api/subscriptions/payments?limit=10
Obtener historial de pagos.

**Response:**
```json
{
  "payments": [
    {
      "id": "...",
      "amount": 9.99,
      "currency": "usd",
      "status": "SUCCEEDED",
      "createdAt": "..."
    }
  ]
}
```

---

## 🔔 Webhooks

El endpoint `/webhooks/stripe` maneja estos eventos:

### checkout.session.completed
Se ejecuta cuando un usuario completa el checkout.
- Crea o actualiza la suscripción en la BD
- Activa el nuevo plan

### customer.subscription.updated
Se ejecuta cuando cambia la suscripción (renovación, cambio de plan, etc).
- Actualiza datos de la suscripción
- Actualiza fechas de período

### customer.subscription.deleted
Se ejecuta cuando se cancela una suscripción.
- Degrada al usuario a plan FREE

### invoice.payment_succeeded
Se ejecuta cuando un pago es exitoso.
- Registra el pago en la BD
- Activa la suscripción

### invoice.payment_failed
Se ejecuta cuando falla un pago.
- Registra el pago fallido
- Marca suscripción como PAST_DUE

### customer.subscription.trial_will_end
Se ejecuta 3 días antes de que termine el trial.
- Ideal para enviar email de recordatorio

---

## 🛡️ Middleware de Límites

Usa estos middleware en tus rutas para aplicar límites por plan:

```typescript
import {
  checkBudgetLimit,
  checkGoalLimit,
  checkZenioLimit,
  checkAdvancedReports,
  checkExportData,
  requirePlan
} from './middleware/planLimits';

// Ejemplo en rutas de presupuestos
router.post('/budgets', auth, checkBudgetLimit, createBudget);

// Ejemplo en rutas de metas
router.post('/goals', auth, checkGoalLimit, createGoal);

// Ejemplo en Zenio
router.post('/zenio/ask', auth, checkZenioLimit, askZenio);

// Ejemplo requiriendo plan específico
router.get('/reports/advanced', auth, requirePlan('PREMIUM'), getAdvancedReport);
```

---

## 📊 Planes Disponibles

### FREE
- **Precio**: $0/mes
- **Presupuestos**: 3
- **Metas**: 2
- **Zenio**: 10 consultas/mes
- **Reportes avanzados**: ❌
- **Exportar datos**: ❌

### PREMIUM
- **Precio**: $9.99/mes
- **Presupuestos**: Ilimitados
- **Metas**: Ilimitadas
- **Zenio**: Ilimitado
- **Reportes avanzados**: ✅
- **Exportar datos**: ✅
- **Trial**: 7 días gratis

### PRO
- **Precio**: $19.99/mes
- **Presupuestos**: Ilimitados
- **Metas**: Ilimitadas
- **Zenio**: Ilimitado
- **Reportes avanzados**: ✅
- **Exportar datos**: ✅
- **Múltiples carteras**: ✅
- **Integración bancaria**: ✅
- **Soporte prioritario**: ✅
- **Trial**: 7 días gratis

---

## 🧪 Testing

### Tarjetas de Prueba de Stripe

- **Pago exitoso**: `4242 4242 4242 4242`
- **Pago requiere autenticación**: `4000 0025 0000 3155`
- **Pago rechazado**: `4000 0000 0000 0002`
- **Cualquier CVC**: 3 dígitos
- **Cualquier fecha futura**: MM/YY

### Testing de Webhooks Local

1. Instala Stripe CLI:
   ```bash
   # Windows
   scoop install stripe

   # Mac
   brew install stripe/stripe-cli/stripe
   ```

2. Login:
   ```bash
   stripe login
   ```

3. Forward webhooks:
   ```bash
   stripe listen --forward-to localhost:3001/webhooks/stripe
   ```

4. Trigger eventos:
   ```bash
   stripe trigger checkout.session.completed
   stripe trigger invoice.payment_succeeded
   stripe trigger invoice.payment_failed
   ```

---

## 🚀 Despliegue a Producción

### 1. Cambiar a modo Live en Stripe

1. En Stripe Dashboard, desactiva "Test mode"
2. Crea los mismos productos en modo Live
3. Obtén las nuevas API keys de producción
4. Actualiza variables de entorno en producción

### 2. Configurar Webhook en Producción

1. Crea nuevo webhook apuntando a tu dominio de producción
2. Usa el nuevo webhook secret en las variables de entorno

### 3. Variables de Entorno en Producción

```env
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PREMIUM_PRICE_ID=price_live_...
STRIPE_PRO_PRICE_ID=price_live_...
FRONTEND_URL=https://app.finzenai.com
```

---

## ⚠️ Consideraciones Importantes

1. **Seguridad**: NUNCA expongas `STRIPE_SECRET_KEY` en el frontend
2. **Webhooks**: Siempre verificar la firma del webhook
3. **HTTPS**: Stripe requiere HTTPS en producción
4. **Idempotencia**: Stripe maneja reintentos automáticos de webhooks
5. **Testing**: Usa siempre Test Mode antes de ir a producción
6. **Logs**: Monitorea los logs de webhooks en Stripe Dashboard

---

## 📚 Documentación

- [Stripe API Docs](https://stripe.com/docs/api)
- [Stripe Checkout](https://stripe.com/docs/payments/checkout)
- [Stripe Billing](https://stripe.com/docs/billing)
- [Stripe Webhooks](https://stripe.com/docs/webhooks)
- [Stripe Testing](https://stripe.com/docs/testing)

---

## ✅ Checklist de Implementación

- [x] Instalar dependencia Stripe
- [x] Crear modelos de BD (Subscription, Payment)
- [x] Configurar Stripe (config/stripe.ts)
- [x] Crear servicios (stripeService, subscriptionService)
- [x] Crear controladores
- [x] Crear webhooks
- [x] Crear middleware de límites
- [x] Crear rutas
- [x] Integrar en app.ts
- [x] Crear .env.example
- [ ] Configurar cuenta de Stripe
- [ ] Crear productos en Stripe
- [ ] Configurar webhook en Stripe
- [ ] Actualizar variables de entorno
- [ ] Testing local
- [ ] Despliegue a producción

---

**Implementación completada por:** Claude Code
**Fecha:** 2025-11-11
