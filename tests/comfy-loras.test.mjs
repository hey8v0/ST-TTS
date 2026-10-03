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
const {DEFAULT_COMFY_WORKFLOW: BASE, comfyLoras} = await import(new URL('core/image-engines.js', source));
const {inspectLoras, editLoras, activeLoraWorkflow} = await import(new URL('core/comfy-loras.js', source));
const {editComfyLoras} = await import(new URL('ui/comfy-loras.js', source));
const {comfyLoraPanel} = await import(new URL('ui/comfy-lora-panel.js', source));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const add = (text, file, source = '4') => editLoras(text, {add: {source, lora_name: file, strength_model: .8, strength_clip: .6}});
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2, 3, 4]).toString('base64');
async function fixture({state = freshState(), persist = () => {}} = {}) {
  state.draw.queue.gap = 0;
  const calls = [], backend = new TTSBackend({settings: state, persist, indexedDB: new IDBFactory(), keyStore: {load: () => new Map()},
    sink: {stop() {}, close() {}, setVolume() {}, getVolume: () => 1},
    imageFetch: async (url, init) => { calls.push({url, body: JSON.parse(init.body)}); return Response.json({format: 'png', data: PNG}); }});
  await backend.initialize(); return {api: backend.api(), backend, calls};
}
function editor(f, overrides = {}, options = {}) {
  const dom = new JSDOM('<!doctype html><body></body>'), notices = [], callbacks = [];
  const d = {body: dom.window.document.body, live: true, onClose(fn) { callbacks.push(fn); }, close(v) { if (!this.live) return; this.live = false; callbacks.forEach(fn => fn(v)); }};
  editComfyLoras({api: {...f.api, ...overrides}, doc: dom.window.document, win: dom.window, dialog: () => d, notify: s => notices.push(s)}, () => {}, options);
  const q = s => { const el = d.body.querySelector(s); assert.ok(el, s); return el; };
  const set = (field, value) => { const el = q(`[data-field=${field}]`); el.value = value; el.dispatchEvent(new dom.window.Event('input', {bubbles: true})); };
  const click = async action => { q(`[data-action=${action}]`).click(); await tick(); };
  return {dom, d, q, set, click, notices, close() { d.close(); dom.window.close(); }};
}

test('native LoRAs insert as a connected chain and preserve VAE, custom inputs and the original template', () => {
  const original = JSON.parse(BASE); original['20'] = {class_type: 'CustomPreview', inputs: {model: ['4', 0], other: 'keep'}};
  const input = JSON.stringify(original), a = add(input, 'characters/alice.safetensors'), aId = inspectLoras(a).nodes[0].id;
  const b = add(a, 'styles/watercolor.safetensors', aId), nodes = inspectLoras(b).nodes, bId = nodes.find(n => n.id !== aId).id, graph = JSON.parse(b);
  assert.deepEqual(graph[bId].inputs.model, [aId, 0]); assert.deepEqual(graph[bId].inputs.clip, [aId, 1]);
  assert.deepEqual(graph['3'].inputs.model, [bId, 0]); assert.deepEqual(graph['6'].inputs.clip, [bId, 1]); assert.deepEqual(graph['7'].inputs.clip, [bId, 1]);
  assert.deepEqual(graph['8'], original['8']); assert.deepEqual(graph['20'].inputs, {model: [bId, 0], other: 'keep'});
  assert.deepEqual(JSON.parse(input), original); assert.equal(graph[aId].inputs.strength_model, .8);
});

