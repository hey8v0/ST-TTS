import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
const source = new URL(existsSync(new URL('../staging/extension/core/backend.js', import.meta.url)) ? '../staging/extension/' : '../', import.meta.url);
const require = createRequire(import.meta.url);
const {IDBFactory} = require(existsSync(new URL('./node-dom/node_modules/fake-indexeddb', import.meta.url)) ? './node-dom/node_modules/fake-indexeddb' : 'fake-indexeddb');
const {TTSBackend} = await import(new URL('core/backend.js', source));
const {freshState} = await import(new URL('core/state.js', source));
const {DEFAULT_COMFY_WORKFLOW: BASE} = await import(new URL('core/image-engines.js', source));
const {editLoras, inspectLoras} = await import(new URL('core/comfy-loras.js', source));
async function fixture(persist = () => {}) {
  const state = freshState(); state.draw.engine = 'comfy'; state.draw.queue.gap = 0;
  const calls = [], backend = new TTSBackend({settings: state, persist, indexedDB: new IDBFactory(), keyStore: {load: () => new Map()},
    sink: {stop() {}, close() {}, setVolume() {}, getVolume: () => 1}, imageFetch: async (url, init) => {
      calls.push(JSON.parse(JSON.parse(init.body).prompt).prompt);
      return Response.json({format: 'png', data: Buffer.from([137,80,78,71,13,10,26,10,1]).toString('base64')});
    }});
  await backend.initialize(); return {backend, api: backend.api(), calls};
}

test('draft parameters and LoRAs affect only explicit manual draws, survive facade recreation, and save together', async () => {
  const f = await fixture();
  try {
    f.api.saveDraw({comfy: {model: 'saved-model'}});
    const original = f.api.getState().draw.comfy;
    const workflow = editLoras(BASE, {add: {source: '4', lora_name: 'watercolor.safetensors', strength_model: .65, strength_clip: .8}});
    f.api.updateComfyDraft({workflow, params: {model: 'draft-model', width: 1024, height: 1024, steps: 36}});
    assert.equal(f.backend.api().getComfyDraft().dirty, true);
    assert.equal(f.api.drawQuote({}, true).params.steps, 36);
    assert.equal(f.api.drawQuote({}).params.steps, 28);
    await f.api.generateImage({prompt: 'manual', useComfyDraft: true});
    await f.api.generateImage({prompt: 'automatic'});
    assert.equal(f.calls[0]['3'].inputs.steps, 36); assert.equal(f.calls[0]['4'].inputs.ckpt_name, 'draft-model');
    assert.equal(inspectLoras(JSON.stringify(f.calls[0])).nodes[0].name, 'watercolor.safetensors');
    assert.equal(f.calls[1]['3'].inputs.steps, 28); assert.equal(inspectLoras(JSON.stringify(f.calls[1])).nodes.length, 0);
    assert.deepEqual(f.api.getState().draw.comfy, original);
    const saved = f.api.saveComfyDraft({name: '水彩角色'});
    assert.notEqual(saved.id, 'default'); assert.equal(saved.steps, 36); assert.equal(saved.sourceWorkflow, BASE);
    assert.equal(f.api.getComfyDraft().dirty, false);
  } finally { await f.backend.close(); }
});

test('invalid edits, stale saves and persistence failures retain the working copy and saved plans', async () => {
  let fail = false; const f = await fixture(() => { if (fail) throw Error('storage unavailable'); });
  try {
    const row = f.api.saveComfyWorkflow({name: 'A', workflow: BASE, params: {model: 'a'}});
    f.api.updateComfyDraft({params: {steps: 42}});
    const d = f.api.getComfyDraft();
    assert.throws(() => f.api.updateComfyDraft({workflow: '{bad'})); assert.deepEqual(f.api.getComfyDraft(), d);
    assert.throws(() => f.api.updateComfyDraft({params: {scale: 9}}, d.base), /草稿已经改变/);
    fail = true; assert.throws(() => f.api.saveComfyDraft(), /storage/); fail = false;
    assert.equal(f.api.getState().draw.comfy.steps, row.steps); assert.equal(f.api.getComfyDraft().value.steps, 42);
    f.api.saveComfyWorkflow({id: row.id, params: {steps: 35}});
    assert.equal(f.api.getComfyDraft().conflict, true); assert.throws(() => f.api.saveComfyDraft(), /其他地方/);
    const copy = f.api.saveComfyDraft({name: 'my copy', copy: true});
    assert.equal(copy.steps, 42); assert.equal(f.api.getState().draw.comfy.workflows.find(p => p.id === row.id).steps, 35);
  } finally { await f.backend.close(); }
});

