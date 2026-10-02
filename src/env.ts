// Carrega as variáveis de ambiente ANTES de qualquer outro módulo
// (ia.ts e supabase.ts leem process.env no momento em que são importados).
import fs from 'fs';
import dotenv from 'dotenv';

if (fs.existsSync('.env.local')) dotenv.config({ path: '.env.local', override: true });
else dotenv.config();