test('disable bypasses native LoRAs only in the request, removal reconnects both ports, model-only nodes stay model-only', () => {
  const a = add(BASE, 'a.safetensors'), aId = inspectLoras(a).nodes[0].id;
  const b = add(a, 'b.safetensors', aId), bId = inspectLoras(b).nodes.find(n => n.id !== aId).id;
  const disabled = JSON.parse(activeLoraWorkflow(b, [aId, bId]));
  assert.deepEqual(disabled, JSON.parse(BASE)); assert.equal(inspectLoras(b).nodes.length, 2);
  const removed = JSON.parse(editLoras(b, {remove: aId})); assert.deepEqual(removed[bId].inputs.model, ['4', 0]); assert.deepEqual(removed[bId].inputs.clip, ['4', 1]);
  const modelOnly = JSON.parse(BASE); modelOnly['4'] = {class_type: 'UNETLoader', inputs: {unet_name: 'flux.safetensors'}};
  modelOnly['10'] = {class_type: 'CLIPLoader', inputs: {clip_name: 'clip.safetensors'}};
  modelOnly['6'].inputs.clip = ['10', 0]; modelOnly['7'].inputs.clip = ['10', 0];
  const edited = add(JSON.stringify(modelOnly), 'flux-lora.safetensors'), row = inspectLoras(edited).nodes[0], graph = JSON.parse(edited);
  assert.equal(row.modelOnly, true); assert.equal(graph[row.id].inputs.clip, undefined); assert.deepEqual(graph['6'].inputs.clip, ['10', 0]);
});

test('unsafe graph edits fail without changing input: dynamic fields, unknown ports, cycles, unsupported sources and invalid strengths', () => {
  const a = add(BASE, 'a.safetensors'), id = inspectLoras(a).nodes[0].id;
  for (const value of ['', NaN, Infinity, 101, -101]) assert.throws(() => editLoras(a, {updates: [{id, strength_model: value}]}), /强度/);
  assert.throws(() => editLoras(a, {add: {source: '9', lora_name: 'a'}}), /接入位置/);
  assert.throws(() => editLoras(a, {remove: '4'}), /原生/);
  const dynamic = JSON.parse(a); dynamic[id].inputs.lora_name = ['20', 0]; dynamic['20'] = {class_type: 'StringProvider', inputs: {value: 'x'}};
  assert.match(inspectLoras(JSON.stringify(dynamic)).nodes[0].reason, /其他节点/);
  assert.throws(() => editLoras(JSON.stringify(dynamic), {updates: [{id, lora_name: 'x'}]}), /其他节点/);
  const odd = JSON.parse(a); odd['3'].inputs.model = [id, 2]; assert.throws(() => editLoras(JSON.stringify(odd), {remove: id}), /输出接线/);
  const cycle = JSON.parse(a); cycle['4'].inputs.model = [id, 0]; assert.throws(() => editLoras(JSON.stringify(cycle), {remove: id}), /循环/);
  assert.equal(inspectLoras(a).nodes[0].name, 'a.safetensors');
});

test('native catalogue uses the selected route, deduplicates names and reports missing proxy or unsupported metadata', async () => {
  const calls = [], data = {LoraLoader: {input: {required: {lora_name: [['b.safetensors', 'a.safetensors', 'a.safetensors']]}}}};
  const fetch = async (url, init) => { calls.push({url, init}); return Response.json(data); };
  assert.deepEqual(await comfyLoras({fetch, url: 'http://comfy.test:8188/sub'}), ['a.safetensors', 'b.safetensors']);
  await comfyLoras({fetch, url: 'http://comfy.test:8188', transport: 'direct'});
  assert.equal(calls[0].url, '/proxy/http://comfy.test:8188/sub/object_info/LoraLoader');
  assert.equal(calls[1].url, 'http://comfy.test:8188/object_info/LoraLoader');
  assert.equal(calls[1].init.credentials, 'omit'); assert.deepEqual(calls[1].init.headers, {Accept: 'application/json'});
  await assert.rejects(comfyLoras({url: 'http://x', fetch: async () => new Response('CORS proxy is disabled', {status: 404})}), /enableCorsProxy/);
  await assert.rejects(comfyLoras({url: 'http://x', fetch: async () => Response.json({})}), /原生 LoraLoader/);
  await assert.rejects(comfyLoras({url: 'http://x', transport: 'direct', fetch: async () => { throw Error('network'); }}), /跨域/);
  assert.deepEqual(await comfyLoras({url: 'http://x', fetch: async () => Response.json({LoraLoader: {input: {required: {lora_name: ['COMBO', {options: []}]}}}})}), []);
});