test('draft reset follows saved selection, removed schemes remain copyable, and capabilities reflect actual placeholders', async () => {
  const f = await fixture();
  try {
    const graph = JSON.parse(BASE); graph['3'].inputs.steps = 24; graph['4'].inputs.ckpt_name = 'fixed-model';
    const a = f.api.saveComfyWorkflow({name: 'fixed', workflow: JSON.stringify(graph)});
    const d = f.api.getComfyDraft();
    assert.equal(d.controls.includes('steps'), false); assert.equal(d.controls.includes('model'), false); assert.equal(d.missing, '');
    f.api.updateComfyDraft({params: {scale: 8}}); f.api.deleteComfyWorkflow(a.id);
    assert.equal(f.api.getComfyDraft().conflict, true); assert.equal(f.api.getComfyDraft().value.id, a.id);
    assert.throws(() => f.api.saveComfyDraft(), /不在了/);
    assert.equal(f.api.saveComfyDraft({copy: true, name: 'recovered'}).scale, 8);
    f.api.updateComfyDraft({params: {steps: 50}}); f.api.selectComfyWorkflow('default');
    assert.equal(f.api.resetComfyDraft().value.id, 'default'); assert.equal(f.api.getComfyDraft().dirty, false);
  } finally { await f.backend.close(); }
});

test('queued draft generation keeps the snapshot even when the working copy is changed and reset', async () => {
  const f = await fixture(); let release;
  try {
    const fetch = f.backend.imageFetch;
    let count = 0; f.backend.imageFetch = async (...args) => { if (++count === 1) await new Promise(r => release = r); return fetch(...args); };
    f.api.updateComfyDraft({params: {model: 'first', steps: 31}});
    const first = f.api.generateImage({prompt: 'one', useComfyDraft: true});
    const second = f.api.generateImage({prompt: 'two', useComfyDraft: true});
    while (!release) await new Promise(r => setTimeout(r, 1));
    f.api.updateComfyDraft({params: {model: 'second', steps: 48}}); f.api.resetComfyDraft(); release();
    await Promise.all([first, second]);
    assert.deepEqual(f.calls.map(w => [w['4'].inputs.ckpt_name, w['3'].inputs.steps]), [['first', 31], ['first', 31]]);
  } finally { release?.(); await f.backend.close(); }
});

test('real phone sheets apply LoRAs to a draft, preserve unsaved work on failed import, and save a copy', async () => {
  const {JSDOM} = require(existsSync(new URL('./node-dom/node_modules/jsdom', import.meta.url)) ? './node-dom/node_modules/jsdom' : 'jsdom');
  const {createPhoneApp} = await import(new URL('ui/phone.js', source));
  const f = await fixture(), dom = new JSDOM('<div id="root"></div>', {url: 'https://test.invalid', pretendToBeVisual: true});
  const w = dom.window, doc = w.document, tick = () => new Promise(r => setTimeout(r, 10));
  w.matchMedia = () => ({matches: false, addEventListener() {}, removeEventListener() {}});
  w.requestAnimationFrame = () => 0; w.cancelAnimationFrame = () => {};
  const app = createPhoneApp({window: w, api: {...f.api, latest: () => null, takeDraw: () => null, close() {}}});
  const q = s => { const el = doc.querySelector(s); assert.ok(el, s); return el; };
  const click = async s => { q(s).click(); await tick(); };
  const set = (s, value, type = 'input') => { const el = q(s); el.value = value; el.dispatchEvent(new w.Event(type, {bubbles: true})); };
  try {
    await app.ready; app.open('draw'); await tick();
    await click('[data-tab=lora]'); await click('[data-action=lora-manual]');
    await click('.sheet [data-help]'); assert.ok(q('.sheet-help')); assert.ok(q('[data-action=lora-add]'), 'help keeps editor open');
    set('[data-field=lora-new-file]', 'test.safetensors'); await click('[data-action=lora-add]');
    assert.equal(f.api.getComfyDraft().dirty, true); assert.equal(f.api.getState().draw.comfy.workflow, '');
    await click('[data-tab=params]'); set('[data-field=comfy-model]', 'model.safetensors', 'change'); await tick();
    app.open('engines'); app.open('draw'); await tick(); assert.equal(f.api.getComfyDraft().value.model, 'model.safetensors');
    await click('[data-tab=lora]');
    await click('[data-action=comfy-manage]');
    const bad = new Blob(['bad JSON']); Object.defineProperty(bad, 'name', {value:'bad.json'});
    Object.defineProperty(q('[data-comfy-file]'), 'files', {value:[bad], configurable:true}); q('[data-comfy-file]').dispatchEvent(new w.Event('change', {bubbles:true})); await tick();
    await click('[data-decision=yes]');
    assert.equal(f.api.getComfyDraft().dirty, true); assert.ok(q('.sheet [data-comfy-file]'), 'failure keeps original sheet and draft');
    set('[data-field=comfy-name]', '角色方案'); await click('[data-action=comfy-save-as]');
    assert.equal(f.api.getComfyDraft().value.name, '角色方案'); assert.equal(f.api.getComfyDraft().dirty, false);
    assert.equal(inspectLoras(f.api.getState().draw.comfy.workflow).nodes[0].name, 'test.safetensors');
    await click('[data-action=comfy-manage]'); await click('[data-action=comfy-delete-wf]');
    await click('[data-decision=cancel]'); assert.ok(q('.sheet [data-field=comfy-name]'));
    await click('[data-action=comfy-delete-wf]'); await click('[data-decision=yes]');
    assert.equal(f.api.getState().draw.comfy.activeWorkflow, 'default');
  } finally { app.dispose(); dom.window.close(); await f.backend.close(); }
});

