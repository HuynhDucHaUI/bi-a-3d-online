import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Server } from 'socket.io';
import type { ClientToServer, ServerToClient } from '../../shared/protocol';
import { Hub } from './hub';

const PORT = Number(process.env.PORT ?? 3000);
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../../client/dist');

const app = express();
const http = createServer(app);
const io = new Server<ClientToServer, ServerToClient>(http, {
  cors: { origin: true },
  pingInterval: 10000,
  pingTimeout: 15000,
});
const hub = new Hub(io);

app.get('/health', (_req, res) => res.json({ ok: true, ...hub.stats() }));

if (existsSync(dist)) {
  app.use(express.static(dist, { maxAge: '1h' }));
  app.use((_req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  app.get('/', (_req, res) => res.send('Server bi-a đang chạy. Chạy "npm run build" để phục vụ giao diện, hoặc "npm run dev".'));
}

http.listen(PORT, () => console.log(`Bi-a server lắng nghe tại http://localhost:${PORT}`));
