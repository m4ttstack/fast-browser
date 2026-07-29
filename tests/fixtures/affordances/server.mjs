import { readFile } from 'node:fs/promises';
import http from 'node:http';

const page = await readFile(new URL('./index.html', import.meta.url));

// Served over http rather than as a data: URL so that the fixture's relative
// hrefs resolve to real absolute addresses, which is what the macro reports and
// what a caller would follow.
export async function startAffordanceFixture({ port = 0 } = {}) {
  const server = http.createServer((request, response) => {
    if (request.url !== '/') {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page);
  });
  // A real browser tab can leave a connected-but-idle socket open (Chrome
  // keep-alive) that server.close() would otherwise wait on indefinitely.
  // Track every open socket and destroy them ourselves so close() resolves
  // promptly with tabs still open.
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const { port: boundPort } = server.address();
  return {
    origin: `http://127.0.0.1:${boundPort}`,
    close: () => new Promise((resolve, reject) => {
      for (const socket of sockets) socket.destroy();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
