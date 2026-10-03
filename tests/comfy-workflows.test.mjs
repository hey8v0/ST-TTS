import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
const source = new URL(existsSync(new URL('../staging/extension/core/backend.js', import.meta.url)) ? '../staging/extension/' : '../', import.meta.url);
const require = createRequire(import.meta.url);
const dependency = name => require(existsSync(new URL('./node-dom/node_modules/' + name, import.meta.url)) ? './node-dom/node_modules/' + name : name);
const {IDBFactory} = dependency('fake-indexeddb'), {JSDOM} = dependency('jsdom');
const {TTSBackend} = await import(new URL('core/backend.js', source));
const {freshState} = await import(new URL('core/state.js', source));
const {defaultComfy, normalizeComfy, DEFAULT_COMFY_WORKFLOW} = await import(new URL('core/image-engines.js', source));
const {drawApp} = await import(new URL('ui/draw.js', source));
const {enginesApp} = await import(new URL('ui/engines.js', source));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2, 3, 4]).toString('base64');
function workflow(name) {
  const graph = JSON.parse(DEFAULT_COMFY_WORKFLOW);
  graph['10'] = {class_type: 'LoraLoader', inputs: {model: ['4', 0], clip: ['4', 1], lora_name: name + '.safetensors', strength_model: .7, strength_clip: .8}};
  graph['11'] = {class_type: 'LoraLoader', inputs: {model: ['10', 0], clip: ['10', 1], lora_name: 'watercolor.safetensors', strength_model: .4, strength_clip: .5}};
  graph['3'].inputs.model = ['11', 0]; graph['6'].inputs.clip = ['11', 1]; graph['7'].inputs.clip = ['11', 1];
  return JSON.stringify(graph);
}
async function fixture({state = freshState(), persist = () => {}, answer} = {}) {
  const calls = [];
  state.draw.queue.gap = 0;
  const backend = new TTSBackend({settings: state, indexedDB: new IDBFactory(), persist,
    keyStore: {load: () => new Map()}, sink: {stop() {}, close() {}, setVolume() {}, getVolume: () => 1},
    imageFetch: async (url, init) => { const call = {url, body: JSON.parse(init.body)}; calls.push(call); if (answer) { const r = await answer(call); if (r) return r; } return Response.json({format: 'png', data: PNG}); }});
  await backend.initialize();
  return {backend, api: backend.api(), calls};
}

test('legacy workflow migrates intact beside the built-in default; normalization is stable', () => {
  const old = {...defaultComfy(), workflow: workflow('old'), model: 'old-model', steps: 35, width: 768};
  delete old.workflows; delete old.activeWorkflow;
  const now = normalizeComfy(old);
  assert.equal(now.activeWorkflow, 'legacy'); assert.equal(now.workflows.length, 2);
  assert.equal(now.workflows[0].workflow, ''); assert.equal(now.workflows[1].name, '原有工作流');
  assert.equal(now.workflow, old.workflow); assert.equal(now.steps, 35); assert.equal(now.model, 'old-model');
  assert.deepEqual(normalizeComfy(now), now);
  assert.equal(normalizeComfy().workflows.length, 1);
});

test('multiple LoRAs and their strengths survive import and switching; each preset restores its model and generation parameters', async () => {
  const f = await fixture();
  try {
    f.api.saveDraw({engine: 'comfy', comfy: {model: 'base.safetensors'}});
    const a = f.api.saveComfyWorkflow({name: '角色', workflow: workflow('alice')});
    f.api.saveDraw({comfy: {model: 'alice-base.safetensors', steps: 21, width: 768, height: 1024, scale: 4}});
    const b = f.api.saveComfyWorkflow({name: '角色', workflow: workflow('bob')});
    assert.equal(b.name, '角色 (2)');
    f.api.saveDraw({comfy: {model: 'bob-base.safetensors', steps: 32, width: 1024, height: 1536, scale: 7}});
    f.api.selectComfyWorkflow(a.id);
    assert.deepEqual([f.api.getState().draw.comfy.model, f.api.getState().draw.comfy.steps], ['alice-base.safetensors', 21]);
    await f.api.generateImage({prompt: 'cat', params: {width: 768, height: 1024}});
    f.api.selectComfyWorkflow(b.id);
    await f.api.generateImage({prompt: 'dog', params: {width: 1024, height: 1536}});
    const graphs = f.calls.map(call => JSON.parse(call.body.prompt).prompt);
    for (const [i, name] of ['alice', 'bob'].entries()) {
      assert.equal(f.calls[i].url, '/api/sd/comfy/generate');
      assert.equal(graphs[i]['10'].inputs.lora_name, name + '.safetensors');
      assert.deepEqual(graphs[i]['11'], JSON.parse(workflow(name))['11']);
      assert.equal(graphs[i]['10'].inputs.strength_model, .7);
      assert.equal(graphs[i]['4'].inputs.ckpt_name, name + '-base.safetensors');
    }
    assert.deepEqual(graphs.map(g => [g['3'].inputs.steps, g['3'].inputs.cfg, g['5'].inputs.width]), [[21, 4, 768], [32, 7, 1024]]);
    assert.equal(f.api.getState().draw.comfy.workflows.find(p => p.id === a.id).workflow, workflow('alice'));
    f.api.selectComfyWorkflow('default');
    assert.equal(f.api.getState().draw.comfy.workflow, '');
    assert.equal(f.api.getState().draw.comfy.workflows.length, 3);
    assert.equal(f.api.getState().draw.comfy.model, 'base.safetensors');
  } finally { await f.backend.close(); }
});

