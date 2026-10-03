import {esc, btn, help, groupTitle} from './common.js';
import {icon} from './icons.js';
import {editComfyLoras} from './comfy-loras.js';

const shortName = file => String(file || 'LoRA').split(/[\\/]/).pop().replace(/\.(safetensors|ckpt|pt)$/i, '');
const art = () => `<span class="vibe-blank lora-art">${icon('layers')}<b>LoRA</b></span>`;

/** Same gallery interaction as Vibe, backed by the current workflow draft. */
export function comfyLoraPanel({ctx, api, root, rerender}) {
  let names = [], query = '', loaded = false, loading = false, error = '', connection = '', request = 0, controller, editor, disposed = false;
  const connectionKey = () => { const c = api.getState().draw.comfy; return JSON.stringify([c.url, c.loraTransport]); };
  function syncConnection() {
    const key = connectionKey();
    if (key !== connection) { connection = key; request++; controller?.abort(); names = []; loaded = loading = false; error = ''; }
  }
  const matches = name => !query || String(name).toLowerCase().includes(query.trim().toLowerCase());
  function tile({name, id, using, note, installed = false}) {
    return `<button type="button" class="vibe-tile lora-tile${using ? ' using' : ''}" data-action="${installed ? 'lora-catalog-open' : 'lora-open'}" ${installed ? `data-file="${esc(name)}"` : `data-id="${esc(id)}"`} data-lora-name="${esc(name)}" ${matches(name) ? '' : 'hidden'} aria-label="${esc(name)}" title="${esc(name)}">
      ${art()}<span class="vibe-name">${esc(shortName(name))}</span><small>${esc(note)}</small></button>`;
  }
  function html() {
    syncConnection();
    const d = api.getComfyDraft(), nodes = d.loras.nodes, active = nodes.filter(n => !d.value.disabledLoras.includes(n.id));
    const current = nodes.map(n => tile({name: n.name, id: n.id, using: !d.value.disabledLoras.includes(n.id), note: n.reason ? '查看限制' : d.value.disabledLoras.includes(n.id) ? '已停用' : `强度 ${n.strength_model}`})).join('');
    const available = names.map(name => tile({name, installed: true, using: active.some(n => n.name === name), note: nodes.some(n => n.name === name) ? '已在方案中' : '点开添加'})).join('');
    return `
      ${(names.length + nodes.length > 8 || query) ? `<div class="vibe-search">${icon('search')}<input type="search" data-lora-search value="${esc(query)}" placeholder="搜索 LoRA" aria-label="搜索 LoRA"></div>` : ''}
      ${groupTitle(`方案里的 LoRA · ${active.length}/${nodes.length} 启用`, help('亮框表示启用。点卡片打开单条详情，调整文件、强度或启停；移出不删除模型文件。修改先进入绘画草稿，试画满意后再保存方案。卡片使用统一图标，文件列表不提供封面图片。'))}
      ${d.loras.error ? `<p class="error-copy">${esc(d.loras.error)}</p>` : ''}
      <div class="vibe-grid vibe-scroll lora-grid" data-keep-scroll="lora-current">${current}</div>
      <p class="hint" data-lora-none="current"${nodes.some(n => matches(n.name)) ? ' hidden' : ''}>${nodes.length ? '没有匹配的 LoRA' : '还没有 LoRA，点下方卡片或手动添加。'}</p>
      ${groupTitle(`可用 LoRA${loaded ? ` · ${names.length}` : ''}`, `<span class="title-tools">${btn('lora-refresh', loading ? '读取中…' : icon('refresh') + (loaded ? '刷新' : '读取'), 'text-button', loading ? 'disabled' : '')}${help('从当前 ComfyUI 读取已安装的文件名，不下载模型。列表连接方式在引擎页设置；也可在单张卡片的「文件列表与连接」里调整。')}</span>`)}
      ${error ? `<div class="comfy-note error-copy" role="status">读取失败，可手动添加 ${help(error)}</div>` : loading ? '<div class="comfy-note" role="status">正在读取 LoRA…</div>' : ''}
      <div class="vibe-grid vibe-scroll lora-grid" data-keep-scroll="lora-catalog">${available}</div>
      <p class="hint" data-lora-none="catalog"${names.some(matches) ? ' hidden' : ''}>${!loaded ? '读取列表后，点卡片添加。' : names.length ? '没有匹配的 LoRA' : 'ComfyUI 里还没有 LoRA 文件。'}</p>
      <div class="actions">${btn('lora-manual', icon('add') + '手动添加', 'secondary')}</div>
      <details class="tool-fold" data-group="lora-tools"><summary>${icon('layers')}更多操作</summary><div>${btn('lora-restore', '恢复原始工作流', 'text-button')}</div></details>`;
  }
  function search(value) {
    query = value;
    for (const kind of ['current', 'catalog']) {
      const grid = root().querySelector(`[data-keep-scroll="lora-${kind}"]`);
      if (!grid) continue;
      let shown = 0;
      for (const card of grid.querySelectorAll('[data-lora-name]')) { card.hidden = !matches(card.dataset.loraName); if (!card.hidden) shown++; }
      const note = root().querySelector(`[data-lora-none="${kind}"]`);
      if (note) { note.hidden = shown > 0; if (grid.children.length) note.textContent = '没有匹配的 LoRA'; }
    }
  }
  function open(options) {
    syncConnection(); editor?.close();
    editor = editComfyLoras(ctx, rerender, {catalog: names, ...options});
  }
  async function read() {
    syncConnection(); controller?.abort(); controller = new AbortController();
    const ticket = ++request, key = connection;
    loading = true; error = ''; rerender();
    try {
      const result = await api.comfyLoras({signal: controller.signal});
      if (disposed || ticket !== request || key !== connectionKey()) return;
      names = result; loaded = true;
    } catch (e) { if (!disposed && ticket === request && key === connectionKey()) error = e.message; }
    finally { if (!disposed && ticket === request) { loading = false; rerender(); } }
  }
  async function click(el) {
    switch (el.dataset.action) {
      case 'lora-open': open({nodeId: el.dataset.id}); return true;
      case 'lora-catalog-open': {
        const found = api.getComfyDraft().loras.nodes.find(n => n.name === el.dataset.file);
        open(found ? {nodeId: found.id} : {addFile: el.dataset.file}); return true;
      }
      case 'lora-manual': open({addFile: ''}); return true;
      case 'lora-refresh': if (!loading) await read(); return true;
      case 'lora-restore': {
        const d = api.getComfyDraft();
        if (await ctx.confirm('恢复原始工作流？', '这会重置当前草稿的工作流和 LoRA，其他出图参数保留。保存方案后才写入。') && !disposed) {
          api.updateComfyDraft({workflow: d.value.sourceWorkflow || d.base.workflow || api.drawCatalog.comfyWorkflow, disabledLoras: []}, d.value); rerender();
        }
        return true;
      }
    }
    return false;
  }
  return {html, search, click, dispose() { disposed = true; request++; controller?.abort(); editor?.close(); }};
}
