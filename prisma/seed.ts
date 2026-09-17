import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // =============================================
  // BANCOS SOPORTADOS - REPÚBLICA DOMINICANA
  // =============================================
  const supportedBanks = [
    {
      // Neobanco del Popular. Asunto real: "Usaste tu tarjeta de crédito Qik" —
      // no trae ninguna de las palabras estándar (consumo, compra...), por eso
      // 'usaste'. OJO: sus fechas van en MM-DD-YYYY (09-07-2026 = 7 de
      // septiembre), al revés que el resto de RD; el parser lo sabe por nombre.
      name: 'Qik Banco Digital',
      country: 'DO',
      senderEmails: ['notificaciones@qik.do'],
      subjectPatterns: ['usaste', 'consumo', 'compra', 'transaccion', 'cargo', 'pago', 'notificacion'],
      isActive: true,
      logoUrl: null
    },
    {
      name: 'Banco Popular Dominicano',
      country: 'DO',
      senderEmails: [
        'notificaciones@popularenlinea.com',
        'alertas@bpd.com.do',
        'notificaciones@bpd.com.do',
        'noreply@popularenlinea.com'
      ],
      subjectPatterns: ['consumo', 'compra', 'transaccion', 'cargo', 'retiro', 'pago', 'notificacion'],
      isActive: true,
      logoUrl: null
    },
    {
      name: 'Banreservas',
      country: 'DO',
      senderEmails: [
        'notificaciones@banreservas.com',
        'alertas@banreservas.com',
        'notificaciones@banreservas.com.do',
        'noreply@banreservas.com'
      ],
      subjectPatterns: ['consumo', 'compra', 'transaccion', 'cargo', 'retiro', 'pago', 'notificacion'],
      isActive: true,
      logoUrl: null
    },
    {
      name: 'BHD León',
      country: 'DO',
      senderEmails: [
        'alertas@bhd.com.do',
        'notificaciones@bhd.com.do',
        'noreply@bhd.com.do',
        'alertas@bhdleon.com.do',
        'notificaciones@bhdleon.com.do',
        'bhdalertas@bhdleon.com.do',
        'noreply@bhdleon.com.do'
      ],
      subjectPatterns: ['consumo', 'compra', 'transaccion', 'cargo', 'retiro', 'pago', 'notificacion'],
      isActive: true,
      logoUrl: null
    },
    {
      name: 'Scotiabank RD',
      country: 'DO',
      senderEmails: [
        'alertas@scotiabank.com',
        'notificaciones.do@scotiabank.com',
        'alertas@scotiabank.com.do',
        'noreply@scotiabank.com.do'
      ],
      subjectPatterns: ['consumo', 'compra', 'transaccion', 'cargo', 'retiro', 'pago', 'notificacion'],
      isActive: true,
      logoUrl: null
    },
    {
      name: 'Banco Caribe',
      country: 'DO',
      senderEmails: [
        'notificaciones@bancocaribe.com.do',
        'alertas@bancocaribe.com.do',
        'noreply@bancocaribe.com.do'
      ],
      subjectPatterns: ['consumo', 'compra', 'transaccion', 'cargo', 'retiro', 'pago', 'notificacion'],
      isActive: true,
      logoUrl: null
    },
    {
      name: 'APAP',
      country: 'DO',
      senderEmails: [
        'no-reply@apap.com.do',
        'alertas@apap.com.do',
        'notificaciones@apap.com.do',
        'noreply@apap.com.do'
      ],
      subjectPatterns: ['consumo', 'compra', 'transaccion', 'cargo', 'retiro', 'pago', 'notificacion'],
      isActive: true,
      logoUrl: null
    },
    {
      name: 'Banco Vimenca',
      country: 'DO',
      senderEmails: [
        'internetbanking@vimenca.com',
        'notificaciones@vimenca.com',
        'alertas@vimenca.com'
      ],
      subjectPatterns: ['consumo', 'compra', 'transaccion', 'cargo', 'retiro', 'pago', 'notificacion'],
      isActive: true,
      logoUrl: null
    },
    {
      name: 'Banco Santa Cruz',
      country: 'DO',
      senderEmails: [
        'notificaciones@bsc.com.do',
        'alertas@bsc.com.do',
        'noreply@bsc.com.do'
      ],
      subjectPatterns: ['consumo', 'compra', 'transaccion', 'cargo', 'retiro', 'pago', 'notificacion'],
      isActive: true,
      logoUrl: null
    },
    {
      name: 'Banco Promerica',
      country: 'DO',
      senderEmails: [
        'alertas@promerica.com.do',
        'notificaciones@promerica.com.do',
        'noreply@promerica.com.do'
      ],
      subjectPatterns: ['consumo', 'compra', 'transaccion', 'cargo', 'retiro', 'pago', 'notificacion'],
      isActive: true,
      logoUrl: null
    },
    {
      name: 'Banco López de Haro',
      country: 'DO',
      senderEmails: [
        'alertas@blh.com.do',
        'notificaciones@blh.com.do',
        'noreply@blh.com.do'
      ],
      subjectPatterns: ['consumo', 'compra', 'transaccion', 'cargo', 'retiro', 'pago', 'notificacion'],
      isActive: true,
      logoUrl: null
    },
    {
      name: 'Asociación La Nacional',
      country: 'DO',
      senderEmails: [
        'alertas@alnap.com.do',
        'notificaciones@alnap.com.do',
        'noreply@alnap.com.do'
      ],
      subjectPatterns: ['consumo', 'compra', 'transaccion', 'cargo', 'retiro', 'pago', 'notificacion'],
      isActive: true,
      logoUrl: null
    },
    {
      name: 'Banco BDI',
      country: 'DO',
      senderEmails: [
        'alertas@bdi.com.do',
        'notificaciones@bdi.com.do',
        'noreply@bdi.com.do'
      ],
      subjectPatterns: ['consumo', 'compra', 'transaccion', 'cargo', 'retiro', 'pago', 'notificacion'],
      isActive: true,
      logoUrl: null
    },
    {
      name: 'Banco Ademi',
      country: 'DO',
      senderEmails: [
        'alertas@bancoademi.com.do',
        'notificaciones@bancoademi.com.do',
        'noreply@bancoademi.com.do'
      ],
      subjectPatterns: ['consumo', 'compra', 'transaccion', 'cargo', 'retiro', 'pago', 'notificacion'],
      isActive: true,
      logoUrl: null
    },
    {
      name: 'Banco Múltiple Bellbank',
      country: 'DO',
      senderEmails: [
        'alertas@bellbank.com.do',
        'notificaciones@bellbank.com.do',
        'noreply@bellbank.com.do'
      ],
      subjectPatterns: ['consumo', 'compra', 'transaccion', 'cargo', 'retiro', 'pago', 'notificacion'],
      isActive: true,
      logoUrl: null
    },
    {
      name: 'Asociación Cibao de Ahorros y Préstamos',
      country: 'DO',
      senderEmails: [
        'AlertaCibao@cibao.com.do',
        'alertacibao@cibao.com.do',
        'alertas@cibao.com.do',
        'notificaciones@cibao.com.do',
        'noreply@cibao.com.do'
      ],
      subjectPatterns: ['consumo', 'compra', 'transaccion', 'cargo', 'retiro', 'pago', 'notificacion', 'alerta'],
      isActive: true,
      logoUrl: null
    },
    {
      name: 'Alaver - Asociación de Ahorros y Préstamos',
      country: 'DO',
      senderEmails: [
        'Alaverenlinea@notificaciones.alaver.com.do',
        'alaverenlinea@notificaciones.alaver.com.do',
        'notificaciones@alaver.com.do',
        'alertas@alaver.com.do',
        'noreply@alaver.com.do'
      ],
      subjectPatterns: ['consumo', 'compra', 'transaccion', 'cargo', 'retiro', 'pago', 'notificacion', 'aviso'],
      isActive: true,
      logoUrl: null
    }
  ];

  console.log('📦 Inserting supported banks...');

  for (const bank of supportedBanks) {
    await prisma.supportedBank.upsert({
      where: { name: bank.name },
      update: {
        country: bank.country,
        senderEmails: bank.senderEmails,
        subjectPatterns: bank.subjectPatterns,
        isActive: bank.isActive,
        logoUrl: bank.logoUrl
      },
      create: bank
    });
    console.log(`  ✅ ${bank.name}`);
  }

  console.log(`\n🎉 Seeded ${supportedBanks.length} banks successfully!`);
}

main()
  .catch((e) => {
    console.error('❌ Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