test('LoRA gallery shares the Vibe tab position and edits one card without changing its neighbours or saved plan', async () => {
  const {JSDOM} = require(existsSync(new URL('./node-dom/node_modules/jsdom', import.meta.url)) ? './node-dom/node_modules/jsdom' : 'jsdom');
  const {createPhoneApp} = await import(new URL('ui/phone.js', source));
  const f = await fixture(), dom = new JSDOM('<div id="root"></div>', {url: 'https://test.invalid', pretendToBeVisual: true});
  const w = dom.window, doc = w.document, tick = () => new Promise(r => setTimeout(r, 10));
  w.matchMedia = () => ({matches: false, addEventListener() {}, removeEventListener() {}});
  w.requestAnimationFrame = () => 0; w.cancelAnimationFrame = () => {};
  let workflow = editLoras(BASE, {add: {source: '4', lora_name: 'folder/watercolor.safetensors', strength_model: .7, strength_clip: .8}});
  const firstId = inspectLoras(workflow).nodes[0].id;
  workflow = editLoras(workflow, {add: {source: firstId, lora_name: 'soft-light.safetensors', strength_model: .4, strength_clip: .5}});
  const plan = f.api.saveComfyWorkflow({name: 'gallery', workflow});
  const catalogue = ['folder/watercolor.safetensors', 'soft-light.safetensors', 'character-alice.safetensors', ...Array.from({length: 8}, (_, i) => `other-${i}.safetensors`)];
  const app = createPhoneApp({window: w, api: {...f.api, comfyLoras: async () => catalogue, latest: () => null, takeDraw: () => null, close() {}}});
  const q = s => { const el = doc.querySelector(s); assert.ok(el, s); return el; };
  const click = async s => { q(s).click(); await tick(); };
  const set = (s, value) => { const el = q(s); el.value = value; el.dispatchEvent(new w.Event('input', {bubbles: true})); };
  const cards = () => [...doc.querySelectorAll('[data-action=lora-open]')];
  try {
    await app.ready; app.open('draw'); await tick();
    assert.deepEqual([...doc.querySelectorAll('.draw-tabs [data-tab]')].map(b => b.dataset.tab), ['prompt', 'chars', 'params', 'lora', 'chat']);
    assert.equal(doc.querySelector('[data-action=comfy-loras]'), null);
    assert.equal(doc.querySelector('.comfy-plan'), null, 'prompt tab keeps the shared drawing layout');
    await click('[data-tab=lora]'); assert.equal(cards().length, 2);
    assert.ok(q('.draw-tabs').compareDocumentPosition(q('.comfy-plan')) & w.Node.DOCUMENT_POSITION_FOLLOWING, 'scheme controls belong below the tabs');
    assert.equal(q('.comfy-plan').querySelector('[data-tab=params]'), null, 'no duplicate parameter shortcut');
    await click('[data-tab=params]'); assert.equal(doc.querySelector('.comfy-plan'), null, 'parameters do not repeat scheme controls');
    await click('[data-tab=lora]');
    await click(`[data-action=lora-open][data-id="${firstId}"]`);
    assert.equal(doc.querySelectorAll('.sheet [data-lora-id]').length, 1);
    set('[data-field=lora-model-strength]', '.25'); await click('[data-action=lora-cancel]');
    assert.equal(f.api.getComfyDraft().dirty, false);
    await click(`[data-action=lora-open][data-id="${firstId}"]`);
    set('[data-field=lora-model-strength]', '.55'); q('[data-lora-enabled]').checked = false;
    assert.equal(q('[data-field=lora-model-strength]').type, 'range');
    assert.equal(q('[data-field=lora-model-strength]').closest('.field').querySelector('output').textContent, '.55');
    await click('.sheet [data-help]'); assert.ok(q('.sheet-help'));
    await click('[data-action=lora-apply]');
    const d = f.api.getComfyDraft(); assert.equal(d.loras.nodes[0].strength_model, .55);
    assert.deepEqual(d.loras.nodes[1], inspectLoras(workflow).nodes[1]);
    assert.deepEqual(d.value.disabledLoras, [firstId]); assert.equal(cards()[0].classList.contains('using'), false);
    assert.equal(f.api.getState().draw.comfy.workflow, plan.workflow);
    await click('[data-action=lora-refresh]');
    assert.equal(doc.querySelectorAll('[data-action=lora-catalog-open]').length, catalogue.length);
    set('[data-lora-search]', 'alice'); assert.equal(cards().filter(c => !c.hidden).length, 0);
    assert.equal(doc.querySelectorAll('[data-action=lora-catalog-open]:not([hidden])').length, 1);
    await click('[data-action=lora-catalog-open]:not([hidden])');
    assert.equal(q('[data-field=lora-new-file]').value, 'character-alice.safetensors');
    assert.equal(q('[data-action=lora-add]').disabled, true, 'select a connection before adding');
    set('[data-field=lora-source]', d.loras.nodes[1].id); await click('[data-action=lora-add]');
    const added = f.api.getComfyDraft().loras.nodes.find(n => n.name === 'character-alice.safetensors'); assert.ok(added);
    await click(`[data-action=lora-open][data-id="${added.id}"]`); await click('[data-action=lora-remove]');
    assert.equal(f.api.getComfyDraft().loras.nodes.length, 3, 'first click only asks for confirmation');
    await click('[data-action=lora-remove]'); assert.equal(f.api.getComfyDraft().loras.nodes.length, 2);
    set('[data-lora-search]', '');
    await click(`[data-action=lora-open][data-id="${firstId}"]`); set('[data-field=lora-model-strength]', '.9');
    f.api.updateComfyDraft({params: {steps: 45}}); await click('[data-action=lora-apply]');
    assert.ok(q('.sheet [data-action=lora-apply]'), 'stale apply keeps editor open');
    assert.equal(f.api.getComfyDraft().loras.nodes[0].strength_model, .55); assert.equal(f.api.getComfyDraft().value.steps, 45);
    await click('[data-action=lora-cancel]');
    await click('[data-action=draw-engine][data-pick=nai]'); assert.ok(q('[data-tab=vibe][aria-pressed=true]'));
    await click('[data-action=draw-engine][data-pick=comfy]'); assert.ok(q('[data-tab=lora][aria-pressed=true]'));
    await click('[data-action=draw-engine][data-pick=gpt]'); assert.ok(q('[data-tab=prompt][aria-pressed=true]'));
  } finally { app.dispose(); dom.window.close(); await f.backend.close(); }
});

