import {createView, esc, btn, field, input, select, textArea, toggle, heading, help, groupTitle, plate, avatar, empty} from './common.js';
import {icon} from './icons.js';
import {openImageViewer} from '../image-viewer.js';
import {downloadAction} from '../download.js';
import {vibePanel} from './vibes.js';
import {comfyPlans} from './comfy-plans.js';
import {comfyLoraPanel} from './comfy-lora-panel.js';

const SIZES = [['portrait', '竖图', 832, 1216], ['landscape', '横图', 1216, 832], ['square', '方图', 1024, 1024], ['tall', '大竖图', 1024, 1536]];
/** Pictures kept in the column beside the canvas (this visit of the app; all of them are also in the album). */
const MAX_RESULTS = 30;
const TIERS = {0: '未订阅', 1: 'Tablet', 2: 'Scroll', 3: 'Opus'};
const POSITION = i => i < 0 ? '自动' : 'ABCDE'[i % 5] + (Math.floor(i / 5) + 1);

export function drawApp(ctx) {
  const {api} = ctx, v = createView(ctx, 'draw'), urls = new Map();
  let tab = 'prompt', prompt = '', negative = '', characters = [], seed = -1, results = [], current = -1, newest = false, busy = false, subscription = null, styleDraft = null, epoch = 0;
  // ComfyUI: models, samplers and schedulers read from it (null until 读取 is pressed).
  let comfyInfo = null, comfyRequest = 0, comfyAddress = '';
  const plans = comfyPlans(ctx, () => render());
  const vibes = vibePanel({ctx, api, root: () => v.root, rerender: () => render()});
  const loras = comfyLoraPanel({ctx, api, root: () => v.root, rerender: () => render()});
  let queue = api.drawQueue?.() || [], cloudError = api.cloudQueueError?.() || '', cloudNote = null;
  const jobState = j => j.state === 'running' ? '正在画' : j.state === 'busy' ? `账号正忙，稍后重试（第 ${j.attempt} 次）` : j.state === 'spacing' ? '马上开始'
    : j.state === 'remote' ? (j.cloud?.position > 0 ? `云端排队，前面 ${j.cloud.position} 位` : j.cloud?.cooldown > 5000 ? `大家一起等 ${Math.ceil(j.cloud.cooldown / 1000)} 秒` : '云端马上轮到') : `第 ${j.position + 1} 位`;
  const queueCard = () => (queue.length || cloudError) ? `<div class="group pad queue-card"><div class="row-heading"><strong style="flex:1">排队 · ${queue.length} 张</strong>${queue.length ? btn('cancel-all', '全部取消', 'text-button') : ''}</div>${cloudError && state().queue.cloud.enabled ? `<p class="hint error-copy" style="padding:0 0 6px">${esc(cloudError)}，这次按本机排队</p>` : ''}${queue.map(j => `<div class="setting-row"><span>${esc(j.label || '图片')}</span><small>${esc(jobState(j))}</small>${j.state === 'running' ? '' : btn('cancel-job', icon('close'), 'text-button', `data-key="${esc(j.key)}" aria-label="取消这张"`)}</div>`).join('')}</div>` : '';
  const state = () => api.getState().draw;
  const eng = () => state().engine, engineName = (e = eng()) => api.drawCatalog.engineNames?.[e] || 'NovelAI';
  // Cloud queue fields as typed; saved when an input changes or a button uses them.
  const cloudFields = () => {
    const saved = state().queue.cloud, field = key => v.root.querySelector(`[data-cloud=${key}]`)?.value;
    return {enabled: saved.enabled, kind: saved.kind, url: (field('url') ?? saved.url).trim(), room: (field('room') ?? saved.room).trim()};
  };
  // Each engine remembers its own 画风; GPT and ComfyUI use NovelAI's until one is picked for them.
  const styleId = () => { const d = state(); return (d.engine === 'nai' ? '' : d[d.engine]?.style) || d.activeStyle; };
  const style = () => { const d = state(); return d.styles.find(s => s.id === styleId()) || d.styles[0]; };
  // A result as a file: NovelAI_种子.png.
  const resultFile = async result => { const photo = await api.getPhoto(result.photoId); if (!photo) throw Error('这张图已经不在相册里了'); return {source: photo.blob, name: `${(api.drawCatalog.engineNames?.[result.engine] || 'NovelAI').replace(/\s+/g, '')}_${result.seed >= 0 ? result.seed : photo.name}`}; };
  const urlFor = async id => {
    if (urls.has(id)) return urls.get(id);
    const photo = await api.getPhoto(id);
    if (!photo) return '';
    const url = ctx.win.URL.createObjectURL(photo.blob);
    urls.set(id, url);
    return url;
  };

  function quote() {
    const d = state();
    return api.drawQuote(d.engine === 'nai' ? {...d.params, ...(seed >= 0 ? {seed} : {})} : seed >= 0 ? {seed} : {}, d.engine === 'comfy');
  }
  function costChip(q) {
    const e = eng();
    if (!api.drawReady()) return `<span class="chip" data-engine="none">${e === 'comfy' ? '未填地址' : '未填密钥'}</span>`;
    if (e === 'gpt') return `<span class="chip${q.free === false ? ' warn' : ''}">${icon('alert')}每张都要花钱${q.free === false ? '' : ' · 不先问'}</span>`;
    if (e === 'comfy') return `<span class="chip">ComfyUI</span>`;
    if (q.free === true) return `<span class="chip">${icon(q.guard ? 'lock' : 'unlock')}${q.v5 ? `V5 免费额度 ${q.usage.percent}%` : '免费档 · 0 Anlas'}</span>`;
    if (q.free === false) return `<span class="chip warn">${icon('alert')}${q.v5 && q.usage && q.params.steps <= 28 && q.params.width * q.params.height <= 1048576 ? 'V5 免费额度用完 · 会扣 Anlas' : '会扣 Anlas'}</span>`;
    return `<span class="chip" data-engine="none">${icon(q.guard ? 'lock' : 'unlock')}免费档内 · 订阅未确认</span>`;
  }

  async function render() {
    const ticket = ++epoch, d = state(), e = d.engine, s = styleDraft || style(), q = quote(), p = q.params, keyed = api.drawReady();
    const comfy = e === 'comfy' ? api.getComfyDraft() : null;
    if (comfyAddress !== d.comfy.url) { comfyAddress = d.comfy.url; comfyInfo = null; comfyRequest++; }
    if (tab === 'vibe' || tab === 'lora') tab = e === 'nai' ? 'vibe' : e === 'comfy' ? 'lora' : 'prompt';
    const shown = results[current];
    const main = shown ? await urlFor(shown.photoId) : '';
    const thumbs = await Promise.all(results.map(r => urlFor(r.photoId)));
    if (v.disposed || ticket !== epoch) return;
    const size = SIZES.find(([, , w, h]) => w === d.params.width && h === d.params.height)?.[0] || 'custom';
    const tabs = [['prompt', '提示词'], ['chars', '角色'], ['params', '参数'], ...(e === 'nai' ? [['vibe', 'Vibe']] : e === 'comfy' ? [['lora', 'LoRA']] : []), ['chat', '正文出图']];
    v.root.dataset.engine = e;
    let body = '';
    if (tab === 'prompt') body = `
      <div class="group pad">${field('这张图的提示词', textArea('prompt', prompt, 'rows="4" placeholder="英文 tag，逗号分隔，例如 2girls, rainy day, cafe window, sharing an umbrella"'), e === 'gpt' ? '会和画风的固定正面、每个角色的外貌一起整理成一段英文描述发给 GPT。画师串、权重括号和负面不会发给 GPT。' : e === 'comfy' ? '实际发送：画师串 + 固定正面 + 这里的提示词，后面接上每个角色的外貌；NovelAI 的权重写法会自动换成 ComfyUI 的。' : '实际发送：画师串 + 固定正面 + 这里的提示词。')}
        <div class="actions" style="margin-top:0">${btn('suggest', icon('wand') + '从剧情生成', 'secondary')}</div>
        ${e === 'gpt' ? '' : field('这张图额外的负面', textArea('negative', negative, 'rows="2" placeholder="可以留空，会和固定负面合在一起"'))}</div>`;
    if (tab === 'chars') body = (characters.length ? characters.map((c, i) => `
      <div class="group pad draw-char" data-engine="${ctx.engineOf(c.name)}"><div class="row-heading">${avatar(c.name, ctx.engineOf(c.name), 30)}<strong style="flex:1">${esc(c.name)}</strong><span class="chip">位置 ${POSITION(c.position)}</span>${btn('remove-char', icon('trash'), 'text-button', `data-index="${i}" aria-label="移除 ${esc(c.name)}"`)}</div>
        <div class="char-body">${textArea('char', c.prompt, `data-index="${i}" rows="3" aria-label="${esc(c.name)} 的提示词"`)}
          <div class="pos-grid" aria-label="画面位置">${Array.from({length: 25}, (_, k) => `<button data-action="position" data-index="${i}" data-position="${k}" aria-pressed="${c.position === k}" aria-label="位置 ${POSITION(k)}"></button>`).join('')}</div></div>
        ${btn('position', '让模型自己决定位置', 'text-button', `data-index="${i}" data-position="-1" aria-pressed="${c.position < 0}"`)}</div>`).join('') : empty('还没有加入角色', e === 'gpt' ? '每个角色的外貌和在画面里的位置，会写进给 GPT 的描述里。' : e === 'comfy' ? 'ComfyUI 没有分角色的提示词：每个人的外貌接在提示词后面，位置不起作用。' : 'V4 / 4.5 可以给每个角色单独写外貌，并指定在画面里的大致位置。', 'person'))
      + `<div class="actions">${btn('add-char', icon('add') + '从角色里添加', 'secondary')}${btn('add-custom', icon('add') + '手动添加', 'secondary')}</div>`;
    if (tab === 'params' && e === 'gpt') body = gptParams(d.gpt);
    if (tab === 'params' && e === 'comfy') body = comfyParams(comfy.value, comfy.controls);
    if (tab === 'params' && e === 'nai') body = `
      <div class="group pad">
        ${field('模型', select('model', d.params.model, api.drawCatalog.models.map(m => [m, api.drawCatalog.modelNames[m] || m])), /^nai-diffusion-5/.test(d.params.model) ? 'V5 对 Opus 不是无限的：免费档内的图用一份会慢慢恢复的免费额度，用完后改扣 Anlas。V4.5 及更早的模型仍然无限。' : '')}
        <div class="field"><span>尺寸</span><div class="size-chips">${SIZES.map(([k, label, w, h]) => `<button data-action="size" data-size="${k}" aria-pressed="${size === k}" ${d.guard && w * h > 1048576 ? 'disabled' : ''}><i style="width:${w / 100}px;height:${h / 100}px"></i>${label}<small>${w}×${h}</small></button>`).join('')}</div></div>
        <div class="field"><div class="meter-label"><span>步数${d.guard ? ' · 免费档最多 28' : ''}</span><output>${d.params.steps}</output></div><input class="slider" type="range" data-param="steps" min="1" max="${d.guard ? 28 : 50}" value="${d.params.steps}" aria-label="步数"></div>
        <div class="field"><div class="meter-label"><span>提示词相关性 CFG</span><output>${d.params.scale.toFixed(1)}</output></div><input class="slider" type="range" data-param="scale" min="0" max="10" step="0.1" value="${d.params.scale}" aria-label="CFG"></div>
        ${field('采样器', select('sampler', d.params.sampler, api.drawCatalog.samplers.map(m => [m, m])))}
        ${field('噪声调度', select('schedule', d.params.schedule, api.drawCatalog.schedules.map(m => [m, m])))}
        <div class="field"><span>种子${help('填 -1 或留空表示每次随机。')}</span><div class="inline-row">${input('seed', seed >= 0 ? seed : '', 'number', 'min="-1" placeholder="随机"')}${btn('dice', icon('dice'), 'round-button', 'aria-label="随机一个种子"')}</div></div>
        ${/^nai-diffusion-5/.test(d.params.model) ? '' : toggle('variety', 'Variety+', d.params.variety, '让构图更多变，适合 V4 / 4.5。')}
      </div>
      <div class="group">${toggle('guard', '免费档守卫', d.guard, '开启时步数不超过 28、尺寸不超过 1024×1024，不会发出扣 Anlas 的请求。关闭后，会扣点的生成每次都先问你。')}</div>
      ${groupTitle('排队', help('一个 NovelAI 账号同一时间只能画一张。几个人共用账号时，同时请求会得到 429，太频繁还可能被风控。\n\n插件里所有出图都排成一队，一张画完再发下一张（同一个浏览器里开的几个酒馆页面也会互相等）；两张之间留出间隔；遇到 429 就等一会儿再试，等待时间一次比一次长。'))}
      <div class="group pad">
        <div class="field"><div class="meter-label"><span>两张图之间至少间隔</span><output>${d.queue.gap} 秒</output></div><input class="slider" type="range" data-queue="gap" min="0" max="60" value="${d.queue.gap}" aria-label="两张图之间的间隔秒数"></div>
        <div class="field"><div class="meter-label"><span>账号正忙（429）时重试</span><output>${d.queue.retries} 次</output></div><input class="slider" type="range" data-queue="retries" min="0" max="10" value="${d.queue.retries}" aria-label="429 重试次数"></div>
      </div>
      ${groupTitle('云端队列', help('几个人共用一个 NovelAI 账号时，让所有人排同一条队：前面有人在画就先等着。\n\n两种队列服务：\n· 按密钥排队：已经有的队列服务（比如智绘姬用的那个）。不用房间码，用同一个 NovelAI 密钥的人自动排进同一条队，也能和用智绘姬的朋友一起排。插件只发送密钥的 SHA-256 摘要（算不回密钥）、这台浏览器的随机编号和每张图的随机编号。\n· 房间码：自己在 Cloudflare 免费部署的队列（插件目录 cloud-queue/部署说明.md），大家填同一个地址和房间码；撞上 429 时全房间一起等。只发送房间码和排队号。\n\n两种都看不到密钥、提示词和图片。连不上时照常出图，只是退回本机排队。'))}
      <div class="group pad">
        ${toggle('cloud', '使用云端队列', d.queue.cloud.enabled)}
        <div class="field"><span>队列类型</span><div class="segmented" style="margin:0">${[['keyhash', '按密钥排队'], ['room', '房间码']].map(([k, l]) => `<button data-action="cloud-kind" data-kind="${k}" aria-pressed="${d.queue.cloud.kind === k}">${l}</button>`).join('')}</div></div>
        <div class="field"><span>队列地址</span><input data-cloud="url" type="url" value="${esc(d.queue.cloud.url)}" placeholder="${d.queue.cloud.kind === 'keyhash' ? 'https://……hf.space' : 'https://st-iphonie-queue.你的名字.workers.dev'}" autocomplete="off" aria-label="队列地址"></div>
        ${d.queue.cloud.kind === 'keyhash' ? '<p class="hint" style="padding:0">不用房间码：用同一个 NovelAI 密钥的人会自动排进同一条队。</p>' : `<div class="field"><span>房间码</span><div class="inline-row"><input data-cloud="room" value="${esc(d.queue.cloud.room)}" placeholder="16–64 位字母或数字" autocomplete="off" aria-label="房间码">${btn('new-room', '生成', 'chip-button')}</div></div>`}
        <div class="actions" style="margin-top:0">${btn('test-cloud', icon('refresh') + '测试连接', 'secondary')}</div>
        ${cloudNote ? `<p class="hint${cloudNote.ok ? '' : ' error-copy'}" style="padding:0">${esc(cloudNote.text)}</p>` : ''}
      </div>`;
    if (tab === 'vibe') body = vibes.html();
    if (tab === 'lora') body = plans.summary() + loras.html();
    if (tab === 'chat') body = `
      ${d.enabled ? '' : `<div class="banner">${icon('image')}<span>正文出图没有开启，在「设置 · 绘图」里打开。</span>${btn('go-settings', '去打开', 'chip-button')}</div>`}<div class="group">${toggle('auto', '新回复自动出图', d.auto, '只自动画不花钱的：NovelAI 免费档内的图、ComfyUI 的图；GPT 生图在「每张先问」关掉后也会自动画。其余的正文里会显示“点击生成”。')}${toggle('fold', '正文图片默认收起', d.fold, '收起后正文里只留一个小缩略图，点开再看，手机上不占地方。每张图也可以单独收起或展开。')}</div>
      <div class="field"><span>配图方式${help('单独配图：正文模型只管写故事；回复写完后，插件用同一个模型再单独请求一次，读这条回复、挑画面、写出图块，再把图插到对应的段落后面。出图规则不会挤占正文，张数和格式更稳，每条回复多一次请求。\n\n正文里顺手写：把出图规则加进正文请求，模型写故事时顺手写出图块。只要一次请求，但规则较长，偶尔会影响正文或漏写。')}</span><div class="segmented" style="margin:0">${[['separate', '回复后单独配图'], ['inline', '正文里顺手写']].map(([k, l]) => `<button data-action="mode" data-mode="${k}" aria-pressed="${d.mode === k}">${l}</button>`).join('')}</div></div>
      <div class="group">${toggle('strip', '发给模型时去掉旧出图块', d.strip, '出图块留在聊天记录里（图片靠它显示），但之后每次请求模型时会把它们去掉，省下上下文。')}</div>
      <div class="actions">${btn('plan-latest', icon('wand') + '给最新回复配图', 'secondary', api.planLatestPictures && d.enabled ? '' : 'disabled')}</div>
      <div class="group pad"><p class="hint" style="padding:6px 0">出图块长这样（一张图一块）：${help('场景和每个人分开写：人数、镜头、光线放场景；表情、视线、动作放各自的角色行。插件把画风固定串接在场景前面，把角色 App 里的固定外貌补进对应的角色行，再交给选中的绘图引擎（GPT 会整理成英文描述，ComfyUI 会合成一条提示词）。新角色第一次出现时，模型写的「新外貌」会自动存进角色 App。图片会上传到酒馆，并存进相册。')}</p><pre class="code-preview">${esc(api.picTagFormat)}</pre></div>
      <p class="hint">每条回复固定出 ${(d.presets.find(p => p.id === d.activePreset) || d.presets[0]).count} 张图，在出图规则里改张数。</p><div class="actions">${btn('open-presets', icon('edit') + '编辑出图规则', 'secondary')}</div>`;
    const sub = e === 'gpt' ? d.gpt.model : e === 'comfy' ? '' : subscription ? `${TIERS[subscription.tier] || '订阅'} · ${subscription.anlas} Anlas` : keyed ? '读取中' : '';
    v.draw(heading('绘图', keyed && sub ? `<span class="chip">${esc(sub)}</span>` : '', engineName(e))
      + `<div class="segmented draw-engines" role="group" aria-label="用哪个画">${api.drawCatalog.engines.map(k => `<button data-action="draw-engine" data-pick="${k}" aria-pressed="${k === e}">${esc(engineName(k))}</button>`).join('')}</div>`
      + (keyed ? '' : `<div class="banner">${icon('key')}<span>${esc(api.drawMissing())}。</span>${btn('go-key', '去填写', 'chip-button')}</div>`)
      + queueCard()
      + `<div class="draw-meta">${btn('pick-style', icon('layers') + esc(style().name) + icon('down'), 'chip-button')}${costChip(q)}</div>
        <div class="canvas-card"><div class="canvas-main${main ? '' : ' empty'}" style="aspect-ratio:${p.width}/${p.height}">${main ? `<button type="button" class="canvas-zoom" data-action="zoom" aria-label="放大查看"><img src="${esc(main)}" alt="生成的图片"></button>` : `<span>${comfy && !(comfy.controls.includes('width') && comfy.controls.includes('height')) ? '尺寸由工作流决定' : `${p.width} × ${p.height}`}<br>还没有图</span>`}${busy ? `<span class="canvas-busy">${esc(engineName(e))} 正在画……</span>` : ''}</div>
          ${results.length ? `<div class="canvas-side" data-keep-scroll="results">${thumbs.map((url, i) => `<button class="thumb" data-action="thumb" data-index="${i}" aria-pressed="${i === current}" aria-label="第 ${i + 1} 张">${url ? `<img src="${esc(url)}" alt="">` : ''}</button>`).join('')}</div>` : ''}</div>
        ${shown ? `<p class="hint canvas-meta">${[shown.params.model, `${shown.params.width}×${shown.params.height}`, shown.params.steps ? shown.params.steps + ' 步' : '', shown.seed >= 0 ? '种子 ' + shown.seed : ''].filter(Boolean).map(esc).join(' · ')}</p>` : ''}
        <details data-group="style" class="style-card"><summary>${icon('paint')}画风 · ${esc(s.name)}<span class="save-state" data-style-state>${styleDraft ? '未保存' : ''}</span></summary><div>
          ${field('名字', input('name', s.name, 'text', 'data-style-field maxlength="40"'))}
          ${field('画师串', textArea('artist', s.artist, 'class="code" rows="2" data-style-field placeholder="例如 artist:wlop, artist:ciloranko"'))}
          ${field('固定正面', textArea('positive', s.positive, 'class="code" rows="2" data-style-field'))}
          ${field('固定负面', textArea('negative-fixed', s.negative, 'class="code" rows="2" data-style-field'))}
          <div class="actions" style="margin-top:0">${btn('save-style', '保存画风', 'primary')}</div>
          ${help('正文出图和这里单独生图都会带上画风。每个引擎记住自己用的画风；GPT 不读画师串和固定负面。')}</div></details>
        <div class="segmented draw-tabs">${tabs.map(([k, l]) => `<button data-action="tab" data-tab="${k}" aria-pressed="${k === tab}">${l}</button>`).join('')}</div>
        ${body}
        <div class="savebar">${btn('generate', busy ? '正在画……' : q.free === false ? icon('alert') + (e === 'gpt' ? '生成（要花钱）' : '生成（会扣 Anlas）') : icon('paint') + '生成', 'primary', busy || !keyed || comfy?.missing ? 'disabled' : '')}</div>`);
    // A new picture goes on top of the column: show it.
    if (newest) { newest = false; const side = v.root.querySelector('.canvas-side'); if (side) side.scrollTop = 0; }
  }

  /** GPT: quality, default 画幅 (正文出图 follows each block's own) and whether to ask before every paid picture. */
  function gptParams(g) {
    const seg = (action, value, list) => `<div class="segmented" style="margin:0">${list.map(([k, l]) => `<button data-action="${action}" data-value="${k}" aria-pressed="${value === k}">${l}</button>`).join('')}</div>`;
    return `<div class="group pad">
        <div class="setting-row"><span>模型</span><small>${esc(g.model)}</small>${btn('go-key', '在引擎卡包里改', 'text-button')}</div>
        <div class="field"><span>画质${help('low 最便宜最快，high 最贵最细。auto 让 GPT 自己定。dall-e-3 只分普通和高清（high）。')}</span>${seg('gpt-quality', g.quality, [['auto', '自动'], ['low', '低'], ['medium', '中'], ['high', '高']])}</div>
        <div class="field"><span>画幅${help('这里单独生图用的画幅。正文出图按每个出图块写的画幅来。GPT 只能画 1024×1024、1024×1536、1536×1024 这几种（dall-e-3 是 1792 的）。')}</span>${seg('gpt-orientation', g.orientation, [['portrait', '竖图'], ['landscape', '横图'], ['square', '方图']])}</div>
      </div>
      <div class="group">${toggle('gptAsk', '每张先问', g.ask, 'GPT 生图每张都要花钱。打开时，每张图画之前都先问你，新回复也不会自动画（正文里显示“点击生成”）。关掉后不再问，新回复会自动画，费用自己留意。')}</div>`;
  }
  /** ComfyUI: model, size, steps, CFG, sampler, scheduler and seed (the workflow decides what it uses). */
  function comfyParams(c, controls) {
    const has = key => controls.includes(key), info = comfyInfo;
    const size = SIZES.find(([, , w, h]) => w === c.width && h === c.height)?.[0] || 'custom';
    const choose = (key, value, list, placeholder) => list?.length
      ? select(key, value, [['', '请选择'], ...(list.some(x => (typeof x === 'string' ? x : x.value) === value) || !value ? [] : [[value, value]]), ...list.map(x => typeof x === 'string' ? [x, x] : [x.value, x.text])])
      : input(key, value, 'text', `autocomplete="off" spellcheck="false" placeholder="${placeholder}"`);
    const slider = (key, label, min, max, step = 1) => has(key) ? `<div class="field"><div class="meter-label"><span>${label}</span><output>${c[key]}</output></div><input class="slider" type="range" data-comfy="${key}" min="${min}" max="${max}" step="${step}" value="${c[key]}" aria-label="${label}"></div>` : '';
    return `<div class="group pad">
      <div class="row-heading"><strong>出图参数 ${help('这里只显示工作流留给插件填写的参数。工作流写死的值由工作流决定，需要在 ComfyUI 修改后重新导入。参数修改先保留在草稿，试画满意后再保存方案。')}</strong>${btn('comfy-read', icon('refresh'), 'round-button', 'aria-label="刷新模型和采样器"')}</div>
      ${info?.error ? `<div class="comfy-note error-copy">列表读取失败，可手填 ${help(info.error)}</div>` : ''}
      ${has('model') ? field('模型', choose('comfy-model', c.model, info?.models, '刷新列表，或填模型文件名')) : `<div class="comfy-note">模型由工作流指定 ${help('当前工作流没有模型占位符，模型选择保留在工作流内。')}</div>`}
      ${has('width') && has('height') ? `<div class="field"><span>画幅</span><div class="size-chips">${SIZES.map(([k, label, w, h]) => `<button data-action="comfy-size" data-size="${k}" aria-pressed="${size === k}"><i style="width:${w / 100}px;height:${h / 100}px"></i>${label}<small>${w}×${h}</small></button>`).join('')}</div></div>` : ''}
      <div class="comfy-strengths">${has('width') ? field('宽度', input('comfy-width', c.width, 'number', 'min="64" max="4096" step="8"')) : ''}${has('height') ? field('高度', input('comfy-height', c.height, 'number', 'min="64" max="4096" step="8"')) : ''}</div>
      ${slider('steps', '步数', 1, 150)}${slider('scale', '提示词相关性 CFG', 0, 30, .1)}
      ${has('sampler') ? field('采样器', choose('comfy-sampler', c.sampler, info?.samplers, 'euler_ancestral')) : ''}
      ${has('scheduler') ? field('噪声调度', choose('comfy-scheduler', c.scheduler, info?.schedulers, 'normal')) : ''}
      ${has('vae') ? field('VAE', input('comfy-vae', c.vae, 'text', 'placeholder="VAE 文件名"'), '将潜在图像解码成图片的模型，文件要先安装在 ComfyUI。') : ''}
      ${slider('clipSkip', 'CLIP Skip', 1, 12)}
      ${has('seed') ? `<div class="field"><span>种子${help('填 -1 或留空表示每次随机。种子属于本次出图，不写进方案。')}</span><div class="inline-row">${input('seed', seed >= 0 ? seed : '', 'number', 'min="-1" placeholder="随机"')}${btn('dice', icon('dice'), 'round-button', 'aria-label="随机一个种子"')}</div></div>` : ''}
    </div>`;
  }
  async function readComfy() {
    const token = ++comfyRequest, url = state().comfy.url;
    let info;
    try { info = await api.comfyCatalog(url); }
    catch (error) { info = {error: error.message, models: [], samplers: [], schedulers: []}; }
    if (!v.disposed && token === comfyRequest && url === state().comfy.url) { comfyInfo = info; render(); }
  }

  async function refreshSubscription(force = false) {
    if (eng() !== 'nai' || !api.keyStatus('nai')) { subscription = null; return; }
    try { subscription = await api.naiSubscription(force); }
    catch (error) { subscription = null; ctx.notify(error.message); }
    if (!v.disposed) render();
  }

  // Loads a picture request sent from the chat ("在绘图中打开").
  v.load = request => {
    if (!request) return;
    prompt = request.tag || request.prompt || '';
    seed = Number.isInteger(request.seed) ? request.seed : -1;
    const routes = api.getState().routes;
    characters = (request.characters || []).map(c => ({name: routes.find(r => r.appearance?.trim() === c.prompt?.trim())?.name || '角色', prompt: c.prompt, position: c.position ?? -1}));
    tab = 'prompt';
    render();
  };
  v.refresh = () => { styleDraft = null; render(); refreshSubscription(); };
  v.onDraw = event => {
    if (event.subscription) subscription = event.subscription;
    if (event.queue) { queue = event.queue; cloudError = event.cloud || ''; }
    if (event.subscription || event.queue || event.vibes && tab === 'vibe') render();
  };
  const dispose = v.dispose;
  v.dispose = () => { epoch++; comfyRequest++; plans.dispose(); loras.dispose(); for (const url of urls.values()) ctx.win.URL.revokeObjectURL(url); urls.clear(); dispose(); };

  v.on('input', '[data-field]', el => {
    const key = el.dataset.field;
    if (key === 'prompt') prompt = el.value;
    else if (key === 'negative') negative = el.value;
    else if (key === 'char') characters[Number(el.dataset.index)].prompt = el.value;
    else if (el.hasAttribute('data-style-field')) {
      styleDraft ||= {...style()};
      styleDraft[key === 'negative-fixed' ? 'negative' : key] = el.value;
      const mark = v.root.querySelector('[data-style-state]');
      if (mark) mark.textContent = '未保存';
    } else if (key === 'seed') seed = el.value === '' ? -1 : Math.max(-1, Math.floor(Number(el.value) || -1));
  });
  v.on('input', '[data-param]', el => { el.previousElementSibling.querySelector('output').textContent = el.dataset.param === 'scale' ? Number(el.value).toFixed(1) : el.value; });
  v.on('change', '[data-param]', el => { api.saveDraw({params: {[el.dataset.param]: Number(el.value)}}); render(); });
  v.on('input', '[data-queue]', el => { el.previousElementSibling.querySelector('output').textContent = el.value + (el.dataset.queue === 'gap' ? ' 秒' : ' 次'); });
  v.on('change', '[data-queue]', el => { api.saveDraw({queue: {[el.dataset.queue]: Number(el.value)}}); });
  v.on('change', 'select[data-field]', el => { if (/^comfy-/.test(el.dataset.field)) return; api.saveDraw({params: {[el.dataset.field]: el.value}}); render(); });
  // ComfyUI fields: a select from 读取, or a typed name when nothing was read.
  v.on('change', '[data-field=comfy-preset]', el => plans.choose(el.value));
  function markComfyDraft(draft) {
    const badge = v.root.querySelector('[data-comfy-dirty]'), save = v.root.querySelector('[data-action=comfy-save]');
    if (badge) badge.textContent = draft.dirty ? '未保存' : '已保存';
    if (save) save.disabled = !draft.dirty;
  }
  v.on('input', 'input[data-field^=comfy-]', el => { markComfyDraft(api.updateComfyDraft({params: {[el.dataset.field.slice(6)]: el.value.trim()}})); });
  v.on('change', '[data-field^=comfy-]:not([data-field=comfy-preset])', el => { api.updateComfyDraft({params: {[el.dataset.field.slice(6)]: el.value.trim()}}); render(); });
  v.on('input', '[data-comfy]', el => { el.previousElementSibling.querySelector('output').textContent = el.dataset.comfy === 'scale' ? Number(el.value).toFixed(1) : el.value; markComfyDraft(api.updateComfyDraft({params: {[el.dataset.comfy]: Number(el.value)}})); });
  v.on('change', '[data-comfy]', el => { api.updateComfyDraft({params: {[el.dataset.comfy]: Number(el.value)}}); render(); });
  v.on('change', '[data-cloud]', () => { api.saveDraw({queue: {cloud: cloudFields()}}); cloudNote = null; });
  v.on('change', 'input.switch[data-field]', el => {
    const key = el.dataset.field;
    if (key === 'variety') api.saveDraw({params: {variety: el.checked}});
    else if (key === 'vibeEnabled') api.saveDraw({vibe: {enabled: el.checked}});
    else if (key === 'cloud') api.saveDraw({queue: {cloud: {...cloudFields(), enabled: el.checked}}});
    else if (key === 'gptAsk') api.saveDraw({gpt: {ask: el.checked}});
    else api.saveDraw({[key]: el.checked});
    render();
  });
  v.on('input', '[data-vibe-search]', el => vibes.search(el.value));
  v.on('input', '[data-lora-search]', el => loras.search(el.value));
  v.on('change', '[data-vibe-file]', async el => { const files = [...el.files]; el.value = ''; await vibes.importFiles(files); });
  v.on('click', '[data-action]', async el => {
    if (eng() === 'comfy' && await plans.click(el)) return;
    if (eng() === 'comfy' && await loras.click(el)) return;
    if (el.dataset.action?.startsWith('vibe-') && await vibes.click(el)) return;
    const index = Number(el.dataset.index);
    switch (el.dataset.action) {
      case 'tab': tab = el.dataset.tab; await render(); break;
      case 'draw-engine': api.saveDraw({engine: el.dataset.pick}); styleDraft = null; render(); refreshSubscription(); break;
      case 'gpt-quality': api.saveDraw({gpt: {quality: el.dataset.value}}); render(); break;
      case 'gpt-orientation': api.saveDraw({gpt: {orientation: el.dataset.value}}); render(); break;
      case 'comfy-size': { const [, , width, height] = SIZES.find(s => s[0] === el.dataset.size); api.updateComfyDraft({params: {width, height}}); render(); break; }
      case 'comfy-read': await v.busy(el, readComfy); break;
      case 'size': { const [, , width, height] = SIZES.find(s => s[0] === el.dataset.size); api.saveDraw({params: {width, height}}); render(); break; }
      case 'dice': seed = Math.floor(Math.random() * 4294967295); render(); break;
      case 'thumb': current = index; render(); break;
      case 'cancel-job': api.cancelDraw(el.dataset.key); break;
      case 'mode': api.saveDraw({mode: el.dataset.mode}); render(); break;
      case 'cloud-kind': api.saveDraw({queue: {cloud: {...cloudFields(), kind: el.dataset.kind}}}); cloudNote = null; render(); break;
      case 'plan-latest': await v.busy(el, () => api.planLatestPictures()); break;
      case 'new-room': { const room = api.newRoomCode(); v.root.querySelector('[data-cloud=room]').value = room; api.saveDraw({queue: {cloud: cloudFields()}}); cloudNote = {ok: true, text: '已生成房间码。把队列地址和房间码发给共用账号的朋友。'}; render(); break; }
      case 'test-cloud': {
        api.saveDraw({queue: {cloud: cloudFields()}});
        cloudNote = {ok: true, text: '正在连接……'}; render();
        const r = await api.testCloudQueue(cloudFields());
        cloudNote = r.ok ? {ok: true, text: `连接正常。队里现在 ${r.length} 张${r.holder ? `，${r.holder} 正在画` : ''}。`} : {ok: false, text: r.message};
        render();
        break;
      }
      case 'cancel-all': if (await ctx.confirm('取消所有排队的图？', '正在画的那一张也会停下。')) api.cancelAllDraws(); break;
      case 'go-settings': ctx.open('settings'); break;
      case 'go-key': ctx.open('engines'); ctx.editEngine?.(eng()); break;
      case 'open-presets': ctx.open('presets'); ctx.showPresetKind?.('draw'); break;
      case 'position': characters[index].position = Number(el.dataset.position); render(); break;
      case 'remove-char': characters.splice(index, 1); render(); break;
      case 'add-custom': characters.push({name: '角色', prompt: '', position: -1}); render(); break;
      case 'add-char': pickCharacter(); break;
      case 'zoom': { const img = el.querySelector('img'), shown = results[current]; if (img) openImageViewer({doc: ctx.doc, src: img.src, alt: '生成的图片', from: img, actions: shown ? [downloadAction(ctx.doc, () => resultFile(shown), ctx.notify)] : []}); break; }
      case 'suggest':
        await v.busy(el, async () => {
          el.innerHTML = icon('spin') + '正在读剧情…';
          prompt = await api.suggestPrompt();
          render();
          ctx.notify('已根据最近的剧情写好提示词，可以再改');
        });
        break;
      case 'pick-style': pickStyle(); break;
      case 'save-style': {
        if (!styleDraft) { ctx.notify('画风没有改动'); break; }
        if (!styleDraft.name.trim()) { ctx.notify('请填写画风名字'); break; }
        api.saveStyle(styleDraft);
        styleDraft = null;
        render();
        ctx.notify('画风已保存');
        break;
      }
      case 'generate': await generate(); break;
    }
  });

  async function generate() {
    const s = styleDraft || style(), q = quote();
    let allowPaid = false;
    if (q.free === false && eng() === 'gpt') {
      const ask = api.paidPrompt();
      if (!await ctx.confirm(ask.title, ask.text)) return;
      allowPaid = true;
    } else if (q.free === false) {
      const vibeNote = q.vibeAnlas ? `其中 Vibe 约 ${q.vibeAnlas} Anlas（${[q.vibes.encode && `${q.vibes.encode} 个第一次用要编码`, q.vibes.extra && `超过 4 个多了 ${q.vibes.extra} 个`].filter(Boolean).join('，')}）。` : '';
      if (!await ctx.confirm('这张图会扣 Anlas', `按当前参数和订阅，这次生成要消耗 Anlas${subscription ? `（现有 ${subscription.anlas}）` : ''}。${vibeNote}实际扣多少以 NovelAI 结算为准。`)) return;
      allowPaid = true;
    }
    busy = true;
    render();
    try {
      const result = await api.generateImage({
        prompt: [s.artist, s.positive, prompt].map(x => (x || '').trim()).filter(Boolean).join(', '),
        negative: [s.negative, negative].map(x => (x || '').trim()).filter(Boolean).join(', '),
        characters: characters.filter(c => c.prompt.trim()).map(c => ({prompt: c.prompt, position: c.position})),
        params: eng() === 'nai' ? {...state().params, seed} : {seed}, useComfyDraft: eng() === 'comfy', allowPaid, name: engineName().replace(/\s+/g, ''), label: '绘图 App · ' + (prompt.trim().slice(0, 24) || s.name)
      });
      results.unshift(result);
      results = results.slice(0, MAX_RESULTS);
      current = 0;
      newest = true;
      if (allowPaid && eng() === 'nai') refreshSubscription(true);
    } catch (error) { if (!error.cancelled) ctx.notify(error.message); }
    busy = false;
    render();
  }

  function pickCharacter() {
    const routes = api.getState().routes;
    const d = ctx.dialog('从角色里添加', routes.length
      ? `<div class="group">${routes.map(r => `<button class="list-row" data-pick="${esc(r.id)}">${avatar(r.name, r.voice ? r.engine : 'none', 36)}<span><strong>${esc(r.name)}</strong><small>${esc(r.appearance?.trim() || '还没有填写外貌 tag')}</small></span>${icon('add')}</button>`).join('')}</div>`
      : '<p class="hint">还没有角色。可以先在角色 App 里新增，并填写外貌 tag。</p>');
    d.body.addEventListener('click', e => {
      const b = e.target.closest('[data-pick]');
      if (!b) return;
      const r = routes.find(x => x.id === b.dataset.pick);
      characters.push({name: r.name, prompt: r.appearance || '', position: -1});
      d.close();
      render();
    });
  }

  function pickStyle() {
    const d0 = state(), using = styleId();
    const d = ctx.dialog('画风预设', `<div class="group">${d0.styles.map(s => `<button class="list-row" data-style="${esc(s.id)}"><span><strong>${esc(s.name)}</strong><small class="mono">${esc(s.artist || '没有画师串')}</small></span>${s.id === using ? plate('使用中') : icon('next')}</button>`).join('')}</div>
      <div class="actions">${btn('new-style', icon('add') + '新建画风', 'secondary')}${d0.styles.length > 1 ? btn('delete-style', icon('trash') + '删除当前', 'danger') : ''}</div>`);
    d.body.addEventListener('click', async e => {
      const b = e.target.closest('button');
      if (!b) return;
      try {
        if (b.dataset.style) { api.saveDraw({activeStyle: b.dataset.style}); styleDraft = null; d.close(); render(); }
        if (b.dataset.action === 'new-style') {
          const created = api.saveStyle({name: '新画风 ' + (d0.styles.length + 1), artist: '', positive: style().positive, negative: style().negative});
          api.saveDraw({activeStyle: created.id});
          styleDraft = null; d.close(); render();
          ctx.notify('已新建画风，在下面改名字、填写画师串');
        }
        if (b.dataset.action === 'delete-style') {
          d.close();
          if (await ctx.confirm('删除当前画风？', `「${style().name}」会被删除，其他画风保留。`)) { api.deleteStyle(style().id); styleDraft = null; render(); }
        }
      } catch (error) { ctx.notify(error.message); }
    });
  }


  render();
  refreshSubscription();
  return v;
}
