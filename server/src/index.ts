/**
 * Elsewhere server entry: one HTTP port serves the built client, the REST API
 * and the Colyseus websocket/matchmaking endpoints.
 */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { defineRoom, defineServer } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { ROOM_NAME } from '@elsewhere/shared';
import { ENV } from './env.js';
import { createApiRouter } from './http/api.js';
import { WorldRoom } from './rooms/WorldRoom.js';
import { initServices } from './services.js';

async function main(): Promise<void> {
  const svc = await initServices();

  const server = defineServer({
    rooms: { [ROOM_NAME]: defineRoom(WorldRoom) },
    transport: new WebSocketTransport({ maxPayload: 16 * 1024 }),
    greet: false,
    express: (app) => {
      app.disable('x-powered-by');
      app.use(createApiRouter());

      const indexHtml = path.join(ENV.clientDist, 'index.html');
      if (fs.existsSync(indexHtml)) {
        app.use(express.static(ENV.clientDist, { index: false, maxAge: ENV.isProduction ? '1h' : 0 }));
        // SPA fallback (explicit "/" so Colyseus does not register its own root route).
        app.get('/', (_req, res) => res.sendFile(indexHtml));
        app.get(/^\/(?!api\/|matchmake\/).*/, (_req, res) => res.sendFile(indexHtml));
      } else {
        app.get('/', (_req, res) => {
          res.type('text/plain').send('Elsewhere server is running. Client build not found — run `npm run build` (or use `npm run dev`).');
        });
      }
    },
  });

  await server.listen(ENV.port);
  console.log(`[elsewhere] listening on http://localhost:${ENV.port} (client: ${fs.existsSync(ENV.clientDist) ? ENV.clientDist : 'not built'})`);

  const shutdown = async () => {
    svc.gazette.stop();
    await svc.persistence.close();
  };
  server.onShutdown(shutdown);
}

main().catch((err) => {
  console.error('[elsewhere] failed to start', err);
  process.exit(1);
});
