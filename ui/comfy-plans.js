import {esc, btn, field, input, select, help, groupTitle} from './common.js';
import {icon} from './icons.js';

/** The drawing app owns the entry points; the backend owns the working copy. */
export function comfyPlans(ctx, render) {
  const {api} = ctx;
  let panel = null;
  const draft = () => api.getComfyDraft();
  const discard = async () => !draft().dirty || await ctx.confirm('放下当前修改？', '未保存的参数和 LoRA 会丢弃。已保存的方案会保留。');
  function summary() {
    const d = draft(), c = api.getState().draw.comfy;
    const rows = c.workflows.map(p => [p.id, p.name]);
    if (!rows.some(([id]) => id === d.value.id)) rows.push([d.value.id, d.value.name + '（已删除，仍可另存）']);
    return `<div class="group pad comfy-plan">
      <div class="row-heading"><strong>出图方案 ${help('方案包含工作流、模型、LoRA 和出图参数。修改先留在草稿，试画使用草稿；点保存才写入方案。切换已保存方案也会切换自动配图使用的方案。草稿在离开 App 后保留，刷新酒馆页面会丢弃。')}</strong><span class="save-state" data-comfy-dirty>${d.dirty ? '未保存' : '已保存'}</span></div>
      ${select('comfy-preset', d.value.id, rows).replace('aria-label="comfy-preset"', 'aria-label="出图方案"')}
      <div class="comfy-plan-actions">${btn('comfy-save', '保存', 'chip-button', !d.dirty ? 'disabled' : '')}${btn('comfy-manage', '管理', 'chip-button', 'aria-label="管理方案与导入"')}</div>
      ${d.conflict ? `<div class="comfy-note error-copy">原方案已改变，请另存或放弃修改。${help('其他页面修改或删除过这套方案。当前草稿仍保留，保存不会覆盖别处的新改动。')}</div>` : ''}
      ${d.missing ? `<div class="comfy-note">${esc(d.missing)} ${help('在旁边的参数栏选择模型后即可生成。')}</div>` : ''}
    </div>`;
  }
  async function choose(id) {
    if (id === draft().value.id) return;
    if (await discard()) { api.selectComfyWorkflow(id); api.resetComfyDraft(); }
    render();
  }
  function manage() {
    panel?.close();
    const initial = draft(), id = initial.value.id;
    const d = panel = ctx.dialog('方案', `
      <div class="group pad">${field('方案名称', input('comfy-name', id === 'default' ? '我的绘画方案' : initial.value.name, 'text', 'maxlength="60"'))}
        <div class="actions">${id === 'default' ? '' : btn('comfy-save-current', '保存当前', 'primary')}${btn('comfy-save-as', '另存为新方案', id === 'default' ? 'primary' : 'secondary')}</div>
      </div>
      ${groupTitle('导入工作流', help('在 ComfyUI 用「导出 (API)」保存 JSON 文件。至少将正面提示词改成 "%prompt%"。每次导入新增一套，已有方案保留。模型和 LoRA 文件仍需安装在 ComfyUI；普通画布 JSON 不能直接出图。'))}
      <div class="group pad comfy-import"><label class="file-pick"><input type="file" accept=".json,application/json" data-comfy-file aria-label="导入工作流 JSON 文件"><span>${icon('add')} 导入 JSON 文件</span></label>${btn('comfy-load-wf', '从酒馆导入', 'secondary')}</div>
      <div class="actions">${initial.dirty ? btn('comfy-discard', '放弃本次修改', 'secondary') : ''}${id === 'default' ? '' : btn('comfy-delete-wf', '删除方案', 'danger')}</div>`);
    let working = false;
    // The phone has one sheet at a time; confirm inline so this editor stays open.
    const confirmHere = text => new Promise(resolve => {
      const note = ctx.doc.createElement('div'); note.className = 'group pad comfy-confirm';
      note.innerHTML = `<p>${esc(text)}</p><div class="actions"><button type="button" class="secondary" data-decision="cancel">取消</button><button type="button" class="primary" data-decision="yes">确认</button></div>`;
      const done = value => { note.remove(); resolve(value); };
      note.addEventListener('click', e => { const b = e.target.closest('[data-decision]'); if (b) done(b.dataset.decision === 'yes'); });
      d.onClose(() => done(false)); d.body.prepend(note); note.querySelector('button').focus();
    });
    const discardHere = async () => !draft().dirty || await confirmHere('继续会放弃本次未保存的参数和 LoRA，已保存方案会保留。');
    const run = async task => {
      if (working || !d.live) return;
      working = true;
      for (const el of d.body.querySelectorAll('button[data-action], input[type=file]')) el.disabled = true;
      try { await task(); } catch (error) { if (d.live) ctx.notify(error.message, {error: true}); }
      finally { working = false; if (d.live) for (const el of d.body.querySelectorAll('button[data-action], input[type=file]')) el.disabled = false; }
    };
    const importWorkflow = (name, workflow) => {
      const row = api.saveComfyWorkflow({name: name.replace(/\.json$/i, '').trim().slice(0, 60) || '导入的方案', workflow});
      api.resetComfyDraft(); d.close(); render(); ctx.notify('已导入「' + row.name + '」');
    };
    d.body.addEventListener('change', event => {
      if (!event.target.matches('[data-comfy-file]')) return;
      const file = event.target.files?.[0]; event.target.value = '';
      if (!file) return;
      run(async () => {
        if (file.size > 300000) throw Error('工作流太大了（超过 300 KB）');
        const workflow = await file.text();
        if (!d.live || !await discardHere() || !d.live) return;
        importWorkflow(file.name, workflow);
      });
    });
    d.body.addEventListener('click', event => {
      const b = event.target.closest('[data-action]');
      if (!b || b.disabled) return;
      run(async () => {
        switch (b.dataset.action) {
          case 'comfy-save-current': case 'comfy-save-as': {
            if (draft().value.id !== id) throw Error('当前方案已切换，请重新打开管理');
            const row = api.saveComfyDraft({name: d.body.querySelector('[data-field=comfy-name]').value, copy: b.dataset.action === 'comfy-save-as'});
            d.close(); render(); ctx.notify('已保存「' + row.name + '」'); break;
          }
          case 'comfy-discard': if (await discardHere() && d.live) { api.resetComfyDraft(); d.close(); render(); } break;
          case 'comfy-delete-wf':
            if (await confirmHere(`删除「${initial.value.name}」及本次修改，改用默认方案？`) && d.live) {
              api.deleteComfyWorkflow(id); api.resetComfyDraft(); d.close(); render();
            } break;
          case 'comfy-load-wf': {
            const names = await api.comfyWorkflows();
            if (!d.live) return;
            if (!names.length) { ctx.notify('酒馆里还没有保存工作流'); return; }
            const list = ctx.doc.createElement('div'); list.className = 'group comfy-tavern-list';
            list.innerHTML = names.map(n => `<button type="button" class="list-row" data-wf="${esc(n)}"><span><strong>${esc(n.replace(/\.json$/i, ''))}</strong></span>${icon('next')}</button>`).join('');
            d.body.querySelector('.comfy-tavern-list')?.remove(); d.body.append(list);
            list.addEventListener('click', event => {
              const pick = event.target.closest('[data-wf]'); if (!pick) return;
              run(async () => {
                const workflow = await api.comfyWorkflow(pick.dataset.wf);
                if (!d.live || !await discardHere() || !d.live) return;
                importWorkflow(pick.dataset.wf, workflow);
              });
            }); break;
          }
        }
      });
    });
  }
  async function click(el) {
    switch (el.dataset.action) {
      case 'comfy-manage': manage(); return true;
      case 'comfy-save':
        if (draft().value.id === 'default') manage();
        else { api.saveComfyDraft(); render(); ctx.notify('方案已保存'); }
        return true;
    }
    return false;
  }
  return {summary, choose, click, dispose() { panel?.close(); }};
}
