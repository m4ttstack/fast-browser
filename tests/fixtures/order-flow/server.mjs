import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const page = await readFile(new URL('./index.html', import.meta.url));

export async function startOrderFixture({ port = 0 } = {}) {
  const server = http.createServer((request, response) => {
    if (request.url !== '/') {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page);
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const { port: boundPort } = server.address();
  return {
    origin: `http://127.0.0.1:${boundPort}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const portIndex = process.argv.indexOf('--port');
  const port = portIndex === -1 ? 0 : Number(process.argv[portIndex + 1]);
  const fixture = await startOrderFixture({ port });
  process.stdout.write(`${JSON.stringify({ origin: fixture.origin })}\n`);
}
