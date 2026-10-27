import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { connectDb } from './lib/db';
import { syncRouter } from './routes/sync';

async function main() {
  await connectDb();

  const app = express();
  app.use(cors()); // open CORS for dev. tighten for production.
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use(syncRouter);

  const port = Number(process.env.PORT ?? 4000);
  app.listen(port, () => {
    console.log(`✓ Server listening on http://localhost:${port}`);
  });
}

main().catch((err) => {
  console.error('Server failed to start:', err);
  process.exit(1);
});