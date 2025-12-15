import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Bancos soportados para Republica Dominicana
const SUPPORTED_BANKS_DO = [
  {
    name: 'Banco Popular Dominicano',
    country: 'DO',
    senderEmails: ['notificaciones@popularenlinea.com', 'alertas@bpd.com.do', 'notificaciones@bpd.com.do'],
    subjectPatterns: ['consumo', 'compra', 'transaccion', 'cargo', 'retiro', 'pago'],
    logoUrl: 'https://www.popularenlinea.com/Images/logo.png'
  },
  {
    name: 'Banreservas',
    country: 'DO',
    senderEmails: ['notificaciones@banreservas.com', 'alertas@banreservas.com', 'notificaciones@banreservas.com.do'],
    subjectPatterns: ['consumo', 'compra', 'transaccion', 'cargo', 'retiro'],
    logoUrl: 'https://www.banreservas.com/images/logo.png'
  },
  {
    name: 'BHD Leon',
    country: 'DO',
    senderEmails: ['alertas@bhdleon.com.do', 'notificaciones@bhdleon.com.do', 'bhdalertas@bhdleon.com.do'],
    subjectPatterns: ['consumo', 'compra', 'transaccion', 'cargo', 'retiro'],
    logoUrl: 'https://www.bhdleon.com.do/images/logo.png'
  },
  {
    name: 'Scotiabank Republica Dominicana',
    country: 'DO',
    senderEmails: ['alertas@scotiabank.com', 'notificaciones.do@scotiabank.com', 'noreply@scotiabank.com.do'],
    subjectPatterns: ['consumo', 'compra', 'transaccion', 'cargo', 'retiro'],
    logoUrl: 'https://www.scotiabank.com/do/images/logo.png'
  },
  {
    name: 'Asociacion Popular de Ahorros y Prestamos (APAP)',
    country: 'DO',
    senderEmails: ['no-reply@apap.com.do', 'alertas@apap.com.do', 'notificaciones@apap.com.do'],
    subjectPatterns: ['consumo', 'compra', 'transaccion', 'cargo', 'retiro'],
    logoUrl: 'https://www.apap.com.do/images/logo.png'
  },
  {
    name: 'Banco Santa Cruz',
    country: 'DO',
    senderEmails: ['alertas@bsc.com.do', 'notificaciones@bsc.com.do', 'noreply@bsc.com.do'],
    subjectPatterns: ['consumo', 'compra', 'transaccion', 'cargo'],
    logoUrl: 'https://www.bsc.com.do/images/logo.png'
  },
  {
    name: 'Banco BDI',
    country: 'DO',
    senderEmails: ['alertas@bdi.com.do', 'notificaciones@bdi.com.do'],
    subjectPatterns: ['consumo', 'compra', 'transaccion', 'cargo'],
    logoUrl: null
  },
  {
    name: 'Banco Caribe',
    country: 'DO',
    senderEmails: ['alertas@bancocaribe.com.do', 'notificaciones@bancocaribe.com.do'],
    subjectPatterns: ['consumo', 'compra', 'transaccion', 'cargo'],
    logoUrl: null
  },
  {
    name: 'Banco Lopez de Haro',
    country: 'DO',
    senderEmails: ['alertas@blh.com.do', 'notificaciones@blh.com.do'],
    subjectPatterns: ['consumo', 'compra', 'transaccion', 'cargo'],
    logoUrl: null
  },
  {
    name: 'Banco Promerica',
    country: 'DO',
    senderEmails: ['alertas@promerica.com.do', 'notificaciones@promerica.com.do'],
    subjectPatterns: ['consumo', 'compra', 'transaccion', 'cargo'],
    logoUrl: null
  }
];

async function seedSupportedBanks() {
  console.log('🏦 Seeding supported banks...');

  for (const bank of SUPPORTED_BANKS_DO) {
    try {
      await prisma.supportedBank.upsert({
        where: { name: bank.name },
        update: {
          country: bank.country,
          senderEmails: bank.senderEmails,
          subjectPatterns: bank.subjectPatterns,
          logoUrl: bank.logoUrl,
          isActive: true
        },
        create: {
          name: bank.name,
          country: bank.country,
          senderEmails: bank.senderEmails,
          subjectPatterns: bank.subjectPatterns,
          logoUrl: bank.logoUrl,
          isActive: true
        }
      });

      console.log(`  ✅ ${bank.name}`);
    } catch (error) {
      console.error(`  ❌ Error seeding ${bank.name}:`, error);
    }
  }

  console.log('✅ Supported banks seeded successfully!');
}

// Ejecutar si se llama directamente
if (require.main === module) {
  seedSupportedBanks()
    .then(() => prisma.$disconnect())
    .catch((error) => {
      console.error('Error:', error);
      prisma.$disconnect();
      process.exit(1);
    });
}

export { seedSupportedBanks, SUPPORTED_BANKS_DO };
