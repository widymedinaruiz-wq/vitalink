// Bring-your-own-key AI calls: the provider is chosen from the key, and each provider
// gets its own request shape and its own way of reading the reply. A mistake here either
// sends a key to the wrong company or silently breaks every estimate for one provider.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(process.env.VL_INDEX_HTML || path.join(__dirname, '..', 'app', 'index.html'), 'utf8');

function load() {
  const begin = html.indexOf('/* ================= ai provider (begin) ================= */');
  const end = html.indexOf('/* ================= ai provider (end) ================= */');
  assert.ok(begin !== -1 && end > begin, 'ai provider block markers not found');
  const names = ['AI_PROVIDERS', 'aiProviderForKey', 'isValidAiModel', 'pickRemoteAiModels', 'buildAiRequest', 'readAiText'];
  return vm.runInNewContext(`${html.slice(begin, end)}\n({${names.join(',')}})`, { Object, String, Array });
}
const plain = (v) => JSON.parse(JSON.stringify(v));
const PHOTO = 'data:image/jpeg;base64,QUJD';

test('an Anthropic key is only ever sent to Anthropic', () => {
  const ai = load();
  assert.equal(ai.aiProviderForKey('sk-ant-api03-abc'), 'anthropic');
  assert.equal(ai.aiProviderForKey('  sk-ant-api03-abc '), 'anthropic');
  const req = ai.buildAiRequest('anthropic', 'sk-ant-api03-abc', 'claude-sonnet-5', { prompt: 'hola', maxTokens: 300 });
  assert.equal(new URL(req.url).host, 'api.anthropic.com');
  assert.equal(req.headers['x-api-key'], 'sk-ant-api03-abc');
  assert.equal(req.headers.Authorization, undefined);
});

test('any other key goes to OpenAI', () => {
  const ai = load();
  for (const key of ['sk-proj-abc', 'sk-abc123']) {
    assert.equal(ai.aiProviderForKey(key), 'openai');
    const req = ai.buildAiRequest('openai', key, 'gpt-6.1-sol', { prompt: 'hola', maxTokens: 300 });
    assert.equal(new URL(req.url).host, 'api.openai.com');
    assert.equal(req.headers.Authorization, 'Bearer ' + key);
    assert.equal(req.headers['x-api-key'], undefined);
  }
});

test('Anthropic request: text and photo shapes', () => {
  const ai = load();
  const text = ai.buildAiRequest('anthropic', 'k', 'claude-sonnet-5', { prompt: 'p', maxTokens: 300 });
  assert.deepEqual(plain(text.body), { model: 'claude-sonnet-5', max_tokens: 300, messages: [{ role: 'user', content: 'p' }] });
  const photo = ai.buildAiRequest('anthropic', 'k', 'claude-sonnet-5', { prompt: 'p', images: [PHOTO], maxTokens: 1024 });
  assert.deepEqual(plain(photo.body.messages[0].content), [
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
    { type: 'text', text: 'p' },
  ]);
});

test('OpenAI request: text and photo shapes, with room for reasoning tokens', () => {
  const ai = load();
  const text = ai.buildAiRequest('openai', 'k', 'gpt-6.1-sol', { prompt: 'p', maxTokens: 300 });
  assert.equal(text.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(text.body.model, 'gpt-6.1-sol');
  assert.equal(text.body.max_tokens, undefined);
  assert.ok(text.body.max_completion_tokens > 300, 'no headroom for reasoning tokens');
  assert.deepEqual(plain(text.body.messages), [{ role: 'user', content: 'p' }]);
  const photo = ai.buildAiRequest('openai', 'k', 'gpt-6.1-sol', { prompt: 'p', images: [PHOTO, PHOTO], maxTokens: 1024 });
  assert.deepEqual(plain(photo.body.messages[0].content), [
    { type: 'image_url', image_url: { url: PHOTO } },
    { type: 'image_url', image_url: { url: PHOTO } },
    { type: 'text', text: 'p' },
  ]);
});

test('the reply text is read from each provider\'s own response shape', () => {
  const ai = load();
  assert.equal(ai.readAiText('anthropic', { content: [{ type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }] }), '{"a":1}');
  assert.equal(ai.readAiText('openai', { choices: [{ message: { role: 'assistant', content: '{"a":1}' } }] }), '{"a":1}');
  assert.equal(ai.readAiText('openai', { choices: [{ message: { content: [{ type: 'text', text: 'hola' }] } }] }), 'hola');
  // An empty or unexpected answer must read as empty text, not throw: the callers turn
  // that into their own "bad response" message.
  for (const data of [null, {}, { choices: [] }, { choices: [{ message: { content: null } }] }]) {
    assert.equal(ai.readAiText('openai', data), '');
  }
  assert.equal(ai.readAiText('anthropic', {}), '');
});

test('config.json: each provider only accepts its own well-formed model id', () => {
  const ai = load();
  assert.deepEqual(plain(ai.pickRemoteAiModels({ aiModel: 'claude-sonnet-5', aiModelOpenAI: 'gpt-6.1-sol' })),
    { aiModel: 'claude-sonnet-5', aiModelOpenAI: 'gpt-6.1-sol' });
  assert.deepEqual(plain(ai.pickRemoteAiModels({ aiModel: 'gpt-6.1-sol', aiModelOpenAI: 'claude-sonnet-5' })), {});
  assert.deepEqual(plain(ai.pickRemoteAiModels({ aiModel: 'claude-sonnet-5', aiModelOpenAI: 'gpt 6"; drop' })), { aiModel: 'claude-sonnet-5' });
  assert.deepEqual(plain(ai.pickRemoteAiModels(null)), {});
});

test('the published config.json and the built-in defaults are valid for their provider', () => {
  const ai = load();
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  for (const [provider, p] of Object.entries(ai.AI_PROVIDERS)) {
    assert.ok(ai.isValidAiModel(provider, p.defaultModel), `${provider}: built-in default model is not valid`);
    assert.ok(ai.isValidAiModel(provider, cfg[p.configField]), `config.json: ${p.configField} is missing or not valid`);
  }
});

test('no call site talks to a provider directly any more', () => {
  const begin = html.indexOf('/* ================= ai provider (begin) ================= */');
  const end = html.indexOf('/* ================= ai provider (end) ================= */');
  const rest = html.slice(0, begin) + html.slice(end);
  assert.ok(!/api\.anthropic\.com|api\.openai\.com/.test(rest), 'a provider URL is used outside the ai provider block');
});
