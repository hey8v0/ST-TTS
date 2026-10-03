import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';

// Runs in the maintenance workspace and in the extension repository's tests/ folder.
const source = new URL(existsSync(new URL('../staging/extension/core/backend.js', import.meta.url)) ? '../staging/extension/' : '../', import.meta.url);
const require = createRequire(import.meta.url);
const dependency = name => require(existsSync(new URL('./node-dom/node_modules/' + name, import.meta.url)) ? './node-dom/node_modules/' + name : name);
const {IDBFactory} = dependency('fake-indexeddb'), {JSDOM} = dependency('jsdom');
const {TTSBackend} = await import(new URL('core/backend.js', source));
const {freshState} = await import(new URL('core/state.js', source));
const {KeyStore, LocalKeyStore} = await import(new URL('core/keys.js', source));
const {NovelAIClient} = await import(new URL('core/novelai.js', source));
const {enginesApp} = await import(new URL('ui/engines.js', source));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const memory = () => { const map = new Map(); return {getItem: k => map.get(k) || null, setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k)}; };
const sink = {stop() {}, close() {}, setVolume() {}, getVolume: () => 1};
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2, 3, 4]);
function zip() {
  const file = Buffer.from('image.png'), local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt32LE(PNG.length, 18); local.writeUInt32LE(PNG.length, 22); local.writeUInt16LE(file.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt32LE(PNG.length, 20); central.writeUInt32LE(PNG.length, 24); central.writeUInt16LE(file.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + file.length, 12); end.writeUInt32LE(local.length + file.length + PNG.length, 16);
  return Buffer.concat([local, file, PNG, central, file, end]);
}
async function fixture({state = freshState(), db = new IDBFactory(), storage = memory(), persist = () => {}, answer} = {}) {
  const calls = [];
  state.draw.queue.gap = 0;
  const fetch = async (url, init = {}) => {
    const call = {url, auth: init.headers?.Authorization, body: init.body ? JSON.parse(init.body) : null}; calls.push(call);
    if (answer) { const response = await answer(call); if (response) return response; }
    if (url.endsWith('/user/subscription')) return Response.json({tier: 3, active: true, trainingStepsLeft: {fixedTrainingStepsLeft: 100}});
    if (url.endsWith('/images/generations')) return Response.json({data: [{b64_json: PNG.toString('base64')}]});
    return new Response(zip());
  };
  const keyStore = new KeyStore(state.scope, {indexedDB: db, storage: () => storage});
  const backend = new TTSBackend({settings: state, indexedDB: db, keyStore, sink, persist, imageFetch: fetch, novelai: new NovelAIClient(fetch)});
  await backend.initialize();
  return {backend, api: backend.api(), calls, db, storage, keyStore};
}

for (const engine of ['nai', 'gpt']) test(`${engine}: legacy key migrates; endpoint, key and model switch together and survive reopening`, async () => {
  const state = freshState(), storage = memory(), legacyKey = 'test-legacy-key-1111';
  delete state.draw.connections;
  if (engine === 'nai') state.draw.relay = {url: 'https://old.test', assumeOpus: true};
  else state.draw.gpt = {...state.draw.gpt, url: 'https://old.test/v1', model: 'gpt-image-1-mini'};
  state.draw.engine = engine;
  new LocalKeyStore(state.scope, () => storage).save(engine, legacyKey);
  const f = await fixture({state, storage}), {api} = f;
  try {
    assert.equal(api.imageConnectionList(engine)[0].id, 'default');
    assert.equal(api.keyHint(engine), '1111');
    const b = api.saveImageConnection(engine, {name: '备用中转', url: 'https://second.test', model: 'gpt-image-1.5', assumeOpus: false});
    assert.equal(api.keyStatus(engine), false, 'a new endpoint never inherits another endpoint’s secret');
    api.setKey(engine, 'test-second-key-2222');
    await api.generateImage({prompt: '1girl', allowPaid: true});
    const sent = f.calls.at(-1);
    assert.equal(sent.auth, 'Bearer test-second-key-2222');
    assert.match(sent.url, /^https:\/\/second.test\//);
    if (engine === 'gpt') assert.equal(sent.body.model, 'gpt-image-1.5');
    api.selectImageConnection(engine, 'default');
    await api.generateImage({prompt: '1girl', allowPaid: true});
    assert.equal(f.calls.at(-1).auth, 'Bearer ' + legacyKey);
    assert.match(f.calls.at(-1).url, /^https:\/\/old.test\//);
    if (engine === 'nai') assert.equal(api.getState().draw.relay.assumeOpus, true);
    else assert.equal(f.calls.at(-1).body.model, 'gpt-image-1-mini');
    api.saveDraw(engine === 'nai' ? {relay: {url: 'https://edited.test'}} : {gpt: {url: 'https://edited.test', model: 'gpt-image-1'}});
    assert.match(api.imageConnectionList(engine)[0].url, /^https:\/\/edited.test/);
    assert.match(api.imageConnectionList(engine)[1].url, /^https:\/\/second.test/);
    api.selectImageConnection(engine, b.id);
    const saved = api.getState();
    assert.doesNotMatch(JSON.stringify(saved), /test-(legacy|second)-key/);
    assert.doesNotMatch(JSON.stringify(api.imageConnectionList(engine)), /test-(legacy|second)-key/);
    await f.keyStore.flush(); await f.backend.close();
    const reopened = await fixture({state: saved, db: f.db, storage});
    try {
      assert.equal(reopened.api.getState().draw.connections[engine].active, b.id);
      assert.equal(reopened.api.keyHint(engine), '2222');
      reopened.api.deleteImageConnection(engine, b.id);
      assert.equal(reopened.api.keyHint(engine), '1111');
      assert.doesNotMatch(reopened.keyStore.load().get(engine), /2222/);
      assert.throws(() => reopened.api.deleteImageConnection(engine, 'default'), /至少保留/);
    } finally { await reopened.backend.close(); }
  } finally { await f.backend.close(); }
});

test('encrypted backup restores every image connection and key; clearing affects only the active one', async () => {
  const f = await fixture(), other = await fixture();
  try {
    for (const engine of ['nai', 'gpt']) {
      f.api.setKey(engine, `test-${engine}-first-1111`);
      f.api.saveImageConnection(engine, {name: engine + '备用', url: 'https://relay.test', key: `test-${engine}-second-2222`});
    }
    const plain = await f.api.exportBackup(['settings']);
    assert.doesNotMatch(await plain.blob.text(), /test-(nai|gpt)-(first|second)/);
    const sealed = await f.api.exportBackup(['settings', 'keys'], '', {password: 'test-password'});
    await other.api.importBackup(sealed.blob, {parts: ['settings', 'keys'], password: 'test-password'});
    for (const engine of ['nai', 'gpt']) {
      assert.equal(other.api.imageConnectionList(engine).length, 2);
      assert.equal(other.api.keyHint(engine), '2222');
      other.api.clearKey(engine);
      assert.equal(other.api.keyStatus(engine), false);
      other.api.selectImageConnection(engine, 'default');
      assert.equal(other.api.keyHint(engine), '1111');
    }
  } finally { await f.backend.close(); await other.backend.close(); }
});

test('failed validation or persistence leaves the previous endpoint and secret together', async () => {
  let fail = false;
  const f = await fixture({persist: () => { if (fail) throw Error('host did not save'); }});
  try {
    f.api.setKey('gpt', 'test-first-1111');
    const before = f.api.getState();
    assert.throws(() => f.api.saveImageConnection('gpt', {id: 'default', url: 'ftp://bad', key: 'test-second-2222'}), /地址格式/);
    fail = true;
    assert.throws(() => f.api.saveImageConnection('gpt', {id: 'default', url: 'https://second.test', key: 'test-second-2222'}), /host did not save/);
    assert.deepEqual(f.api.getState(), before);
    assert.equal(f.api.keyHint('gpt'), '1111');
    assert.doesNotMatch(f.keyStore.load().get('gpt'), /2222/);
    fail = false;
    const save = f.keyStore.save;
    f.keyStore.save = () => { throw Error('key storage did not save'); };
    assert.throws(() => f.api.saveImageConnection('gpt', {id: 'default', url: 'https://second.test', key: 'test-second-2222'}), /key storage/);
    assert.deepEqual(f.api.getState(), before);
    assert.equal(f.api.keyHint('gpt'), '1111');
    f.keyStore.save = save;
  } finally { await f.backend.close(); }
});

test('an old subscription response cannot overwrite the newly selected account', async () => {
  let finish;
  const f = await fixture({answer: call => call.url.includes('old.test') ? new Promise(resolve => { finish = resolve; }) : null});
  try {
    f.api.saveImageConnection('nai', {id: 'default', url: 'https://old.test', key: 'test-old-1111'});
    const pending = f.api.naiSubscription(true);
    f.api.saveImageConnection('nai', {url: 'https://new.test', key: 'test-new-2222'});
    const latest = await f.api.naiSubscription(true);
    finish(Response.json({tier: 1, active: true}));
    assert.equal(await pending, null);
    assert.equal((await f.api.naiSubscription()).tier, latest.tier);
    assert.equal(latest.tier, 3);
  } finally { await f.backend.close(); }
});

test('queued images keep their connection until finished; switching works immediately after completion', async () => {
  let finish, started;
  const start = new Promise(resolve => { started = resolve; });
  const f = await fixture({answer: call => call.url.endsWith('/images/generations') ? new Promise(resolve => { finish = resolve; started(); }) : null});
  try {
    f.api.saveDraw({engine: 'gpt'}); f.api.setKey('gpt', 'test-first-1111');
    const b = f.api.saveImageConnection('gpt', {url: 'https://second.test', key: 'test-second-2222'});
    f.api.selectImageConnection('gpt', 'default');
    const pending = f.api.generateImage({prompt: 'cat', allowPaid: true}); await start;
    for (const change of [() => f.api.selectImageConnection('gpt', b.id), () => f.api.setKey('gpt', 'test-other-3333'), () => f.api.deleteImageConnection('gpt', b.id), () => f.api.saveDraw({gpt: {url: 'https://third.test'}}), () => f.api.saveDraw({engine: 'nai'})]) assert.throws(change, /正在生成或排队/);
    finish(Response.json({data: [{b64_json: PNG.toString('base64')}]})); await pending;
    assert.equal(f.calls[0].auth, 'Bearer test-first-1111');
    f.api.selectImageConnection('gpt', b.id); assert.equal(f.api.keyHint('gpt'), '2222');
  } finally { await f.backend.close(); }
});

test('a subscription finishing in the background preserves the connection form being typed', async () => {
  const f = await fixture(), dom = new JSDOM('<!doctype html><body></body>');
  let finish;
  const api = {...f.api, naiSubscription: () => new Promise(resolve => { finish = resolve; })};
  const view = enginesApp({doc: dom.window.document, win: dom.window, api, notify() {}, help() {}});
  try {
    view.edit('nai');
    view.root.querySelector('[data-field=image-name]').value = '正在编辑';
    view.root.querySelector('[data-field=key]').value = 'test-draft-1234';
    view.root.querySelector('[data-field=relay]').value = 'https://draft.test';
    finish({tier: 3, anlas: 100}); await tick();
    assert.equal(view.root.querySelector('[data-field=image-name]').value, '正在编辑');
    assert.equal(view.root.querySelector('[data-field=key]').value, 'test-draft-1234');
    assert.equal(view.root.querySelector('[data-field=relay]').value, 'https://draft.test');
    assert.equal(f.api.keyStatus('nai'), false, 'typing is still a draft');
  } finally { view.dispose(); dom.window.close(); await f.backend.close(); }
});

for (const engine of ['nai', 'gpt']) test(`${engine} UI: create, save the whole form, switch, cancel discarding edits, clear and delete`, async () => {
  const f = await fixture(), dom = new JSDOM('<!doctype html><body></body>'), errors = [];
  let confirm = true;
  const view = enginesApp({doc: dom.window.document, win: dom.window, api: f.api, notify: (s, options) => { if (options?.error) errors.push(s); }, confirm: async () => confirm, help() {}});
  const q = selector => { const el = view.root.querySelector(selector); assert.ok(el, selector); return el; };
  const click = async action => { q(`[data-action="${action}"]`).click(); await tick(); };
  const set = (name, value) => { q(`[data-field="${name}"]`).value = value; };
  try {
    view.edit(engine); await tick();
    set('image-name', '官方'); set('key', 'test-official-1111'); await click('image-save');
    await click('image-new');
    assert.equal(f.api.keyStatus(engine), false); assert.equal(q('[data-field=key]').value, '');
    set('image-name', '备用'); set(engine === 'nai' ? 'relay' : 'gpt-url', 'https://relay.test'); set('key', 'test-relay-2222');
    // The old address save button also saves the key and name, instead of dropping typed fields.
    await click(engine === 'nai' ? 'save-relay' : 'save-gpt-url');
    const second = f.api.getState().draw.connections[engine].active;
    assert.equal(f.api.keyHint(engine), '2222'); assert.match(view.root.textContent, /备用/);
    assert.doesNotMatch(view.root.innerHTML, /test-(official-1111|relay-2222)/);
    set('image-name', '还没保存'); confirm = false;
    q('[data-action=image-connection][data-id=default]').click(); await tick();
    assert.equal(f.api.getState().draw.connections[engine].active, second);
    assert.equal(q('[data-field=image-name]').value, '还没保存');
    confirm = true; q('[data-action=image-connection][data-id=default]').click(); await tick();
    assert.equal(f.api.keyHint(engine), '1111');
    q(`[data-action=image-connection][data-id="${second}"]`).click(); await tick();
    await click('clear-key'); assert.equal(f.api.keyStatus(engine), false);
    assert.equal(f.api.imageConnectionList(engine)[0].configured, true);
    await click('image-delete'); assert.equal(f.api.keyHint(engine), '1111');
    assert.equal(f.api.imageConnectionList(engine).length, 1);
    assert.deepEqual(errors, []);
  } finally { view.dispose(); dom.window.close(); await f.backend.close(); }
});
