/**
 * Script para actualizar los archivos del vector store de Zenio
 *
 * Uso:
 *   set OPENAI_API_KEY=sk-tu-key-aqui && npx ts-node scripts/update-vector-store.ts
 */

import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';

const VECTOR_STORE_ID = 'vs_685da89f2ce4819193d9d9fc40b7f5c1';

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('ERROR: OPENAI_API_KEY no está definida');
    process.exit(1);
  }

  const openai = new OpenAI({ apiKey });

  console.log('=== Actualizando Vector Store de Zenio ===\n');

  // 1. Listar archivos actuales
  console.log('1. Listando archivos actuales...');
  const currentFiles = await openai.vectorStores.files.list(VECTOR_STORE_ID);
  console.log(`   Archivos encontrados: ${currentFiles.data.length}`);
  for (const f of currentFiles.data) {
    console.log(`   - ${f.id} (${f.usage_bytes} bytes, status: ${f.status})`);
  }

  // 2. Eliminar archivos viejos del vector store
  console.log('\n2. Eliminando archivos viejos...');
  for (const f of currentFiles.data) {
    try {
      // Usar la API REST directamente para eliminar
      const response = await fetch(`https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files/${f.id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'OpenAI-Beta': 'assistants=v2' },
      });
      if (response.ok) {
        console.log(`   ✅ Eliminado del vector store: ${f.id}`);
      } else {
        const err = await response.json();
        console.log(`   ⚠️ Error: ${JSON.stringify(err)}`);
      }
    } catch (err: any) {
      console.log(`   ⚠️ Error eliminando ${f.id}: ${err.message}`);
    }
  }

  // 3. Subir archivos nuevos
  console.log('\n3. Subiendo archivos nuevos...');

  const configDir = path.join(__dirname, '..', 'src', 'config', 'zenio-config');

  // Formatos soportados por vector store: .txt, .pdf, .docx, .md, .json
  const filesToUpload = [
    { name: 'Principios_Financieros.csv', path: path.join(configDir, 'Principios_Financieros.csv'), rename: 'Principios_Financieros.txt' },
    { name: 'Prompts.docx', path: path.join(configDir, 'Prompts.docx'), rename: null },
  ];

  for (const file of filesToUpload) {
    if (!fs.existsSync(file.path)) {
      console.log(`   ❌ Archivo no encontrado: ${file.path}`);
      continue;
    }

    console.log(`   Subiendo ${file.name}...`);

    // Si necesita renombrar (csv → txt), crear copia temporal
    let uploadPath = file.path;
    let tempPath: string | null = null;
    if (file.rename) {
      tempPath = path.join(configDir, file.rename);
      fs.copyFileSync(file.path, tempPath);
      uploadPath = tempPath;
      console.log(`   (Renombrado a ${file.rename} para compatibilidad)`);
    }

    try {
      const uploadedFile = await openai.files.create({
        file: fs.createReadStream(uploadPath),
        purpose: 'assistants',
      });
      console.log(`   📄 Archivo subido: ${uploadedFile.id}`);

      const vsFile = await openai.vectorStores.files.create(VECTOR_STORE_ID, {
        file_id: uploadedFile.id,
      });
      console.log(`   ✅ Vinculado al vector store: ${vsFile.id} (status: ${vsFile.status})`);
    } finally {
      // Limpiar archivo temporal
      if (tempPath && fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    }
  }

  // 4. Verificar estado final
  console.log('\n4. Verificando estado final (esperando 5s)...');
  await new Promise(resolve => setTimeout(resolve, 5000));

  const finalFiles = await openai.vectorStores.files.list(VECTOR_STORE_ID);
  console.log(`   Archivos en vector store: ${finalFiles.data.length}`);
  for (const f of finalFiles.data) {
    console.log(`   - ${f.id} (${f.usage_bytes} bytes, status: ${f.status})`);
  }

  const vs = await openai.vectorStores.retrieve(VECTOR_STORE_ID);
  console.log(`\n   Vector Store: ${vs.name}`);
  console.log(`   Status: ${vs.status}`);
  console.log(`   File counts: ${JSON.stringify(vs.file_counts)}`);

  console.log('\n=== Listo ===');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