test('edited scheme and original template survive reopening and backup; disabled LoRAs are absent from submitted graph', async () => {
  let saved; const f = await fixture({persist: s => { saved = s; }}), restored = await fixture();
  try {
    f.api.saveDraw({engine: 'comfy', comfy: {model: 'base'}});
    const workflow = add(BASE, 'a.safetensors'), id = inspectLoras(workflow).nodes[0].id;
    const p = f.api.saveComfyWorkflow({name: 'A', workflow, sourceWorkflow: BASE, disabledLoras: [id]});
    await f.api.generateImage({prompt: 'cat'});
    const sent = JSON.parse(f.calls[0].body.prompt).prompt;
    assert.equal(sent[id], undefined); assert.deepEqual(sent['3'].inputs.model, ['4', 0]);
    assert.equal(f.api.getState().draw.comfy.workflows.find(row => row.id === p.id).workflow, workflow);
    const reopened = await fixture({state: saved});
    try { assert.deepEqual(reopened.api.getState().draw.comfy, f.api.getState().draw.comfy); } finally { await reopened.backend.close(); }
    const backup = await f.api.exportBackup(['settings']); await restored.api.importBackup(backup.blob, {parts: ['settings']});
    assert.deepEqual(restored.api.getState().draw.comfy, f.api.getState().draw.comfy);
    assert.equal(restored.api.getState().draw.comfy.workflows.find(row => row.id === p.id).sourceWorkflow, BASE);
    const stale = {workflow: p.workflow, disabledLoras: p.disabledLoras};
    f.api.saveComfyWorkflow({id: p.id, disabledLoras: []});
    assert.throws(() => f.api.saveComfyWorkflow({id: p.id, expected: stale, workflow}), /其他地方/);
  } finally { await f.backend.close(); await restored.backend.close(); }
});

test('card editor applies changes to the draft; plan saving and gallery restore keep the original graph', async () => {
  const f = await fixture(); let e;
  try {
    e = editor(f); e.set('lora-new-file', 'alice.safetensors'); e.set('lora-new-model', '.7'); await e.click('lora-add');
    assert.equal(f.api.getState().draw.comfy.workflows.length, 1, 'draft does not save automatically');
    assert.equal(e.d.live, false); const p = f.api.saveComfyDraft({name: '水彩', copy: true});
    assert.ok(p); assert.equal(inspectLoras(p.workflow).nodes[0].strength_model, .7); e.close();
    e = editor(f, {}, {nodeId: inspectLoras(p.workflow).nodes[0].id});
    e.set('lora-file', 'bob.safetensors'); e.set('lora-clip-strength', '.3'); e.q('[data-lora-enabled]').checked = false; await e.click('lora-apply'); e.close();
    assert.equal(f.api.getState().draw.comfy.workflow, p.workflow, 'card apply does not save the scheme');
    f.api.saveComfyDraft();
    const updated = f.api.getState().draw.comfy;
    assert.equal(inspectLoras(updated.workflow).nodes[0].name, 'bob.safetensors'); assert.equal(updated.disabledLoras.length, 1);
    const gallery = comfyLoraPanel({ctx: {confirm: async () => true}, api: f.api, root: () => null, rerender() {}});
    try { await gallery.click({dataset: {action: 'lora-restore'}}); } finally { gallery.dispose(); }
    assert.equal(f.api.getState().draw.comfy.workflow, updated.workflow, 'restore remains a draft until saved');
    f.api.saveComfyDraft();
    assert.deepEqual(JSON.parse(f.api.getState().draw.comfy.workflow), JSON.parse(BASE)); assert.deepEqual(f.api.getState().draw.comfy.disabledLoras, []);
  } finally { e?.close(); await f.backend.close(); }
});

