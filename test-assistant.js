const OpenAI = require("openai");
require('dotenv').config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  defaultHeaders: {
    "OpenAI-Beta": "assistants=v2"
  }
});

async function test() {
  try {
    // 1. Crear thread
    const thread = await openai.beta.threads.create();
    console.log("Thread creado:", thread.id);

    // 2. Agregar mensaje
    await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: "Hola, ¿quién eres?"
    });

    // 3. Ejecutar asistente
    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: process.env.OPENAI_ASSISTANT_ID // <-- PON TU ID EN .env
    });
    console.log("Run creado:", run.id);

    // 4. Esperar respuesta
    let runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    while (runStatus.status === "queued" || runStatus.status === "in_progress") {
      await new Promise((r) => setTimeout(r, 1000));
      runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    }
    console.log("Run status:", runStatus.status);

    // 5. Obtener respuesta
    const messages = await openai.beta.threads.messages.list(thread.id);
    const lastMessage = messages.data.find((msg) => msg.role === "assistant");
    if (lastMessage && lastMessage.content && lastMessage.content[0] && lastMessage.content[0].text) {
      console.log("Respuesta del asistente:", lastMessage.content[0].text.value);
    } else {
      console.log("No se pudo obtener respuesta del asistente.");
    }
  } catch (error) {
    console.error("Error en la prueba:", error);
  }
}

test();

// Script para recalcular el campo 'spent' de todos los presupuestos existentes
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function recalculateAllBudgetsSpent() {
  const budgets = await prisma.budget.findMany();
  let updated = 0;
  for (const budget of budgets) {
    const spentAgg = await prisma.transaction.aggregate({
      _sum: { amount: true },
      where: {
        userId: budget.user_id,
        category_id: budget.category_id,
        type: 'EXPENSE',
        date: {
          gte: budget.start_date,
          lte: budget.end_date
        }
      }
    });
    const spent = spentAgg._sum.amount || 0;
    await prisma.budget.update({
      where: { id: budget.id },
      data: { spent }
    });
    updated++;
    console.log(`Presupuesto ${budget.id} actualizado: spent = ${spent}`);
  }
  console.log(`Listo. Presupuestos actualizados: ${updated}`);
  await prisma.$disconnect();
}

recalculateAllBudgetsSpent().catch(e => {
  console.error(e);
  prisma.$disconnect();
  process.exit(1);
}); 