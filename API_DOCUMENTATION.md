# 📚 API Documentation - FinZen AI

## 🔗 Base URL
```
http://localhost:3001/api
```

## 🔐 Autenticación
Todas las rutas (excepto autenticación) requieren un token JWT en el header:
```
Authorization: Bearer <token>
```

---

## 🏦 Transacciones

### Obtener Transacciones
```http
GET /transactions
```

**Query Parameters:**
- `page` (number, default: 1) - Número de página
- `limit` (number, default: 10) - Elementos por página
- `type` (string) - Filtrar por tipo: `INCOME` o `EXPENSE`
- `category_id` (string) - Filtrar por ID de categoría
- `startDate` (string) - Fecha de inicio (YYYY-MM-DD)
- `endDate` (string) - Fecha de fin (YYYY-MM-DD)

**Response:**
```json
{
  "transactions": [
    {
      "id": "string",
      "amount": 1000.50,
      "type": "EXPENSE",
      "category": {
        "id": "string",
        "name": "Comida",
        "icon": "🍕",
        "type": "EXPENSE",
        "isDefault": true
      },
      "description": "Almuerzo",
      "date": "2024-01-15T00:00:00.000Z",
      "createdAt": "2024-01-15T10:30:00.000Z",
      "updatedAt": "2024-01-15T10:30:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 25,
    "pages": 3
  }
}
```

### Obtener Transacción por ID
```http
GET /transactions/:id
```

**Response:**
```json
{
  "transaction": {
    "id": "string",
    "amount": 1000.50,
    "type": "EXPENSE",
    "category": {
      "id": "string",
      "name": "Comida",
      "icon": "🍕",
      "type": "EXPENSE",
      "isDefault": true
    },
    "description": "Almuerzo",
    "date": "2024-01-15T00:00:00.000Z",
    "createdAt": "2024-01-15T10:30:00.000Z",
    "updatedAt": "2024-01-15T10:30:00.000Z"
  }
}
```

### Crear Transacción
```http
POST /transactions
```

**Request Body:**
```json
{
  "amount": 1000.50,
  "type": "EXPENSE",
  "category_id": "string",
  "description": "Almuerzo",
  "date": "2024-01-15"
}
```

**Response:**
```json
{
  "message": "Transaction created successfully",
  "transaction": {
    "id": "string",
    "amount": 1000.50,
    "type": "EXPENSE",
    "category": {
      "id": "string",
      "name": "Comida",
      "icon": "🍕",
      "type": "EXPENSE",
      "isDefault": true
    },
    "description": "Almuerzo",
    "date": "2024-01-15T00:00:00.000Z",
    "createdAt": "2024-01-15T10:30:00.000Z",
    "updatedAt": "2024-01-15T10:30:00.000Z"
  }
}
```

### Actualizar Transacción
```http
PUT /transactions/:id
```

**Request Body:**
```json
{
  "amount": 1200.00,
  "type": "EXPENSE",
  "category_id": "string",
  "description": "Almuerzo actualizado",
  "date": "2024-01-15"
}
```

**Response:**
```json
{
  "message": "Transaction updated successfully",
  "transaction": {
    "id": "string",
    "amount": 1200.00,
    "type": "EXPENSE",
    "category": {
      "id": "string",
      "name": "Comida",
      "icon": "🍕",
      "type": "EXPENSE",
      "isDefault": true
    },
    "description": "Almuerzo actualizado",
    "date": "2024-01-15T00:00:00.000Z",
    "createdAt": "2024-01-15T10:30:00.000Z",
    "updatedAt": "2024-01-15T11:00:00.000Z"
  }
}
```

### Eliminar Transacción
```http
DELETE /transactions/:id
```

**Response:**
```json
{
  "message": "Transaction deleted successfully"
}
```

---

## 💰 Presupuestos

### Obtener Presupuestos
```http
GET /budgets
```

**Query Parameters:**
- `page` (number, default: 1) - Número de página
- `limit` (number, default: 10) - Elementos por página
- `is_active` (boolean) - Filtrar por estado activo
- `category_id` (string) - Filtrar por ID de categoría

**Response:**
```json
{
  "budgets": [
    {
      "id": "string",
      "name": "Presupuesto Comida",
      "category_id": "string",
      "amount": 5000.00,
      "period": "monthly",
      "start_date": "2024-01-01T00:00:00.000Z",
      "end_date": "2024-01-31T23:59:59.999Z",
      "spent": 2500.00,
      "is_active": true,
      "alert_percentage": 85,
      "created_at": "2024-01-01T00:00:00.000Z",
      "updated_at": "2024-01-15T10:30:00.000Z",
      "category": {
        "id": "string",
        "name": "Comida",
        "icon": "🍕",
        "type": "EXPENSE",
        "isDefault": true
      }
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 5,
    "pages": 1
  }
}
```

