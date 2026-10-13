import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { demos } from './model.mjs';
import { boundedChecks, proofEvidence } from './run.mjs';

const checks = boundedChecks();
const port = Number(process.env.PORT || 4187);
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/api/demos') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ demos: demos(), checks, proof: await proofEvidence() }));
    } else if (req.url === '/' || req.url === '/index.html') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(await readFile(new URL('./index.html', import.meta.url)));
    } else { res.writeHead(404); res.end('Not found'); }
  } catch (error) { res.writeHead(500); res.end('Could not load local demo artifacts'); }
});
server.listen(port, '127.0.0.1', () => console.log(`Security proof demos: http://127.0.0.1:${port}`));