test('catalogue replies preserve unsaved form input, old transport replies are ignored and close aborts loading', async () => {
  const f = await fixture(); let e, reply, signal;
  try {
    const workflow = add(BASE, 'old.safetensors'); f.api.saveComfyWorkflow({name: 'A', workflow});
    e = editor(f, {comfyLoras: options => { signal = options.signal; return new Promise(resolve => { reply = resolve; }); }}, {nodeId: inspectLoras(workflow).nodes[0].id});
    await e.click('lora-read'); e.set('lora-file', 'typed.safetensors'); e.set('lora-model-strength', '.35');
    reply(['<script>.safetensors']); await tick();
    assert.equal(e.q('[data-field=lora-file]').value, 'typed.safetensors'); assert.equal(e.q('[data-field=lora-model-strength]').value, '.35');
    assert.equal(e.q('datalist option').value, '<script>.safetensors'); assert.equal(e.d.body.querySelector('script'), null);
    await e.click('lora-read'); e.set('lora-transport', 'direct'); e.q('[data-field=lora-transport]').dispatchEvent(new e.dom.window.Event('change', {bubbles: true}));
    reply(['old-result']); await tick(); assert.equal(e.d.body.querySelector('datalist option'), null);
    await e.click('lora-read'); e.close(); assert.equal(signal.aborted, true); reply(['late']); await tick();
    assert.equal(f.api.getState().draw.comfy.workflow, workflow, 'closing discards edits');
  } finally { e?.close(); await f.backend.close(); }
});

test('focused sliders preserve exact imported strengths until moved and hide inapplicable CLIP controls', async () => {
  const f = await fixture(); let e;
  try {
    let workflow = add(BASE, 'precise.safetensors');
    const id = inspectLoras(workflow).nodes[0].id;
    workflow = editLoras(workflow, {updates: [{id, strength_model: 7.123, strength_clip: -.333}]});
    f.api.saveComfyWorkflow({name: 'precise', workflow});
    e = editor(f, {}, {nodeId: id});
    const slider = e.q('[data-field=lora-model-strength]');
    assert.equal(slider.type, 'range'); assert.ok(Number(slider.max) >= 7.123);
    // Browsers round a range thumb to its step before any input event.
    slider.value = '7.1'; await e.click('lora-apply'); e.close();
    assert.equal(f.api.getComfyDraft().loras.nodes[0].strength_model, 7.123);
    assert.equal(f.api.getComfyDraft().loras.nodes[0].strength_clip, -.333);
    e = editor(f, {}, {nodeId: id}); e.set('lora-clip-strength', '-.5');
    assert.equal(e.q('[data-field=lora-clip-strength]').closest('.field').querySelector('output').textContent, '-.5');
    await e.click('lora-apply'); e.close();
    assert.equal(f.api.getComfyDraft().loras.nodes[0].strength_clip, -.5);
    assert.equal(inspectLoras(f.api.getState().draw.comfy.workflow).nodes[0].strength_clip, -.333);
    const graph = JSON.parse(BASE);
    graph['4'] = {class_type: 'UNETLoader', inputs: {unet_name: 'flux.safetensors'}};
    graph['10'] = {class_type: 'CLIPLoader', inputs: {clip_name: 'clip.safetensors'}};
    graph['6'].inputs.clip = graph['7'].inputs.clip = ['10', 0];
    graph['20'] = {class_type: 'CheckpointLoaderSimple', inputs: {ckpt_name: 'other.safetensors'}};
    graph['21'] = {class_type: 'OtherModelConsumer', inputs: {model: ['20', 0]}};
    f.api.saveComfyWorkflow({name: 'mixed', workflow: JSON.stringify(graph)}); f.api.resetComfyDraft();
    e = editor(f, {}, {addFile: 'flux-lora.safetensors'});
    assert.equal(e.q('[data-action=lora-add]').disabled, true);
    e.set('lora-source', '20'); assert.equal(e.q('[data-field=lora-new-clip]').closest('.field').hidden, false);
    e.set('lora-source', '4'); assert.equal(e.q('[data-field=lora-new-clip]').closest('.field').hidden, true);
    assert.equal(e.q('[data-action=lora-add]').disabled, false);
    await e.click('lora-add');
    const node = f.api.getComfyDraft().loras.nodes[0]; assert.equal(node.modelOnly, true); assert.equal(node.strength_clip, undefined);
  } finally { e?.close(); await f.backend.close(); }
});
