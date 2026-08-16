import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { ErrorRequestHandler } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { setupDatabase } from './db/setup';
import replayRouter from './routes/replay';
import eventsRouter from './routes/events';
import documentsRouter from './routes/documents';

setupDatabase();

const app = express();

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173' }));
app.use(express.json({ limit: '100kb' }));

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Mount /events/replay before /events so it is never shadowed.
app.use('/events/replay', replayRouter);
app.use('/events', eventsRouter);
app.use('/documents', documentsRouter);

// Optional single-process demo mode: serve the built client if it exists.
const clientDist = path.resolve(__dirname, '../../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err?.type === 'entity.too.large') {
    res.status(413).json({ error: 'Request body exceeds the 100KB limit for this endpoint.' });
    return;
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Request body is not valid JSON.' });
    return;
  }
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: 'An unexpected server error occurred.' });
};
app.use(errorHandler);

const port = Number(process.env.PORT ?? 4000);
if (require.main === module) {
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Conflict resolution engine listening on http://localhost:${port}`);
  });
}

export default app;