### Obtener Presupuesto por ID
```http
GET /budgets/:id
```

**Response:**
```json
{
  "budget": {
    "id": "string",
    "name": "Presupuesto Comida",
    "category_id": "string",
    "amount": 5000.00,
    "period": "monthly",
    "start_date": "2024-01-01T00:00:00.000Z",
    "end_date": "2024-01-31T23:59:59.999Z",
    "spent": 2500.00,
    "is_active": true,
    "alert_percentage": 85,
    "created_at": "2024-01-01T00:00:00.000Z",
    "updated_at": "2024-01-15T10:30:00.000Z",
    "category": {
      "id": "string",
      "name": "Comida",
      "icon": "🍕",
      "type": "EXPENSE",
      "isDefault": true
    }
  }
}
```

### Crear Presupuesto
```http
POST /budgets
```

**Request Body:**
```json
{
  "name": "Presupuesto Comida",
  "category_id": "string",
  "amount": 5000.00,
  "period": "monthly",
  "start_date": "2024-01-01",
  "end_date": "2024-01-31",
  "alert_percentage": 85
}
```

**Response:**
```json
{
  "message": "Budget created successfully",
  "budget": {
    "id": "string",
    "name": "Presupuesto Comida",
    "category_id": "string",
    "amount": 5000.00,
    "period": "monthly",
    "start_date": "2024-01-01T00:00:00.000Z",
    "end_date": "2024-01-31T23:59:59.999Z",
    "spent": 0,
    "is_active": true,
    "alert_percentage": 85,
    "created_at": "2024-01-01T00:00:00.000Z",
    "updated_at": "2024-01-01T00:00:00.000Z",
    "category": {
      "id": "string",
      "name": "Comida",
      "icon": "🍕",
      "type": "EXPENSE",
      "isDefault": true
    }
  }
}
```

### Actualizar Presupuesto
```http
PUT /budgets/:id
```

**Request Body:**
```json
{
  "name": "Presupuesto Comida Actualizado",
  "amount": 6000.00,
  "alert_percentage": 90,
  "is_active": false
}
```

**Response:**
```json
{
  "message": "Budget updated successfully",
  "budget": {
    "id": "string",
    "name": "Presupuesto Comida Actualizado",
    "category_id": "string",
    "amount": 6000.00,
    "period": "monthly",
    "start_date": "2024-01-01T00:00:00.000Z",
    "end_date": "2024-01-31T23:59:59.999Z",
    "spent": 2500.00,
    "is_active": false,
    "alert_percentage": 90,
    "created_at": "2024-01-01T00:00:00.000Z",
    "updated_at": "2024-01-15T11:00:00.000Z",
    "category": {
      "id": "string",
      "name": "Comida",
      "icon": "🍕",
      "type": "EXPENSE",
      "isDefault": true
    }
  }
}
```

### Eliminar Presupuesto
```http
DELETE /budgets/:id
```

**Response:**
```json
{
  "message": "Budget deleted successfully"
}
```

---

## 🏷️ Categorías

### Obtener Categorías
```http
GET /categories
```

**Query Parameters:**
- `type` (string) - Filtrar por tipo: `INCOME` o `EXPENSE`

**Response:**
```json
[
  {
    "id": "string",
    "name": "Comida",
    "type": "EXPENSE",
    "icon": "🍕",
    "isDefault": true,
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  }
]
```

### Crear Categoría
```http
POST /categories
```

**Request Body:**
```json
{
  "name": "Nueva Categoría",
  "type": "EXPENSE",
  "icon": "🎯"
}
```

**Response:**
```json
{
  "message": "Category created successfully",
  "category": {
    "id": "string",
    "name": "Nueva Categoría",
    "type": "EXPENSE",
    "icon": "🎯",
    "isDefault": false,
    "createdAt": "2024-01-15T10:30:00.000Z",
    "updatedAt": "2024-01-15T10:30:00.000Z"
  }
}
```

### Actualizar Categoría
```http
PUT /categories/:id
```

**Request Body:**
```json
{
  "name": "Categoría Actualizada",
  "icon": "🎯"
}
```