test('LoRA gallery discards old catalogues after connection changes and aborts requests on close', async () => {
  const {comfyLoraPanel} = await import(new URL('ui/comfy-lora-panel.js', source));
  const f = await fixture(), requests = []; let renders = 0;
  const panel = comfyLoraPanel({ctx: {}, api: {...f.api, comfyLoras: ({signal}) => new Promise(resolve => requests.push({resolve, signal}))}, root: () => null, rerender: () => { renders++; }});
  try {
    const first = panel.click({dataset: {action: 'lora-refresh'}});
    f.api.saveDraw({comfy: {url: 'http://new-comfy.invalid:8188'}}); panel.html();
    assert.equal(requests[0].signal.aborted, true);
    requests[0].resolve(['old-server.safetensors']); await first;
    assert.equal(panel.html().includes('old-server.safetensors'), false);
    const second = panel.click({dataset: {action: 'lora-refresh'}});
    requests[1].resolve(['new-server.safetensors']); await second;
    assert.ok(panel.html().includes('new-server.safetensors'));
    const third = panel.click({dataset: {action: 'lora-refresh'}}); panel.dispose(); const before = renders;
    assert.equal(requests[2].signal.aborted, true); requests[2].resolve(['late.safetensors']); await third;
    assert.equal(renders, before);
  } finally { panel.dispose(); await f.backend.close(); }
});