test('presets, selection and parameters survive reopening and settings backup; deletion preserves the other workflows', async () => {
  let saved;
  const f = await fixture({persist: s => { saved = s; }}), restored = await fixture();
  try {
    const a = f.api.saveComfyWorkflow({name: 'A', workflow: workflow('a')});
    f.api.saveDraw({comfy: {steps: 23}});
    const b = f.api.saveComfyWorkflow({name: 'B', workflow: workflow('b')});
    const renamed = f.api.saveComfyWorkflow({id: b.id, name: '角色 B'});
    assert.equal(renamed.workflow, workflow('b'));
    const reopened = await fixture({state: saved});
    try { assert.deepEqual(reopened.api.getState().draw.comfy, f.api.getState().draw.comfy); } finally { await reopened.backend.close(); }
    const backup = await f.api.exportBackup(['settings']);
    await restored.api.importBackup(backup.blob, {parts: ['settings']});
    assert.deepEqual(restored.api.getState().draw.comfy, f.api.getState().draw.comfy);
    restored.api.deleteComfyWorkflow(a.id);
    assert.equal(restored.api.getState().draw.comfy.activeWorkflow, b.id);
    restored.api.deleteComfyWorkflow(b.id);
    assert.equal(restored.api.getState().draw.comfy.activeWorkflow, 'default');
    assert.throws(() => restored.api.deleteComfyWorkflow('default'), /需要保留/);
  } finally { await f.backend.close(); await restored.backend.close(); }
});

test('invalid and oversized imports, limits and host save failures do not erase saved workflows', async () => {
  let fail = false;
  const f = await fixture({persist: () => { if (fail) throw Error('save failed'); }});
  try {
    f.api.saveComfyWorkflow({name: 'A', workflow: workflow('a')});
    const before = f.api.getState();
    for (const value of ['', '{bad', '{"nodes":[],"links":[]}', '{"1":{"class_type":"SaveImage","inputs":{}}}', workflow('a').replace('watercolor.safetensors', 'x'.repeat(300001))]) assert.throws(() => f.api.saveComfyWorkflow({name: 'bad', workflow: value}));
    assert.throws(() => f.api.saveComfyWorkflow({id: 'default', name: 'replace', workflow: workflow('a')}), /默认工作流/);
    assert.deepEqual(f.api.getState(), before);
    fail = true;
    assert.throws(() => f.api.saveComfyWorkflow({name: 'B', workflow: workflow('b')}), /save failed/);
    assert.deepEqual(f.api.getState(), before); fail = false;
    while (f.api.getState().draw.comfy.workflows.length < 20) f.api.saveComfyWorkflow({name: 'A', workflow: workflow('a')});
    assert.throws(() => f.api.saveComfyWorkflow({name: 'overflow', workflow: workflow('a')}), /最多保存/);
    assert.equal(f.api.getState().draw.comfy.workflows.length, 20);
  } finally { await f.backend.close(); }
});