**Response:**
```json
{
  "message": "Category updated successfully",
  "category": {
    "id": "string",
    "name": "Categoría Actualizada",
    "type": "EXPENSE",
    "icon": "🎯",
    "isDefault": false,
    "createdAt": "2024-01-15T10:30:00.000Z",
    "updatedAt": "2024-01-15T11:00:00.000Z"
  }
}
```

### Eliminar Categoría
```http
DELETE /categories/:id
```

**Response:**
```json
{
  "message": "Category deleted successfully"
}
```

---

## 🤖 Zenio (Asistente IA)

### Chat con Zenio
```http
POST /zenio/chat
```

**Request Body:**
```json
{
  "message": "Registra un gasto de 1000 pesos en comida",
  "threadId": "thread_abc123"
}
```

**Response:**
```json
{
  "message": "✅ Transacción registrada exitosamente...",
  "threadId": "thread_abc123"
}
```

### Obtener Historial de Chat
```http
GET /zenio/history
```

**Query Parameters:**
- `threadId` (string) - ID del hilo de conversación

---

## 🔐 Autenticación

### Registro
```http
POST /auth/register
```

**Request Body:**
```json
{
  "name": "Juan",
  "lastName": "Pérez",
  "email": "juan@example.com",
  "password": "password123",
  "phone": "8091234567",
  "birthDate": "1990-01-01",
  "country": "República Dominicana",
  "state": "Santo Domingo",
  "city": "Santo Domingo",
  "currency": "DOP",
  "preferredLanguage": "es",
  "occupation": "Desarrollador",
  "company": "Tech Corp"
}
```

### Login
```http
POST /auth/login
```

**Request Body:**
```json
{
  "email": "juan@example.com",
  "password": "password123"
}
```

**Response:**
```json
{
  "message": "Login successful",
  "token": "jwt_token_here",
  "user": {
    "id": "string",
    "name": "Juan",
    "email": "juan@example.com",
    "verified": true,
    "onboardingCompleted": false
  }
}
```

---

## 📊 Códigos de Estado HTTP

- `200` - OK - Operación exitosa
- `201` - Created - Recurso creado exitosamente
- `400` - Bad Request - Datos de entrada inválidos
- `401` - Unauthorized - Token de autenticación requerido
- `403` - Forbidden - No tienes permisos para esta operación
- `404` - Not Found - Recurso no encontrado
- `409` - Conflict - Conflicto con el estado actual del recurso
- `500` - Internal Server Error - Error interno del servidor

---

## 🔄 Cambios Recientes (v2.0)

### ✅ Mejoras Implementadas:

1. **Relaciones Foráneas**: 
   - Transacciones y presupuestos ahora usan `category_id` como clave foránea
   - Eliminado el uso de strings para categorías

2. **Objetos Completos**:
   - Todos los endpoints devuelven el objeto `category` completo
   - Incluye `id`, `name`, `icon`, `type`, `isDefault`

3. **Validaciones Robustas**:
   - Verificación de existencia de categorías en todas las operaciones
   - Validación de fechas y rangos
   - Validación de tipos de transacción

4. **Paginación**:
   - Implementada en transacciones y presupuestos
   - Parámetros `page` y `limit` disponibles

5. **Filtros Avanzados**:
   - Por tipo de transacción
   - Por categoría (usando ID)
   - Por fechas (con rangos de día completo)
   - Por estado activo (presupuestos)

6. **Manejo de Errores Mejorado**:
   - Respuestas consistentes y descriptivas
   - Códigos de estado HTTP apropiados
   - Mensajes de error informativos

### 🚫 Eliminado:

- Mapeo manual de categorías
- Uso de localStorage para datos
- Lógica local innecesaria
- Campos `category` como string

### 📝 Notas de Migración:

Si estás migrando desde una versión anterior:

1. **Frontend**: Actualizar todas las referencias de `category` (string) a `category.id`
2. **API Calls**: Cambiar `category` por `category_id` en requests
3. **Interfaces**: Actualizar tipos para usar objetos `category` completos
4. **Filtros**: Usar `category_id` en lugar de nombres de categoría

---

## 🧪 Testing

Para probar los endpoints, puedes usar herramientas como:
- **Postman**
- **Insomnia**
- **cURL**
- **Thunder Client** (VS Code extension)

### Ejemplo con cURL:

```bash
# Obtener transacciones
curl -H "Authorization: Bearer YOUR_TOKEN" \
     "http://localhost:3001/api/transactions?page=1&limit=10"

# Crear transacción
curl -X POST \
     -H "Authorization: Bearer YOUR_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"amount": 1000, "type": "EXPENSE", "category_id": "cat_id", "description": "Test"}' \
     "http://localhost:3001/api/transactions"
``` 