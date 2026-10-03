import {esc, btn, field, input, select, help} from './common.js';
import {inspectLoras, editLoras} from '../core/comfy-loras.js';
import {icon} from './icons.js';

/** Closing discards local edits; cards apply to the drawing draft before the plan is saved. */
export function editComfyLoras(ctx, onApplied = () => {}, {nodeId = null, addFile = '', catalog = []} = {}) {
  const {api} = ctx, c = api.getState().draw.comfy;
  const initial = api.getComfyDraft().value;
  let workflow = initial.workflow || api.drawCatalog.comfyWorkflow, disabled = [...initial.disabledLoras];
  let transport = c.loraTransport;
  let names = [...catalog], listMessage = '', listDetail = '', loading = false, request = 0, removeArmed = false;
  const controller = new AbortController(), listId = 'comfy-loras-' + crypto.randomUUID();
  const d = ctx.dialog(nodeId !== null ? 'LoRA 详情' : '添加 LoRA', '');
  d.body.dataset.engine = 'comfy';
  const q = selector => d.body.querySelector(selector);
  const attribute = `list="${listId}" autocomplete="off" spellcheck="false" placeholder="文件名.safetensors（可含子目录）"`;
  const strength = (key, label, value, detail = '') => {
    const n = Number(value), shown = Number.isFinite(n) ? n : 0;
    return `<div class="field"><div class="meter-label"><span>${label}${detail ? help(detail) : ''}</span><output>${esc(value)}</output></div><input class="slider" type="range" data-field="${key}" data-lora-original="${esc(value)}" min="${Math.min(-2, Math.floor(shown))}" max="${Math.max(2, Math.ceil(shown))}" step="0.05" value="${shown}" aria-label="${label}"></div>`;
  };
  // Range inputs may round imported values to their step; keep the exact original until the user moves it.
  const strengthValue = el => el?.dataset.loraOriginal ?? el?.value;
  function syncSource() {
    const source = q('[data-field=lora-source]');
    if (!source) return;
    const clip = q('[data-field=lora-new-clip]'), selected = inspectLoras(workflow).sources.find(s => s.id === source.value);
    clip.disabled = !selected || selected.modelOnly;
    clip.closest('.field').hidden = clip.disabled;
    syncAdd();
  }
  function syncAdd() {
    if (nodeId !== null) return;
    q('[data-action=lora-add]').disabled = !q('[data-field=lora-source]').value || !q('[data-field=lora-new-file]').value.trim() || !!inspectLoras(workflow).error;
  }
  function apply() { api.updateComfyDraft({workflow, disabledLoras: disabled}, initial); d.close(true); onApplied(); }
  function render() {
    const info = inspectLoras(workflow);
    const row = nodeId !== null ? info.nodes.find(n => n.id === nodeId) : null;
    if (nodeId !== null && !row) throw Error('这条 LoRA 已经不在了，请重新打开');
    const file = row?.name || addFile || '新的 LoRA';
    d.body.innerHTML = `<div class="vibe-detail lora-detail"><span class="vibe-blank lora-art">${icon('layers')}<b>LoRA</b></span><strong>${esc(file)}</strong></div>
      ${row ? `<div class="group pad" data-lora-id="${esc(row.id)}">
        <div class="setting-row"><span>使用这条 LoRA ${help('关闭后试画会跳过这一条，文件名和强度仍保留。应用到草稿后，保存方案才会写入已保存配置。')}</span><input type="checkbox" class="switch" data-lora-enabled aria-label="启用 LoRA" ${disabled.includes(row.id) ? '' : 'checked'} ${row.reason ? 'disabled' : ''}></div>
        ${row.reason ? `<p class="error-copy">${esc(row.reason)}</p>` : `${field('文件', input('lora-file', row.name, 'text', attribute))}
        <div class="lora-strengths">${strength('lora-model-strength', '模型强度', row.strength_model)}${!row.modelOnly ? strength('lora-clip-strength', '文字强度', row.strength_clip, 'LoRA 对文字理解部分的影响。') : ''}</div>`}
      </div>` : `<div class="group pad">
        ${field('接入位置', select('lora-source', info.sources.length === 1 ? info.sources[0].id : '', [['', '选择接在哪一条后面'], ...info.sources.map(s => [s.id, s.name])]), '已有 LoRA 时，选最后一条可以继续叠加；接入位置影响它后面相连的模型和文字分支。')}
        ${field('文件', input('lora-new-file', addFile || '', 'text', attribute))}
        <div class="lora-strengths">${strength('lora-new-model', '模型强度', 1)}${strength('lora-new-clip', '文字强度', 1, 'LoRA 对文字理解部分的影响。只作用于模型的接入位置不显示这一项。')}</div>
        ${!info.sources.length ? '<p class="error-copy">没有可编辑的接入位置，请在 ComfyUI 加入原生 LoRA 节点后重新导入。</p>' : ''}
      </div>`}
      <details class="tool-fold"><summary>${icon('refresh')}文件列表与连接</summary><div>
        ${btn('lora-read', '刷新文件列表')}
        <span class="comfy-note" data-lora-list-status role="status"></span>
        ${field('读取方式', select('lora-transport', transport, [['tavern', '经酒馆代理'], ['direct', '浏览器直连']]), '代理需要 enableCorsProxy；直连需要允许跨域，且当前设备可访问 ComfyUI。地址在引擎页配置。')}
      </div></details><datalist id="${listId}"></datalist>
      <div class="actions">${row ? btn('lora-apply', '应用到绘画', 'primary', row.reason ? 'disabled' : '') : btn('lora-add', '加入当前方案', 'primary', !info.sources.length || info.error ? 'disabled' : '')}${btn('lora-cancel', '取消')}</div>
      ${row && !row.reason ? `<div class="actions">${btn('lora-remove', '从方案移出', 'danger', `data-id="${esc(row.id)}"`)}</div>` : ''}`;
    updateList(); syncSource();
  }
  function updateList() {
    if (!d.live) return;
    q('datalist').innerHTML = names.map(n => `<option value="${esc(n)}"></option>`).join('');
    q('[data-lora-list-status]').innerHTML = esc(listMessage) + (listDetail ? help(listDetail) : '');
    q('[data-action=lora-read]').disabled = loading;
  }
  // Preserve incomplete edits during network replies: refreshing the catalogue only changes the datalist/status.
  function capture(skip = '') {
    const updates = [], off = new Set(disabled);
    for (const row of d.body.querySelectorAll('[data-lora-id]')) {
      const id = row.dataset.loraId, file = row.querySelector('[data-field=lora-file]');
      if (!file || id === skip) continue;
      const patch = {id, lora_name: file.value, strength_model: strengthValue(row.querySelector('[data-field=lora-model-strength]'))};
      const clip = row.querySelector('[data-field=lora-clip-strength]');
      if (clip) patch.strength_clip = strengthValue(clip);
      updates.push(patch);
      if (row.querySelector('[data-lora-enabled]').checked) off.delete(id); else off.add(id);
    }
    const edited = editLoras(workflow, {updates});
    workflow = edited; disabled = [...off];
  }
  async function readList() {
    const token = ++request;
    transport = q('[data-field=lora-transport]').value;
    api.saveDraw({comfy: {loraTransport: transport}});
    loading = true; names = []; listMessage = '正在读取…'; listDetail = ''; updateList();
    try {
      const result = await api.comfyLoras({transport, signal: controller.signal});
      if (!d.live || token !== request) return;
      names = result; listMessage = names.length ? `${names.length} 个可选` : '还没有 LoRA 文件';
    } catch (error) { if (d.live && token === request) { listMessage = '读取失败，可手填文件名'; listDetail = error.message; } }
    finally { if (d.live && token === request) { loading = false; updateList(); } }
  }
  async function click(event) {
    const button = event.target.closest('[data-action]');
    if (!button || !d.body.contains(button) || button.disabled) return;
    event.preventDefault();
    try {
      switch (button.dataset.action) {
        case 'lora-read': await readList(); break;
        case 'lora-add': {
          const add = {source: q('[data-field=lora-source]').value, lora_name: q('[data-field=lora-new-file]').value, strength_model: strengthValue(q('[data-field=lora-new-model]'))};
          if (!q('[data-field=lora-new-clip]').disabled) add.strength_clip = strengthValue(q('[data-field=lora-new-clip]'));
          capture(); workflow = editLoras(workflow, {add}); apply(); break;
        }
        case 'lora-remove':
          if (!removeArmed) { removeArmed = true; button.textContent = '确认移出当前方案'; break; }
          capture(button.dataset.id); workflow = editLoras(workflow, {remove: button.dataset.id}); disabled = disabled.filter(id => id !== button.dataset.id);
          apply(); break;
        case 'lora-apply': capture(); apply(); break;
        case 'lora-cancel': d.close(false); break;
      }
    } catch (error) { if (d.live) ctx.notify(error.message, {error: true}); }
  }
  function inputChanged(event) {
    const el = event.target;
    if (el.matches('[data-field=lora-transport]') && event.type === 'change') {
      request++; transport = el.value; names = []; loading = false; listMessage = '请重新读取列表'; listDetail = ''; updateList();
    }
    if (el.matches('[data-field=lora-new-file]')) syncAdd();
    if (el.matches('[data-field=lora-source]')) syncSource();
    if (el.matches('.lora-strengths input[type=range]')) {
      delete el.dataset.loraOriginal;
      el.closest('.field').querySelector('output').textContent = el.value;
    }
  }
  d.body.addEventListener('click', click); d.body.addEventListener('input', inputChanged); d.body.addEventListener('change', inputChanged);
  d.onClose(() => { request++; controller.abort(); d.body.removeEventListener('click', click); d.body.removeEventListener('input', inputChanged); d.body.removeEventListener('change', inputChanged); });
  render();
  return d;
}
