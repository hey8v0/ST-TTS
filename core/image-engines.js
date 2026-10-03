// Drawing engines besides NovelAI: GPT image models (the OpenAI images API, or a relay that speaks it) and a ComfyUI
// the user runs. Everything that calls for a picture (正文出图, 朋友圈, 查手机, the 绘图 App) goes through
// backend.generateImage, which picks the engine set in 绘图 → 用哪个画; this file turns the same picture (scene tags,
// one caption per person, NovelAI-sized params) into each engine's request.
//   GPT: called from the browser with the user's key (api.openai.com allows cross-origin calls; so do most relays).
//   ComfyUI: through the tavern's own ComfyUI proxy (/api/sd/comfy/…), so neither CORS nor a phone that cannot reach
//   the computer's 127.0.0.1 gets in the way: the tavern server talks to ComfyUI. Workflows use the tavern's
//   placeholders ("%prompt%", "%width%" …), so a workflow made for the tavern's image generation works here too.

export const DRAW_ENGINES = ['nai', 'gpt', 'comfy'];
export const DRAW_ENGINE_NAMES = {nai: 'NovelAI', gpt: 'GPT 生图', comfy: 'ComfyUI'};

// ---------- GPT ----------
export const OPENAI_BASE = 'https://api.openai.com/v1';
export const GPT_IMAGE_MODELS = ['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini', 'dall-e-3'];
export const GPT_QUALITIES = ['auto', 'low', 'medium', 'high'];
export const GPT_ORIENTATIONS = ['portrait', 'landscape', 'square'];
export const defaultGpt = () => ({url: '', model: 'gpt-image-1', quality: 'auto', orientation: 'portrait', ask: true, style: ''});

