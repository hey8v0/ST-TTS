// Native ComfyUI LoRA editing. All operations copy the API graph; custom nodes stay untouched.
const TYPES = new Set(['LoraLoader', 'LoraLoaderModelOnly']);
const SOURCES = {CheckpointLoaderSimple: 2, CheckpointLoader: 2, LoraLoader: 2, LoraLoaderModelOnly: 1, UNETLoader: 1};
const portsFor = node => Object.hasOwn(SOURCES, node?.class_type) ? SOURCES[node.class_type] : 0;
const link = v => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && Number.isInteger(v[1]) && v[1] >= 0;
const same = (a, b) => link(a) && a[0] === b[0] && a[1] === b[1];
function graphOf(text) {
  const graph = JSON.parse(text);
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) throw Error('工作流格式不对');
  return graph;
}
function native(graph, id) {
  if (!Object.hasOwn(graph, id) || !TYPES.has(graph[id]?.class_type)) throw Error('只能编辑原生 LoraLoader / LoraLoaderModelOnly 节点');
  return graph[id];
}
function upstream(graph, id, key) {
  const v = graph[id]?.inputs?.[key];
  if (!link(v) || v[0] === id || !Object.hasOwn(graph, v[0])) throw Error(`节点 ${id} 的 ${key} 接线不完整，请先在 ComfyUI 修好`);
  return v;
}
function acyclic(graph) {
  const done = new Set(), visiting = new Set();
  // Iterative traversal also handles deeply nested imported graphs without overflowing the stack.
  for (const root of Object.keys(graph)) {
    const stack = [[root, false]];
    while (stack.length) {
      const [id, leaving] = stack.pop();
      if (leaving) { visiting.delete(id); done.add(id); continue; }
      if (done.has(id)) continue;
      if (visiting.has(id)) throw Error('工作流接线形成了循环，请先在 ComfyUI 修好');
      visiting.add(id); stack.push([id, true]);
      for (const value of Object.values(graph[id]?.inputs || {})) if (link(value) && Object.hasOwn(graph, value[0])) stack.push([value[0], false]);
    }
  }
}
function replaceLinks(graph, from, to, skip = '') {
  let count = 0;
  for (const [id, node] of Object.entries(graph)) {
    if (id === skip) continue;
    for (const [key, value] of Object.entries(node?.inputs || {})) if (same(value, from)) { node.inputs[key] = [...to]; count++; }
  }
  return count;
}
function removeNode(graph, id) {
  const node = native(graph, id), outputs = [upstream(graph, id, 'model')];
  if (node.class_type === 'LoraLoader') outputs.push(upstream(graph, id, 'clip'));
  for (const other of Object.values(graph)) for (const value of Object.values(other?.inputs || {})) {
    if (link(value) && value[0] === id && value[1] >= outputs.length) throw Error(`节点 ${id} 存在无法识别的输出接线，未修改工作流`);
  }
  outputs.forEach((source, index) => replaceLinks(graph, [id, index], source, id));
  delete graph[id];
}
const strength = value => {
  if (value === '' || value == null || !Number.isFinite(Number(value)) || Number(value) < -100 || Number(value) > 100) throw Error('LoRA 强度需要填写 -100 到 100 之间的数字');
  return Number(value);
};
const filename = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000 || /[\x00-\x1f]/.test(value)) throw Error('请填写已安装的 LoRA 文件名（含后缀及子目录）');
  return value.trim();
};
function updateNode(graph, id, patch) {
  const node = native(graph, id);
  for (const key of ['lora_name', 'strength_model', ...(node.class_type === 'LoraLoader' ? ['strength_clip'] : [])]) {
    if (!Object.hasOwn(patch, key)) continue;
    if (link(node.inputs?.[key])) throw Error(`节点 ${id} 的参数由其他节点控制，请在 ComfyUI 修改`);
    node.inputs[key] = key === 'lora_name' ? filename(patch[key]) : strength(patch[key]);
  }
}
export function inspectLoras(text) {
  const graph = graphOf(text), nodes = [], sources = [];
  let error = '';
  try { acyclic(graph); } catch (e) { error = e.message; }
  for (const [id, node] of Object.entries(graph)) {
    if (TYPES.has(node?.class_type)) {
      const i = node.inputs || {}, modelOnly = node.class_type === 'LoraLoaderModelOnly';
      let reason = error;
      try { upstream(graph, id, 'model'); if (!modelOnly) upstream(graph, id, 'clip'); } catch (e) { reason ||= e.message; }
      if ([i.lora_name, i.strength_model, ...(!modelOnly ? [i.strength_clip] : [])].some(link)) reason ||= '参数由其他节点控制，请在 ComfyUI 修改';
      nodes.push({id, name: typeof i.lora_name === 'string' ? i.lora_name : '', strength_model: i.strength_model, strength_clip: i.strength_clip, modelOnly, reason});
    }
    const ports = portsFor(node);
    if (ports && !error) {
      const used = Object.values(graph).some(other => Object.values(other?.inputs || {}).some(v => same(v, [id, 0])));
      if (used) sources.push({id, modelOnly: ports === 1, name: `${node._meta?.title || node.inputs?.lora_name || node.class_type} · #${id}`});
    }
  }
  return {nodes, sources, error};
}
export function editLoras(text, {updates = [], remove, add} = {}) {
  const graph = graphOf(text); acyclic(graph);
  for (const patch of updates) updateNode(graph, String(patch.id), patch);
  if (remove !== undefined) removeNode(graph, String(remove));
  if (add) {
    const source = String(add.source), ports = Object.hasOwn(graph, source) && portsFor(graph[source]);
    if (!ports) throw Error('请选一个可识别的模型或 LoRA 节点作为接入位置');
    if (TYPES.has(graph[source].class_type)) { upstream(graph, source, 'model'); if (ports === 2) upstream(graph, source, 'clip'); }
    // Only known MODEL/CLIP ports are redirected. VAE and all unrelated branches remain intact.
    let id = 1; while (Object.hasOwn(graph, String(id))) id++;
    id = String(id);
    const inputs = {model: [source, 0], lora_name: filename(add.lora_name), strength_model: strength(add.strength_model ?? 1)};
    const used = replaceLinks(graph, [source, 0], [id, 0]);
    if (!used) throw Error('这个节点的模型输出没有接到后续流程，未添加 LoRA');
    if (ports === 2) { inputs.clip = [source, 1]; inputs.strength_clip = strength(add.strength_clip ?? 1); replaceLinks(graph, [source, 1], [id, 1]); }
    graph[id] = {class_type: ports === 2 ? 'LoraLoader' : 'LoraLoaderModelOnly', inputs};
  }
  return JSON.stringify(graph);
}
export function normalizeDisabledLoras(text, ids = []) {
  if (!Array.isArray(ids) || ids.length > 1000 || ids.some(id => typeof id !== 'string')) throw Error('LoRA 开关记录格式不对');
  if (!ids.length) return [];
  const graph = graphOf(text);
  for (const id of ids) native(graph, id);
  return [...new Set(ids)];
}
/** Disabled LoRAs are bypassed in a request copy; the saved graph retains their names and strengths. */
export function activeLoraWorkflow(text, disabled = []) {
  const ids = normalizeDisabledLoras(text, disabled);
  if (!ids.length) return text;
  const graph = graphOf(text); acyclic(graph);
  for (const id of ids) removeNode(graph, id);
  return JSON.stringify(graph);
}
