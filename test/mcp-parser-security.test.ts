import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("keeps the SDK Express parser alive after trailing compressed-body bytes", () => {
  // Keep a parser crash inside a child process. Exercise the SDK's own parser
  // dependency and send the trailing bytes only after decoding has completed.
  const result = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { request } from 'node:http';
    import { deflateSync } from 'node:zlib';
    import { once } from 'node:events';
    import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';

    const app = createMcpExpressApp();
    let pendingRequest;
    app.post('/probe', (req, res) => {
      assert.deepEqual(req.body, { probe: 'recall' });
      req.on('end', () => res.json(req.body));
      pendingRequest.end(Buffer.alloc(1024, 88));
    });
    app.get('/health', (_req, res) => res.send('healthy'));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    try {
      const first = Buffer.concat([
        deflateSync(JSON.stringify({ probe: 'recall' })), Buffer.from([0]),
      ]);
      await new Promise((resolve, reject) => {
        pendingRequest = request({
          host: '127.0.0.1', port, method: 'POST', path: '/probe', agent: false,
          headers: { 'content-type': 'application/json', 'content-encoding': 'deflate',
            'content-length': first.length + 1024 },
        }, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => {
            try {
              assert.equal(res.statusCode, 200);
              assert.deepEqual(JSON.parse(body), { probe: 'recall' });
              resolve();
            } catch (error) { reject(error); }
          });
        });
        pendingRequest.on('error', reject);
        pendingRequest.setTimeout(2000, () => pendingRequest.destroy(new Error('request stalled')));
        pendingRequest.write(first);
      });
      assert.equal(await (await fetch('http://127.0.0.1:' + port + '/health')).text(), 'healthy');
      console.log('parser survived');
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  `], { encoding: "utf8", timeout: 10_000 });
  expect(result.trim()).toBe("parser survived");
});