/** A GPT address: '' for OpenAI itself; a relay's address ends at /v1 (a pasted …/images/generations is cut off). */
export function gptBase(value, pageProtocol = globalThis.location?.protocol) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  let url; try { url = new URL(raw); } catch { throw Error('接口地址格式不对，要以 https:// 开头'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('接口地址格式不对：以 https:// 开头，不带 ? 和 #');
  if (url.protocol === 'http:' && pageProtocol === 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('酒馆是用 HTTPS 打开的，浏览器不允许连 http:// 的接口，请换成 HTTPS 地址');
  let path = url.pathname.replace(/\/+$/, '').replace(/\/images\/(generations|edits)$/i, '');
  if (!/\/v\d+$/i.test(path)) path += '/v1';
  return url.origin + path;
}
export function normalizeGpt(value) {
  const base = defaultGpt(), g = value && typeof value === 'object' ? value : {};
  const model = String(g.model ?? base.model).trim().slice(0, 80);
  return {
    url: (() => { try { return gptBase(g.url, ''); } catch { return ''; } })(),
    model: /^[\w.:/-]{1,80}$/.test(model) ? model : base.model,
    quality: GPT_QUALITIES.includes(g.quality) ? g.quality : base.quality,
    orientation: GPT_ORIENTATIONS.includes(g.orientation) ? g.orientation : base.orientation,
    ask: g.ask !== false,
    style: typeof g.style === 'string' ? g.style.slice(0, 64) : ''
  };
}
const dalle = model => /^dall-e/i.test(model);
/** The size GPT is asked for: its models take only a few. */
export function gptSize(model, orientation) {
  if (dalle(model)) return {portrait: '1024x1792', landscape: '1792x1024', square: '1024x1024'}[orientation] || '1024x1024';
  return {portrait: '1024x1536', landscape: '1536x1024', square: '1024x1024'}[orientation] || '1024x1024';
}
/** portrait / landscape / square of a width and height. */
export const orientationOf = (width, height) => !(width > 0 && height > 0) ? '' : width === height ? 'square' : width < height ? 'portrait' : 'landscape';

/** NovelAI tag syntax ({strong}, [weak], 1.2::tag::, artist:name) taken out: GPT reads plain words. Artist tags are
 *  dropped; GPT does not know them by those names and may refuse a living artist's style. */
export function plainTags(text) {
  return String(text || '')
    .replace(/\b(?:source|target|mutual)#/gi, '')
    .replace(/-?\d+(?:\.\d+)?::/g, '').replace(/::/g, ',')
    .replace(/[{}[\]]/g, '')
    .split(',').map(t => t.trim()).filter(t => t && !/^artist\s*:/i.test(t)).join(', ');
}
function place(position) {
  if (!(position >= 0)) return '';
  const column = position % 5, row = Math.floor(position / 5);
  const x = ['far left', 'left', 'center', 'right', 'far right'][column], y = row < 2 ? 'upper part' : row > 2 ? 'lower part' : '';
  return y ? `${x}, ${y} of the picture` : `${x} of the picture`;
}
/** One English request for GPT from the picture: scene tags, then each person's tags and place in the frame. */
export function gptPrompt({prompt = '', characters = []} = {}) {
  const scene = plainTags(prompt), people = characters.map(c => ({tags: plainTags(c.prompt), where: place(c.position)})).filter(c => c.tags);
  const lines = ['Draw one illustration described by the Danbooru-style tags and short phrases below. Follow them closely; do not add text or captions to the picture.'];
  if (scene) lines.push('Scene and style: ' + scene + '.');
  people.forEach((c, i) => lines.push(`Character ${i + 1}${c.where ? ` (${c.where})` : ''}: ${c.tags}.`));
  if (people.length > 1) lines.push(`Exactly ${people.length} distinct characters; keep each one's features separate.`);
  return lines.join('\n');
}

/** Readable GPT error; status kept so the queue can retry a 429. */
export function gptFailure(status, text, relay = false) {
  let detail = '';
  try { const data = JSON.parse(text); detail = String(data?.error?.message || data?.message || data?.error || ''); } catch { detail = String(text || '').trim(); }
  detail = detail.replace(/\s+/g, ' ').slice(0, 240);
  const who = relay ? '中转' : 'OpenAI';
  const blocked = /moderation|safety|content policy|not allowed|rejected/i.test(detail);
  const message = status === 401 ? `${who}拒绝了密钥（401）：请检查 GPT 生图的密钥`
    : status === 403 ? `${who}不允许这次请求（403）${detail ? '：' + detail : ''}。新账号用 gpt-image 可能要先在 OpenAI 后台完成组织验证`
    : status === 404 ? `${who}返回 404：地址不对，或者没有这个模型（${detail || '没有说明'}）`
    : status === 429 ? `${who}说请求太多或额度用完了（429）${detail ? '：' + detail : ''}`
    : status === 400 && blocked ? 'GPT 拒绝画这张（内容审核）：' + detail
    : status === 400 ? 'GPT 拒绝了这次请求：' + (detail || '参数无效')
    : `${who}暂时不可用（${status}）${detail ? '：' + detail : ''}`;
  return Object.assign(Error(message), {status});
}

const base64Blob = (data, type = 'image/png') => {
  const bin = atob(data), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], {type});
};
const imageType = format => ({jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', png: 'image/png'})[String(format || 'png').toLowerCase()] || 'image/png';

/** Draws one picture with a GPT image model. Returns a Blob. */
export async function gptGenerate({fetch = globalThis.fetch, settings, key, prompt, size, signal}) {
  if (!key) throw Error('还没有填写 GPT 生图的密钥');
  const base = settings.url || OPENAI_BASE, relay = !!settings.url;
  const body = {model: settings.model, prompt, n: 1, size};
  if (dalle(settings.model)) { body.response_format = 'b64_json'; if (/dall-e-3/i.test(settings.model)) body.quality = settings.quality === 'high' ? 'hd' : 'standard'; }
  else if (settings.quality !== 'auto') body.quality = settings.quality;
  let response;
  try { response = await fetch(base + '/images/generations', {method: 'POST', headers: {Authorization: 'Bearer ' + key, 'Content-Type': 'application/json'}, body: JSON.stringify(body), signal}); }
  catch (error) { if (error?.name === 'AbortError') throw error; throw Error(relay ? '连不上中转：请确认地址正确、中转允许跨域（CORS）' : '连不上 OpenAI，请检查网络'); }
  const text = await response.text().catch(() => '');
  if (!response.ok) throw gptFailure(response.status, text, relay);
  let data; try { data = JSON.parse(text); } catch { throw Error((relay ? '中转' : 'OpenAI') + '返回的内容不是图片数据'); }
  const item = data?.data?.[0];
  if (item?.b64_json) return base64Blob(item.b64_json, imageType(data.output_format));
  if (item?.url) {
    // Some relays answer with a link: fetched here (a link the browser may not open says so).
    if (/^data:image\//.test(item.url)) return base64Blob(item.url.split(',')[1] || '', item.url.slice(5, item.url.indexOf(';')));
    let picture;
    try { picture = await fetch(item.url, {signal}); } catch (error) { if (error?.name === 'AbortError') throw error; throw Error('中转给的是图片链接，但浏览器打不开它（链接不允许跨域）'); }
    if (!picture.ok) throw Error(`中转给的图片链接打不开（${picture.status}）`);
    return await picture.blob();
  }
  throw Error((relay ? '中转' : 'OpenAI') + '没有返回图片' + (data?.error?.message ? '：' + data.error.message : ''));
}

// ---------- ComfyUI ----------
import {normalizeDisabledLoras} from './comfy-loras.js';
/** The tavern's default workflow (SD 1.5 / SDXL checkpoint, one KSampler). */
export const DEFAULT_COMFY_WORKFLOW = JSON.stringify({
  3: {class_type: 'KSampler', inputs: {cfg: '%scale%', denoise: 1, latent_image: ['5', 0], model: ['4', 0], negative: ['7', 0], positive: ['6', 0], sampler_name: '%sampler%', scheduler: '%scheduler%', seed: '%seed%', steps: '%steps%'}},
  4: {class_type: 'CheckpointLoaderSimple', inputs: {ckpt_name: '%model%'}},
  5: {class_type: 'EmptyLatentImage', inputs: {batch_size: 1, height: '%height%', width: '%width%'}},
  6: {class_type: 'CLIPTextEncode', inputs: {clip: ['4', 1], text: '%prompt%'}},
  7: {class_type: 'CLIPTextEncode', inputs: {clip: ['4', 1], text: '%negative_prompt%'}},
  8: {class_type: 'VAEDecode', inputs: {samples: ['3', 0], vae: ['4', 2]}},
  9: {class_type: 'SaveImage', inputs: {filename_prefix: 'ST-iPhonie', images: ['8', 0]}}
}, null, 2);
export const COMFY_LIMITS = {workflow: 300000, presets: 20};
const COMFY_DEFAULT_PARAMS = {model: '', vae: '', sampler: 'euler_ancestral', scheduler: 'normal', steps: 28, scale: 6, width: 832, height: 1216, clipSkip: 2};
export const COMFY_PARAM_KEYS = Object.keys(COMFY_DEFAULT_PARAMS);
export const defaultComfy = () => ({url: 'http://127.0.0.1:8188', loraTransport: 'tavern', workflow: '', disabledLoras: [], ...COMFY_DEFAULT_PARAMS, style: '', activeWorkflow: 'default', workflows: [{id: 'default', name: '默认工作流', workflow: '', disabledLoras: [], ...COMFY_DEFAULT_PARAMS}]});

export function comfyUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) throw Error('请填写 ComfyUI 地址，例如 http://127.0.0.1:8188');
  let url; try { url = new URL(/^https?:\/\//i.test(raw) ? raw : 'http://' + raw); } catch { throw Error('ComfyUI 地址格式不对，例如 http://127.0.0.1:8188'); }
  if (url.search || url.hash) throw Error('ComfyUI 地址不要带 ? 和 #');
  return (url.origin + url.pathname).replace(/\/+$/, '');
}
/** The placeholders a workflow uses ("%prompt%" → prompt). */
export const workflowPlaceholders = text => [...new Set([...String(text).matchAll(/"%([a-z_]+)%"/g)].map(m => m[1]))];
/** Checks an imported workflow: API format (File → Export (API)), with "%prompt%" somewhere. */
export function checkWorkflow(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  if (raw.length > COMFY_LIMITS.workflow) throw Error('工作流太大了（超过 300 KB）');
  let data; try { data = JSON.parse(raw); } catch { throw Error('工作流不是有效的 JSON'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('工作流格式不对');
  if (Array.isArray(data.nodes) && data.links) throw Error('这是界面格式的工作流：请在 ComfyUI 里用「导出 (API)」（Export (API)）重新导出');
  if (!Object.values(data).some(n => n && typeof n === 'object' && typeof n.class_type === 'string')) throw Error('工作流里没有节点（需要 API 格式）');
  if (!workflowPlaceholders(raw).includes('prompt')) throw Error('工作流里没有 "%prompt%"：把正面提示词那一栏的文字换成 "%prompt%"（带引号），插件才知道往哪里填');
  return raw;
}
export function comfyParams(c) {
  const base = COMFY_DEFAULT_PARAMS;
  const n = (v, min, max, fallback, step = 1) => { const x = Number(v); return Number.isFinite(x) ? Math.min(max, Math.max(min, Math.round(x / step) * step)) : fallback; };
  const word = (v, fallback) => { const s = String(v ?? '').trim(); return s.length <= 300 ? s : fallback; };
  return {
    model: word(c.model, ''), vae: word(c.vae, ''), sampler: word(c.sampler, base.sampler) || base.sampler, scheduler: word(c.scheduler, base.scheduler) || base.scheduler,
    steps: n(c.steps, 1, 150, base.steps), scale: n(c.scale, 0, 30, base.scale, .1),
    width: n(c.width, 64, 4096, base.width, 8), height: n(c.height, 64, 4096, base.height, 8), clipSkip: n(c.clipSkip, 1, 12, base.clipSkip)
  };
}
/** Copy a selected preset into the existing fields used by the drawing pipeline. */
export function applyComfyWorkflow(c, id = c.activeWorkflow) {
  const p = c.workflows.find(p => p.id === id);
  if (!p) throw Error('这套工作流已经不在了');
  c.activeWorkflow = id; c.workflow = p.workflow;
  c.disabledLoras = [...(p.disabledLoras || [])];
  for (const key of COMFY_PARAM_KEYS) c[key] = p[key];
  return c;
}
export function normalizeComfy(value) {
  const base = defaultComfy(), c = value && typeof value === 'object' ? value : {}, params = comfyParams(c);
  const legacy = (() => { try { return checkWorkflow(c.workflow); } catch { return ''; } })();
  let rows = Array.isArray(c.workflows) && c.workflows.length ? c.workflows : null;
  let active = c.activeWorkflow;
  if (!rows) {
    rows = [{...base.workflows[0], ...params}];
    if (legacy) { rows.push({id: 'legacy', name: '原有工作流', workflow: legacy, ...params}); active = 'legacy'; }
  }
  if (rows.length > COMFY_LIMITS.presets) throw Error(`最多保存 ${COMFY_LIMITS.presets} 套 ComfyUI 工作流（含默认）`);
  const ids = new Set(), workflows = rows.map(row => {
    const id = String(row?.id || '');
    if (!/^[\w-]{1,64}$/.test(id) || ids.has(id)) throw Error('ComfyUI 工作流编号无效或重复');
    ids.add(id);
    const workflow = checkWorkflow(row.workflow);
    if (id === 'default' && workflow) throw Error('默认工作流不能被覆盖，请另存为一套');
    if (id !== 'default' && !workflow) throw Error('导入的工作流不能为空');
    const disabledLoras = normalizeDisabledLoras(workflow, row.disabledLoras);
    const sourceWorkflow = row.sourceWorkflow ? checkWorkflow(row.sourceWorkflow) : '';
    return {id, name: id === 'default' ? '默认工作流' : String(row.name || '未命名工作流').trim().slice(0, 60) || '未命名工作流', workflow, disabledLoras, ...(sourceWorkflow ? {sourceWorkflow} : {}), ...comfyParams(row)};
  });
  if (!ids.has('default')) {
    if (workflows.length >= COMFY_LIMITS.presets) throw Error('请给默认工作流留出一个位置');
    workflows.unshift(base.workflows[0]);
  }
  active = workflows.some(p => p.id === active) ? active : 'default';
  const selected = workflows.find(p => p.id === active);
  // Existing parameter controls and older callers edit the selected preset through the flat fields.
  for (const key of COMFY_PARAM_KEYS) if (Object.hasOwn(c, key)) selected[key] = params[key];
  const out = {url: (() => { try { return comfyUrl(c.url ?? base.url); } catch { return base.url; } })(),
    loraTransport: c.loraTransport === 'direct' ? 'direct' : 'tavern', style: typeof c.style === 'string' ? c.style.slice(0, 64) : '', workflows, activeWorkflow: active};
  return applyComfyWorkflow(out);
}
/** ComfyUI size for a picture's orientation: the configured size, turned or squared to match. */
export function comfySize(c, orientation) {
  const long = Math.max(c.width, c.height), short = Math.min(c.width, c.height);
  if (orientation === 'portrait') return {width: short, height: long};
  if (orientation === 'landscape') return {width: long, height: short};
  if (orientation === 'square') { const side = Math.max(64, Math.round(Math.sqrt(c.width * c.height) / 8) * 8); return {width: side, height: side}; }
  return {width: c.width, height: c.height};
}

/** NovelAI weights to the ComfyUI / A1111 form: {tag} → (tag:1.05), [tag] → (tag:0.95), 1.3::tag:: → (tag:1.3);
 *  brackets that are part of a tag (character (series)) are escaped so they are not read as weights. */
export function comfyTags(text) {
  // source#/target#/mutual# are NovelAI's own: the action stays, the mark goes.
  let s = String(text || '').replace(/\b(?:source|target|mutual)#/gi, '').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  s = s.replace(/(-?\d+(?:\.\d+)?)::([^:]+?)::/g, (m, w, t) => `(${t.trim()}:${+Number(w).toFixed(2)})`);
  s = s.replace(/(-?\d+(?:\.\d+)?)::([^,]+)/g, (m, w, t) => `(${t.trim()}:${+Number(w).toFixed(2)})`);
  for (let guard = 0; guard < 20 && /\{[^{}]*\}|\[[^[\]]*\]/.test(s); guard++) {
    s = s.replace(/(\{+)([^{}]*)(\}+)/g, (m, open, t, close) => { const depth = Math.min(open.length, close.length); return '{'.repeat(open.length - depth) + `(${t.trim()}:${+(1.05 ** depth).toFixed(2)})` + '}'.repeat(close.length - depth); });
    s = s.replace(/(\[+)([^[\]]*)(\]+)/g, (m, open, t, close) => { const depth = Math.min(open.length, close.length); return '['.repeat(open.length - depth) + `(${t.trim()}:${+(1 / 1.05 ** depth).toFixed(2)})` + ']'.repeat(close.length - depth); });
  }
  return s.replace(/::/g, ',').split(',').map(t => t.trim()).filter(Boolean).join(', ');
}
/** One prompt for ComfyUI: the scene, then every person's caption (ComfyUI has no per-character captions). */
export function comfyPrompt({prompt = '', negative = '', characters = []} = {}) {
  const people = characters.map(c => comfyTags(c.prompt)).filter(Boolean);
  const negatives = [negative, ...characters.map(c => c.negative)].map(comfyTags).filter(Boolean);
  return {prompt: [comfyTags(prompt), ...people].filter(Boolean).join(', '), negative: [...new Set(negatives.join(', ').split(', ').filter(Boolean))].join(', ')};
}

/** The workflow with every placeholder filled; a placeholder left over is named so the user can fix the workflow. */
export function fillWorkflow(text, values) {
  let out = String(text || DEFAULT_COMFY_WORKFLOW);
  for (const [name, value] of Object.entries(values)) out = out.replaceAll(`"%${name}%"`, JSON.stringify(value));
  const left = workflowPlaceholders(out);
  if (left.length) throw Error('工作流里有插件不认识的占位符：' + left.map(x => `%${x}%`).join('、') + '。请在 ComfyUI 里把它们换成具体的值');
  return out;
}
export function comfyValues(c, {prompt, negative, width, height, seed}) {
  if (!c.model && (!c.workflow || workflowPlaceholders(c.workflow).includes('model'))) throw Error('还没有选 ComfyUI 的模型，请在绘画 App 的参数里选择');
  return {prompt, negative_prompt: negative, seed, steps: c.steps, scale: c.scale, width, height, sampler: c.sampler, scheduler: c.scheduler, model: c.model, vae: c.vae, denoise: 1, clip_skip: -c.clipSkip};
}

/** Calls the tavern's ComfyUI proxy. headers: the tavern's request headers (CSRF token). */
async function tavern(fetch, headers, path, body, signal) {
  let response;
  try { response = await fetch('/api/sd/comfy/' + path, {method: 'POST', headers: {'Content-Type': 'application/json', ...headers}, body: JSON.stringify(body), signal}); }
  catch (error) { if (error?.name === 'AbortError') throw error; throw Error('连不上酒馆服务器'); }
  return response;
}
const comfyDown = url => `酒馆连不上 ComfyUI（${url}）：请确认 ComfyUI 开着、地址填的是酒馆所在电脑能打开的地址`;
export async function comfyGenerate({fetch = globalThis.fetch, headers = {}, url, workflow, signal}) {
  const response = await tavern(fetch, headers, 'generate', {url, prompt: `{"prompt": ${workflow}}`}, signal);
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    if (response.status === 404) throw Error('这个酒馆没有 ComfyUI 转发接口（/api/sd/comfy），请更新酒馆');
    if (response.status === 403) throw Error('酒馆拒绝了请求（403），请刷新酒馆页面再试');
    const reason = text.replace(/\s+/g, ' ').trim().slice(0, 300);
    throw Object.assign(Error(/fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(reason) || !reason ? comfyDown(url) : 'ComfyUI 没画成：' + reason), {status: response.status === 429 ? 429 : 0});
  }
  let data; try { data = JSON.parse(text); } catch { throw Error('ComfyUI 返回的内容不是图片'); }
  if (!data?.data) throw Error('ComfyUI 没有返回图片（工作流里要有保存图片的节点）');
  return base64Blob(data.data, imageType(data.format));
}
/** Checks the connection and reads what the workflow can use: {models, samplers, schedulers}. */
export async function comfyCatalog({fetch = globalThis.fetch, headers = {}, url}) {
  const ping = await tavern(fetch, headers, 'ping', {url});
  if (ping.status === 404) throw Error('这个酒馆没有 ComfyUI 转发接口（/api/sd/comfy），请更新酒馆');
  if (!ping.ok) throw Error(comfyDown(url));
  const read = async path => { const r = await tavern(fetch, headers, path, {url}); if (!r.ok) return []; try { return await r.json(); } catch { return []; } };
  const [models, samplers, schedulers] = await Promise.all([read('models'), read('samplers'), read('schedulers')]);
  return {models: (Array.isArray(models) ? models : []).map(m => typeof m === 'string' ? {value: m, text: m} : {value: String(m.value), text: String(m.text || m.value)}),
    samplers: (Array.isArray(samplers) ? samplers : []).map(String), schedulers: (Array.isArray(schedulers) ? schedulers : []).map(String)};
}
/** Native node metadata; no third-party manager. Direct mode never sends tavern headers or cookies. */
export async function comfyLoras({fetch = globalThis.fetch, url, transport = 'tavern', signal}) {
  const endpoint = comfyUrl(url) + '/object_info/LoraLoader';
  const direct = transport === 'direct';
  if (!['tavern', 'direct'].includes(transport)) throw Error('LoRA 列表读取方式无效');
  const timeout = AbortSignal.timeout(15000), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  try { response = await fetch(direct ? endpoint : '/proxy/' + endpoint, {method: 'GET', credentials: direct ? 'omit' : 'same-origin', headers: {Accept: 'application/json'}, signal: combined}); }
  catch (error) {
    if (signal?.aborted) throw error;
    throw Error(direct ? '浏览器读不到 ComfyUI 的 LoRA 列表：请检查地址和跨域设置。手机不能用电脑的 127.0.0.1，可改用酒馆代理；也可手填文件名。' : '酒馆代理读不到 LoRA 列表：请检查 ComfyUI 地址和连接；也可手填文件名。');
  }
  const text = await response.text();
  if (!response.ok) {
    if (!direct && /CORS proxy is disabled/i.test(text)) throw Error('酒馆代理尚未开启：在酒馆 config.yaml 设置 enableCorsProxy: true 后重启，或选择浏览器直连。也可以先手填已安装的 LoRA 文件名。');
    throw Error(`LoRA 列表读取失败（HTTP ${response.status}），请检查连接方式和 ComfyUI 地址；也可手填文件名。`);
  }
  let data; try { data = JSON.parse(text); } catch { throw Error('LoRA 接口返回的不是 JSON，请检查地址是否指向 ComfyUI'); }
  const spec = data?.LoraLoader?.input?.required?.lora_name;
  const names = Array.isArray(spec?.[0]) ? spec[0] : spec?.[1]?.options;
  if (!Array.isArray(names) || names.some(n => typeof n !== 'string')) throw Error('ComfyUI 没有返回原生 LoraLoader 文件列表，请检查版本和节点是否正常');
  return [...new Set(names.filter(n => n && n.length <= 1000))].sort((a, b) => a.localeCompare(b));
}
/** The workflows saved in the tavern (its image generation settings): names, and one's text. */
export async function tavernWorkflows({fetch = globalThis.fetch, headers = {}}) {
  const r = await tavern(fetch, headers, 'workflows', {});
  if (!r.ok) throw Error('读不到酒馆里的工作流');
  const list = await r.json().catch(() => []);
  return (Array.isArray(list) ? list : []).map(String);
}
export async function tavernWorkflow({fetch = globalThis.fetch, headers = {}, name}) {
  const r = await tavern(fetch, headers, 'workflow', {file_name: name});
  if (!r.ok) throw Error('读不到这个工作流');
  const text = await r.json();
  return typeof text === 'string' ? text : JSON.stringify(text);
}
