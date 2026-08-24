/**
 * Minimal OpenAI-compatible fake backend, for tests that need a chat
 * completion round trip without hitting a real LLM. node:http only — no
 * new dependency. Not a general mock; just enough surface for houtini-lm's
 * client code to complete a streaming or non-streaming request.
 */
import { createServer } from 'node:http';

export function startFakeBackend({ port = 0 } = {}) {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [{ id: 'fake-model', object: 'model', created: 0, owned_by: 'fake' }],
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(body || '{}');
        } catch {
          parsed = {};
        }

        if (parsed.stream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });

          const chunkText = ['Hello', ', ', 'this ', 'is ', 'fake.'];
          let i = 0;
          const sendNext = () => {
            if (i >= chunkText.length) {
              res.write(`data: ${JSON.stringify({
                id: 'fake-chunk-final',
                object: 'chat.completion.chunk',
                created: 0,
                model: 'fake-model',
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }
            res.write(`data: ${JSON.stringify({
              id: 'fake-chunk',
              object: 'chat.completion.chunk',
              created: 0,
              model: 'fake-model',
              choices: [{ index: 0, delta: { content: chunkText[i] }, finish_reason: null }],
            })}\n\n`);
            i++;
            setTimeout(sendNext, 200);
          };
          sendNext();
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'fake-completion',
          object: 'chat.completion',
          created: 0,
          model: 'fake-model',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Hello, this is fake.' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((res2) => server.close(() => res2())),
      });
    });
  });
}
