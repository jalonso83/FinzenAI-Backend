import { prisma } from '../lib/prisma';

import { logger } from '../utils/logger';
const defaultCategories = [
  // === INCOME (8) ===
  { id: "97fe3b7f-744d-423d-a7bd-3e263af06a68", name: "Salario", type: "INCOME" as const, icon: "💼", isDefault: true },
  { id: "ccbc1d75-cfb2-44b7-882a-85a7910ac081", name: "Freelance", type: "INCOME" as const, icon: "💻", isDefault: true },
  { name: "Emprendimiento", type: "INCOME" as const, icon: "🚀", isDefault: true },
  { name: "Remesas", type: "INCOME" as const, icon: "🌎", isDefault: true },
  { id: "dd338d52-3ac5-4688-b6b9-8833a7ba3f06", name: "Inversiones", type: "INCOME" as const, icon: "📈", isDefault: true },
  { id: "0555933b-4456-42c7-81aa-4b52f3703cc1", name: "Regalos recibidos", type: "INCOME" as const, icon: "🎁", isDefault: true },
  { name: "Bonificaciones", type: "INCOME" as const, icon: "🎯", isDefault: true },
  { id: "ffdab6f2-325c-4e8a-97f6-27993e5c57b5", name: "Otros ingresos", type: "INCOME" as const, icon: "💰", isDefault: true },

  // === EXPENSE (22) ===
  { id: "eb7a96d7-b53b-4e2c-b3b2-a7c4935028c3", name: "Vivienda y alquiler", type: "EXPENSE" as const, icon: "🏠", isDefault: true },
  { id: "8cd3584b-146a-4c32-8b6c-7a0ac2486fac", name: "Supermercado", type: "EXPENSE" as const, icon: "🛒", isDefault: true },
  { id: "605eb26b-a2e3-4316-aed9-af4c4a761b7b", name: "Comida y restaurantes", type: "EXPENSE" as const, icon: "🍽️", isDefault: true },
  { name: "Delivery", type: "EXPENSE" as const, icon: "🛵", isDefault: true },
  { id: "1a9478b7-52e7-409b-aa84-7c64bb6ff42f", name: "Transporte", type: "EXPENSE" as const, icon: "🚗", isDefault: true },
  { name: "Comunicaciones", type: "EXPENSE" as const, icon: "📱", isDefault: true },
  { id: "5e3a5d25-5a81-4c26-8b72-7e7cb0580cf0", name: "Servicios del hogar", type: "EXPENSE" as const, icon: "⚡", isDefault: true },
  { name: "Seguros", type: "EXPENSE" as const, icon: "🛡️", isDefault: true },
  { id: "11ea89d8-34fd-415d-a3d1-aaf903cdc464", name: "Suscripciones", type: "EXPENSE" as const, icon: "🔄", isDefault: true },
  { id: "e19f7d61-fe48-4987-a22b-11e4c87aae18", name: "Educación", type: "EXPENSE" as const, icon: "📚", isDefault: true },
  { id: "c10cfd87-9a6d-440a-a035-389f0ea886e8", name: "Salud", type: "EXPENSE" as const, icon: "❤️", isDefault: true },
  { id: "10d93cca-91c8-46d4-97e3-7e98d29dc470", name: "Préstamos y deudas", type: "EXPENSE" as const, icon: "💰", isDefault: true },
  { id: "0b3d3922-ffc0-4618-9e20-8998fb0b88bd", name: "Impuestos", type: "EXPENSE" as const, icon: "🏛️", isDefault: true },
  { id: "884a7a5d-0bd7-4fef-a737-9f7e26d95ff7", name: "Entretenimiento", type: "EXPENSE" as const, icon: "🎬", isDefault: true },
  { id: "5664412e-7f26-4519-80fa-598d988eec09", name: "Ropa y Accesorios", type: "EXPENSE" as const, icon: "👔", isDefault: true },
  { id: "fee92b47-a685-40d3-95dd-b59d9d2e1d31", name: "Cuidado personal", type: "EXPENSE" as const, icon: "👤", isDefault: true },
  { id: "31cb9012-2612-477b-ac2c-f15f361921e3", name: "Gimnasio y Deportes", type: "EXPENSE" as const, icon: "🏃‍♂️", isDefault: true },
  { id: "662d2f64-50ce-4d70-9f43-2b8f82b9619f", name: "Mascotas", type: "EXPENSE" as const, icon: "🐕", isDefault: true },
  { id: "e876f2e0-f023-4a2f-a473-6c35230f080a", name: "Viajes", type: "EXPENSE" as const, icon: "✈️", isDefault: true },
  { id: "c4fe9e92-90d8-4c76-a02b-5fbd66dad01e", name: "Regalos y donaciones", type: "EXPENSE" as const, icon: "🎁", isDefault: true },
  { name: "Electrónica y tecnología", type: "EXPENSE" as const, icon: "📲", isDefault: true },
  { id: "32bc498e-195c-4313-aab7-24e242028261", name: "Otros gastos", type: "EXPENSE" as const, icon: "📝", isDefault: true },
];

export async function seedCategories() {
  try {
    logger.log('🌱 Poblando categorías por defecto...');

    // Verificar si ya existen categorías
    const existingCategories = await prisma.category.count();

    if (existingCategories > 0) {
      logger.log('✅ Las categorías ya existen, saltando...');
      return;
    }

    // Crear todas las categorías por defecto
    for (const category of defaultCategories) {
      await prisma.category.create({
        data: category
      });
    }

    logger.log(`✅ ${defaultCategories.length} categorías creadas exitosamente`);
  } catch (error) {
    logger.error('❌ Error poblando categorías:', error);
    throw error;
  }
}

// Ejecutar si se llama directamente
if (require.main === module) {
  seedCategories()
    .then(() => {
      logger.log('✅ Seed completado');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('❌ Error en seed:', error);
      process.exit(1);
    });
}