test('ComfyUI queued jobs keep their submitted snapshot while the next workflow is edited or deleted', async () => {
  const finish = [], started = [];
  const start = [0, 1, 2].map(i => new Promise(resolve => { started[i] = resolve; }));
  const f = await fixture({answer: () => new Promise(resolve => { const i = finish.length; finish.push(resolve); started[i](); })});
  try {
    f.api.saveDraw({engine: 'comfy', comfy: {model: 'base'}});
    const a = f.api.saveComfyWorkflow({name: 'A', workflow: workflow('a')});
    const pending = f.api.generateImage({prompt: 'cat'}); await start[0];
    const queued = f.api.generateImage({prompt: 'dog'});
    assert.equal(f.api.drawQueue().filter(job => job.state === 'waiting').length, 1);
    f.api.selectComfyWorkflow('default'); f.api.deleteComfyWorkflow(a.id);
    f.api.saveDraw({comfy: {steps: 44, url: 'http://comfy-next.test:8188'}});
    f.api.saveComfyWorkflow({name: 'B', workflow: workflow('b')});
    const next = f.api.generateImage({prompt: 'bird'});
    assert.throws(() => f.api.saveDraw({engine: 'gpt'}), /正在生成或排队/);
    finish[0](Response.json({format: 'png', data: PNG})); await pending;
    await start[1]; finish[1](Response.json({format: 'png', data: PNG})); await queued;
    await start[2]; finish[2](Response.json({format: 'png', data: PNG})); await next;
    f.api.selectComfyWorkflow('default');
    assert.deepEqual(f.calls.map(call => JSON.parse(call.body.prompt).prompt['10'].inputs.lora_name), ['a.safetensors', 'a.safetensors', 'b.safetensors']);
    assert.deepEqual(f.calls.map(call => JSON.parse(call.body.prompt).prompt['3'].inputs.steps), [28, 28, 44]);
    assert.deepEqual(f.calls.map(call => call.body.url), ['http://127.0.0.1:8188', 'http://127.0.0.1:8188', 'http://comfy-next.test:8188']);
  } finally { await f.backend.close(); }
});

test('drawing app imports, renames, switches and deletes schemes; engine page only configures connections', async () => {
  const f = await fixture(), dom = new JSDOM('<!doctype html><body></body>'), notices = [];
  f.api.saveDraw({engine: 'comfy'});
  let confirm = false, dialog;
  const api = {...f.api, comfyWorkflows: async () => ['酒馆工作流.json'], comfyWorkflow: async () => workflow('tavern')};
  const ctx = {doc: dom.window.document, win: dom.window, api, notify: s => notices.push(s), help() {}, confirm: async () => confirm,
    dialog: (title, html) => {
      dialog?.close(); const body = dom.window.document.createElement('div'); body.innerHTML = html; dom.window.document.body.append(body);
      const callbacks = []; dialog = {body, live: true, onClose(fn) { callbacks.push(fn); }, close() { this.live = false; body.remove(); for (const fn of callbacks) fn(); }}; return dialog;
    }};
  const engineView = enginesApp(ctx); engineView.edit('comfy');
  assert.equal(engineView.root.querySelector('[data-comfy-file]'), null);
  assert.equal(engineView.root.querySelector('[data-field=comfy-model]'), null); engineView.dispose();
  const view = drawApp(ctx); dom.window.document.body.append(view.root); await tick();
  const q = selector => { const el = dom.window.document.querySelector(selector); assert.ok(el, selector); return el; };
  const click = async action => { q(`[data-action="${action}"]`).click(); await tick(); };
  const pick = async (name, contents) => {
    if (!dom.window.document.querySelector('[data-comfy-file]')) await click('comfy-manage');
    const file = new Blob([contents], {type: 'application/json'}); Object.defineProperty(file, 'name', {value: name});
    const input = q('[data-comfy-file]'); Object.defineProperty(input, 'files', {configurable: true, value: [file]}); input.dispatchEvent(new dom.window.Event('change', {bubbles: true})); await tick();
  };
  try {
    assert.equal(view.root.querySelector('textarea[data-field=comfy-workflow]'), null);
    q('[data-tab=lora]').click(); await tick();
    await pick('bad.json', '{"nodes":[],"links":[]}');
    assert.equal(f.api.getState().draw.comfy.workflows.length, 1); assert.match(notices.at(-1), /导出/);
    await pick('角色.json', workflow('a')); const a = f.api.getState().draw.comfy.activeWorkflow;
    await click('comfy-manage'); q('[data-field=comfy-name]').value = '水彩'; await click('comfy-save-current');
    assert.equal(f.api.getState().draw.comfy.workflows.find(p => p.id === a).name, '水彩');
    await pick('角色.json', workflow('b'));
    q('[data-field=comfy-preset]').value = a; q('[data-field=comfy-preset]').dispatchEvent(new dom.window.Event('change', {bubbles: true})); await tick();
    assert.equal(f.api.getState().draw.comfy.workflow, workflow('a'));
    await click('comfy-manage'); await click('comfy-delete-wf'); q('[data-decision=cancel]').click(); await tick();
    assert.equal(f.api.getState().draw.comfy.workflows.length, 3);
    await click('comfy-delete-wf'); q('[data-decision=yes]').click(); await tick(); assert.equal(f.api.getState().draw.comfy.activeWorkflow, 'default');
    await click('comfy-manage'); await click('comfy-load-wf'); q('[data-wf]').click(); await tick();
    assert.equal(f.api.getState().draw.comfy.workflow, workflow('tavern'));
    assert.equal(f.api.getState().draw.comfy.workflows.length, 3);
    assert.equal(f.api.getComfyDraft().value.name, '酒馆工作流');
  } finally { view.dispose(); dom.window.close(); await f.backend.close(); }
});
