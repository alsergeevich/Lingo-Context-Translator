/**
 * Mock DeepSeek-compatible API.
 *
 * Implements just enough of /chat/completions to drive the extension: it parses the
 * "[id] text" protocol out of the user prompt and answers with deterministic "translated"
 * text, deliberately leaving code spans, URLs and identifiers untouched — which is what the
 * skill asks a real model to do. That lets the harnesses verify the whole pipeline
 * (extraction → prompt → validation → DOM) without spending real tokens.
 *
 * It can run standalone (`node tools/mock-api.mjs`) or in-process
 * (`const { startMockServer } = await import('./mock-api.mjs')`), which is what the
 * integration checks use — spawning a detached process is not reliable in a sandbox.
 */
import { createServer } from 'node:http';
import path from 'node:path';

const DICTIONARY = new Map(
  Object.entries({
    hello: 'привет',
    world: 'мир',
    the: '',
    a: '',
    an: '',
    is: '—',
    are: '—',
    this: 'это',
    that: 'этот',
    and: 'и',
    or: 'или',
    of: '',
    to: 'к',
    in: 'в',
    on: 'на',
    for: 'для',
    with: 'с',
    from: 'из',
    by: 'через',
    as: 'как',
    at: 'в',
    it: 'это',
    we: 'мы',
    you: 'вы',
    they: 'они',
    can: 'может',
    will: 'будет',
    be: 'быть',
    not: 'не',
    signal: 'сигнал',
    signals: 'сигналы',
    component: 'компонент',
    components: 'компоненты',
    view: 'представление',
    views: 'представления',
    function: 'функция',
    value: 'значение',
    values: 'значения',
    code: 'код',
    example: 'пример',
    examples: 'примеры',
    page: 'страница',
    state: 'состояние',
    reactive: 'реактивный',
    reactivity: 'реактивность',
    render: 'отрисовка',
    renders: 'отрисовывает',
    change: 'изменение',
    changes: 'изменения',
    chapter: 'глава',
    book: 'книга',
    text: 'текст',
    translation: 'перевод',
    button: 'кнопка',
    click: 'нажатие',
    build: 'сборка',
    project: 'проект',
    compile: 'скомпилировать',
    component: 'компонент',
    basic: 'базовый',
    simple: 'простой',
    app: 'приложение',
    application: 'приложение',
    framework: 'фреймворк',
    frameworks: 'фреймворки',
    unit: 'единица',
    design: 'проектирование',
    similar: 'похожий',
    elements: 'элементы',
    behavior: 'поведение',
    defined: 'определённое',
    self: 'сам',
    contained: 'замкнутый',
  }),
);

function translateWord(word) {
  const lower = word.toLowerCase();
  if (!DICTIONARY.has(lower)) return word;
  const mapped = DICTIONARY.get(lower);
  if (mapped === '') return '';
  return word[0] === word[0].toUpperCase() && word.length > 1 ? mapped[0].toUpperCase() + mapped.slice(1) : mapped;
}

/** Keep code spans, URLs, identifiers and slot markers byte-identical. */
const PROTECTED =
  /(`[^`\n]+`|https?:\/\/\S+|\{\{\/?\d+\}\}|\b[a-zA-Z_][\w]*\(\)|\b[A-Z][A-Z0-9_]{2,}\b|\b\w+\.(?:rs|ts|js|toml|json|md)\b)/g;

export function fakeTranslate(text) {
  const tokens = [];
  const masked = text.replace(PROTECTED, (match) => {
    tokens.push(match);
    return `\u0000${tokens.length - 1}\u0000`;
  });
  const translated = masked
    .split(/(\s+)/)
    .map((chunk) => (/\s/.test(chunk) ? chunk : translateWord(chunk)))
    .join('')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return translated.replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)]);
}

/** Parse "[id] text" blocks from the last user message. */
export function parseSegments(prompt) {
  const blocks = [];
  let current = null;
  for (const line of prompt.split('\n')) {
    const match = /^\s*\[(\d+)\]\s?(.*)$/.exec(line);
    if (match) {
      if (current) blocks.push(current);
      current = { id: Number(match[1]), lines: [match[2]] };
      continue;
    }
    if (current && line.startsWith('  CONTEXT:')) continue;
    if (current && line.trim() === '') {
      blocks.push(current);
      current = null;
      continue;
    }
    if (current && /^Return \d+ blocks/.test(line)) continue;
    if (current) current.lines.push(line);
  }
  if (current) blocks.push(current);
  return blocks;
}

export function createMockServer() {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', ...cors });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname.endsWith('/chat/completions') && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        let payload = {};
        try {
          payload = JSON.parse(body);
        } catch {
          /* ignore malformed bodies */
        }
        const messages = payload.messages ?? [];
        const lastUser = [...messages].reverse().find((message) => message.role === 'user');
        const prompt = lastUser?.content ?? '';
        const blocks = parseSegments(prompt);
        const answer =
          blocks.length > 0
            ? blocks.map((block) => `[${block.id}] ${fakeTranslate(block.lines.join(' '))}`).join('\n')
            : fakeTranslate(prompt);

        res.writeHead(200, { 'content-type': 'application/json', ...cors });
        res.end(
          JSON.stringify({
            id: 'mock-1',
            object: 'chat.completion',
            model: payload.model ?? 'mock-model',
            choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: Math.ceil(prompt.length / 4),
              completion_tokens: Math.ceil(answer.length / 4),
            },
          }),
        );
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
}

/** Start the mock on an ephemeral port (or the given one) and resolve with its URL. */
export async function startMockServer(port = 0) {
  const server = createMockServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  const actual = typeof address === 'object' && address ? address.port : port;
  return {
    url: `http://127.0.0.1:${actual}`,
    port: actual,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// Standalone mode: `node tools/mock-api.mjs [port]`
const isStandalone = process.argv[1] && path.basename(process.argv[1]) === 'mock-api.mjs';
if (isStandalone) {
  const port = Number(process.argv[2] ?? process.env.MOCK_PORT ?? 8787);
  const instance = await startMockServer(port);
  console.log(`[mock] DeepSeek-compatible API on ${instance.url}`);
}
