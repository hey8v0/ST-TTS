// Drawing settings, the LLM-facing drawing preset, and <img>…</img> picture blocks in chat text.
//
// Two kinds of preset live here:
//   styles  - "画风预设" edited in the drawing app: artist tags, fixed positive and fixed negative tags for NovelAI.
//   presets - "绘图预设" edited in the preset app: the rules the model follows when it plans pictures.
//
// A picture block is a plain paired tag (other plugins can exclude <img></img>) holding one line per field:
//   画幅 portrait/landscape/square · 场景 base tags · 角色 name｜tags｜negative tags｜position (one per person)
//   描述 (a base sentence) is no longer asked for but still read. Blocks written before 0.6 have
//   角色 name｜tags｜sentence; both forms are read.
//   新外貌 name｜fixed appearance (first appearance of a named character; the plugin saves it to the 角色 App)
//   位置 Pn (only when pictures are planned after the reply: which paragraph the picture follows)
// Two ways to get blocks (draw.mode): 'separate' asks the model in its own request after the reply is written and
// inserts the blocks; 'inline' injects the rules into the story request so the reply carries the blocks itself.
import {defaultDrawParams, normalizeDrawParams, guardParams, relayUrl} from './novelai.js';
import {strength as vibeStrength} from './vibes.js';
import {DRAW_ENGINES, defaultGpt, normalizeGpt, defaultComfy, normalizeComfy} from './image-engines.js';
import {escapeHTML, isPlaceholderRole} from './protocol.js';

const BLOCK = ['<img>', '画幅：竖 / 横 / 方', '场景：英文 tag', '角色：名字｜这一刻的 tag｜不要出现的 tag｜站位（画面里每个人一行）', '新外貌：名字｜固定外貌 tag（只在名单外的新角色第一次出现时写）', '</img>'];
export const PIC_TAG_FORMAT = BLOCK.join('\n');
export const PLAN_TAG_FORMAT = [BLOCK[0], '位置：P几（这张图放在哪一段后面）', ...BLOCK.slice(1)].join('\n');
export const DRAW_COUNT_MAX = 10;

// Default drawing rules. Written for this plugin; each entry can be edited or switched off in the preset app.
// engines: the drawing engines an entry is sent with (none = every engine). The shared entries say what to draw; the
// engine entries say how to write it: NovelAI and ComfyUI read danbooru tags, GPT reads English phrases too.
export const DEFAULT_DRAW_ENTRIES = Object.freeze([
  {id: 'pick', title: '挑画面', text: [
    "从正文里挑出 {{出图数量}} 个最值得画的瞬间：换场景、关键动作、角色登场、情绪到顶点、两个人之间有明显互动的时刻。几张图挑不同的瞬间，不要把同一个画面画两遍。",
    "每个瞬间写成一个出图块：",
    "{{出图格式}}",
    "只有「名字」那一段保持剧情里的原文写法，其余都用英文。不要写画师、质量词和通用负面词，插件会自己加。"
  ].join('\n')},
  {id: 'lang', title: '用 tag 写', engines: ['nai', 'comfy'], text: "一律用英文 danbooru tag，逗号分隔，越具体越好——画图模型认得的是 tag，不认得句子，也不认得剧情里的人名。不写英文句子。"},
  {id: 'lang-gpt', title: 'GPT：tag 和短语', engines: ['gpt'], text: [
    "这次用 GPT 画图，它读得懂英文：场景和角色行用英文写，逗号分隔，danbooru tag 和简短的英文短语都可以，比如 sitting on the edge of the bed、rain streaking down the window、holding a letter with trembling hands。动作和人物关系用短语说得更清楚，但每一项都要短，不写成长段落。",
    "GPT 不画露骨内容：正文里露骨的场景，挑一个不露骨的瞬间来画（拥抱、亲吻、事后依偎的氛围），衣着和身体写到不露骨为止，分级一律写 sfw。不写真实存在的名人。"
  ].join('\n')},
  {id: 'scene', title: '场景与镜头', text: [
    "「场景」写整张图共用的东西，按这个顺序：",
    "1. 分级：正文没有露骨内容写 sfw，有就写 nsfw。",
    "2. 人数，逗号分开：1girl, 1boy 或 2girls 这类，只数镜头里看得见的人；只有一个人时再加 solo。两个人是恋爱或亲密关系时加关系 tag：一男一女 hetero，两个女生 yuri，两个男生 yaoi，没有这层关系就不加。",
    "3. 时代和类型：一两个，如 modern、school、victorian、fantasy、sci-fi、chinese clothes。",
    "4. 地点具体到房间或街景，再写看得见的家具和道具：不写 room、outside，写 ornate study、classroom、cafe interior、rainy street；再加 mahogany desk、velvet armchair、fireplace、bookshelf、tea set 这样的东西。角色手里拿着、正在用、正被打翻的东西一定要写。",
    "5. 状态和氛围：东西此刻的状态（wet fabric、spilled tea、scattered papers、steam），再挑一个整体氛围（intimate atmosphere、tense atmosphere、romantic、gloomy、peaceful）。",
    "6. 镜头：景别一个（close-up、portrait、upper body、cowboy shot、full body、wide shot），视角一个（front view、from side、from behind、from above、from below、eye level、dutch angle、dynamic angle），需要时加 depth of field。关键动作必须在镜头里：腿、脚、坐姿、躺着这些下半身的事，不要选 close-up 或 upper body。",
    "7. 光线和色调：正文一般不写，由你补全，如 soft sunlight、golden hour、moonlight、candlelight、fireplace backlight、dramatic lighting、rim light；warm colors、cold colors、muted colors、high contrast。",
    "某一个人的长相、衣服、表情和单独的动作不放场景里。"
  ].join('\n')},
  {id: 'cast', title: '角色', text: [
    "画面里每个看得见、能单独认出来的人写一行「角色」，按从左到右排，四段用｜隔开：名字｜这一刻的 tag｜不要出现的 tag｜站位。",
    "名字：已登记的角色必须和名单一字不差。名单和固定外貌：{{角色列表}}。插件会把固定外貌补在最前面，你不用再写发色瞳色，只写这一张图里会变的东西。",
    "这一刻的 tag 按这个顺序写：girl、boy 或 other（child、teenage 这类年龄 tag 也放这里；数字人数只放在场景里）→ 衣服和它此刻的状态（wet shirt、disheveled vest、loose necktie）→ 姿势（standing up、sitting in armchair、leaning forward、leaning back、kneeling）→ 动作 → 表情 → 视线。",
    "动作写到身体部位和对象：arms around another's neck、legs wrapped around another's waist、head on another's chest、hand slamming desk、holding teacup。tag 里不写任何人的名字——画图模型不认识剧情里的名字——别人一律写 another，必要时写 boy、girl；也不写比喻（像章鱼、像考拉），直接写身体在做什么。",
    "每个人都要有表情和视线，用真实存在的 tag，情绪叠两三个写足，比如 angry, furrowed brow, open mouth，或者 flustered, heavy blush, wide-eyed。表情如 smile、grin、laughing、blush、heavy blush、embarrassed、flustered、pout、frown、furrowed brow、surprised、wide-eyed、crying、tears、angry、shouting、glaring、serious、sad、worried、scared、smug、expressionless、half-closed eyes、open mouth；视线如 looking at viewer、looking at another、looking away、looking down、looking up、looking back、closed eyes。正文没写表情就推断一个。",
    "镜头之外的身体部位不写：选了 upper body 或 close-up，就别再写鞋、袜、裙长和腿，否则模型会硬把它们画进来。",
    "正文里没有名字、但作为一个具体的人出现的（店员、对手、抱着孩子的路人），也给他一行，名字就用正文对他的称呼，外貌在这一张图里写全；不要替他编名字，也不要登记。成群的人（人群、士兵、围观的学生）不单独写角色，画面需要时在场景里写成一群人。"
  ].join('\n')},
  {id: 'cast-nai', title: 'NovelAI：加重、反向、站位、互动', engines: ['nai'], text: [
    "加重：这张图最要紧的一两个 tag 写成 1.2::tag::（数字 1.1 到 1.4，一张图最多三处），只加在一个短 tag 上，比如 1.3::heavy blush::，不要加在一整句或一串词上。",
    "不要出现的 tag：写这个人最容易被画错的方向，三到六个——和这一刻相反的表情（在发火就写 smile, calm），错的性别或年龄（男孩写 female，女孩写 male，孩子写 adult），多人同框时写 fused bodies, background characters。",
    "站位：A 到 E 是从左到右，1 到 5 是从上到下，C3 是正中间。一个人写 C3；两个人并排常用 B3 和 D3，抱在一起、叠在一起的都写 C3；拿不准就留空。",
    "互动：两个人之间每个有方向的动作都用 source#、target#、mutual# 标出来，双方都写、用同一个词——抱的人 source#hug，被抱的人 target#hug，互相的就都写 mutual#hug。一个人可以同时有几个，比如 target#hug, source#pushing away。露骨场景写清画面里真正露出的部位和动作，不要用 nsfw 这类笼统的词代替；被遮住或出画的部位不写。"
  ].join('\n')},
  {id: 'cast-comfy', title: 'ComfyUI：加重、反向、互动', engines: ['comfy'], text: [
    "这次用 ComfyUI（SDXL 一类的模型）画：它不分人画，所有人的 tag 会合成一条提示词。",
    "加重：最要紧的一两个 tag 写成 1.2::tag::（数字 1.1 到 1.4，一张图最多三处），插件会换成 ComfyUI 的写法。",
    "不要出现的 tag：两三个就够，写最容易画错的（错的性别、和这一刻相反的表情）；多人同框时写 extra arms, fused bodies。它们会合进整张图的负面。",
    "站位留空，模型不按站位画；需要时在场景里写 side by side、facing each other、back-to-back 这样的构图 tag。",
    "互动不用 source#、target#、mutual#（只有 NovelAI 认），直接写动作 tag：hug、hugging from behind、holding hands、kiss、carrying、headpat，写在做这个动作的人那一行。",
    "多人同框时外貌容易混：人越少越稳；两个人以上时，把最能区分彼此的特征（发色、衣服颜色）写清楚。露骨场景写清画面里真正露出的部位和动作，不要用 nsfw 这类笼统的词代替。"
  ].join('\n')},
  {id: 'cast-gpt', title: 'GPT：位置和互动', engines: ['gpt'], text: [
    "这次用 GPT 画：不用加重写法（1.2::tag::、括号），「不要出现的 tag」那一段留空。",
    "站位照写：A 到 E 是从左到右，1 到 5 是从上到下，C3 是正中间；插件会把它说成 on the left、in the center 这样的位置。",
    "互动用英文短语写清谁对谁做：hugging the boy from behind、holding the girl's hand、leaning on her shoulder；不用 source#、target#、mutual#。别人写 the girl、the boy、the other person，不写名字。",
    "每个人写清最能区分彼此的特征（发色、衣服），GPT 才不会把两个人画混。"
  ].join('\n')},
  {id: 'tension', title: '张力', text: [
    "画面要有张力：",
    "- 挑动作最满的那一刻，不挑动作之前、之后的平静瞬间：拍桌站起的那一下，而不是站着说话。",
    "- 动作用最强的说法：hand slamming desk 而不是 hand on desk，spilling tea 而不是 teacup，clinging hug 而不是 hug。",
    "- 情绪往满里写，叠两三个：angry, shouting, furrowed brow, glaring。",
    "- 情绪激烈时镜头跟上：dynamic angle、dutch angle、from below、close-up，光用 dramatic lighting、backlighting、high contrast；安静、温柔的画面用 soft lighting、eye level、depth of field。",
    "- 正在发生的物理效果要写：spilling、splashing、flying papers、hair flowing、motion lines。",
    "张力只来自正文里真的发生的事，不为了好看加剧情。"
  ].join('\n')},
  {id: 'truth', title: '忠于正文', text: [
    '怎么拍可以由你补全，画面里有什么必须来自正文和设定：',
    '- 在场的人、动作、事件、关键道具严格照正文，不加人、不加剧情。没入镜的人不写。',
    '- 角色固定的长相照名单和设定，不自己发明。',
    '- 先定下时代和世界观再具体化：优先看世界书和角色设定，其次看称呼、身份、物件；选一个统一的风格，衣服、建筑、器物前后一致，不混搭互相冲突的年代。',
    '- 地面、天气、环境也是事实：正文没说下雨就不写 rain、puddles、wet，没说泥路就不写 muddy，只知道在户外就写 outdoors。'
  ].join('\n')},
  {id: 'identity', title: '作品角色与新角色', text: [
    '明确来自已有动画、游戏、小说的角色，tag 第一个写模型认得的英文识别 tag，格式「角色名 (作品名)」，比如 hatsune miku (vocaloid)；括号不转义，作品名不缩写。拿不准是哪部作品就当原创角色，不写。',
    '名单里没有、但有名字的新角色第一次入画时，在这个出图块里加一行「新外貌」：名字｜固定外貌 tag。只写不会随场景变的特征：1girl 或 1boy、发型发色、瞳色、体型、显眼的特征，作品角色把识别 tag 放最前；不写衣服、表情、动作。名字照正文原文，中文名不要翻译或改成拼音。'
  ].join('\n')},
  {id: 'size', title: '画幅', text: '「画幅」写 竖、横、方 之一：单人、站姿、特写、贴得很近的两个人用竖；多人铺开、远景、全景用横。先想好镜头再定画幅，拿不准用竖。'}
]);
// Rules shipped from 0.6.1 to 0.6.48 (before GPT and ComfyUI). Untouched copies get the current text.
export const V07_DRAW_ENTRIES = Object.freeze([
  {id: 'pick', title: '挑画面', text: [
    "从正文里挑出 {{出图数量}} 个最值得画的瞬间：换场景、关键动作、角色登场、情绪到顶点、两个人之间有明显互动的时刻。几张图挑不同的瞬间，不要把同一个画面画两遍。",
    "每个瞬间写成一个出图块：",
    "{{出图格式}}",
    "一律用英文 danbooru tag，逗号分隔，越具体越好——画图模型认得的是 tag，不认得句子，也不认得剧情里的人名。只有「名字」那一段保持剧情里的原文写法。不要写画师、质量词和通用负面词，插件会自己加。"
  ].join('\n')},
  {id: 'scene', title: '场景与镜头', text: [
    "「场景」写整张图共用的东西，按这个顺序：",
    "1. 分级：正文没有露骨内容写 sfw，有就写 nsfw。",
    "2. 人数，逗号分开：1girl, 1boy 或 2girls 这类，只数镜头里看得见的人；只有一个人时再加 solo。两个人是恋爱或亲密关系时加关系 tag：一男一女 hetero，两个女生 yuri，两个男生 yaoi，没有这层关系就不加。",
    "3. 时代和类型：一两个，如 modern、school、victorian、fantasy、sci-fi、chinese clothes。",
    "4. 地点具体到房间或街景，再写看得见的家具和道具：不写 room、outside，写 ornate study、classroom、cafe interior、rainy street；再加 mahogany desk、velvet armchair、fireplace、bookshelf、tea set 这样的东西。角色手里拿着、正在用、正被打翻的东西一定要写。",
    "5. 状态和氛围：东西此刻的状态（wet fabric、spilled tea、scattered papers、steam），再挑一个整体氛围（intimate atmosphere、tense atmosphere、romantic、gloomy、peaceful）。",
    "6. 镜头：景别一个（close-up、portrait、upper body、cowboy shot、full body、wide shot），视角一个（front view、from side、from behind、from above、from below、eye level、dutch angle、dynamic angle），需要时加 depth of field。关键动作必须在镜头里：腿、脚、坐姿、躺着这些下半身的事，不要选 close-up 或 upper body。",
    "7. 光线和色调：正文一般不写，由你补全，如 soft sunlight、golden hour、moonlight、candlelight、fireplace backlight、dramatic lighting、rim light；warm colors、cold colors、muted colors、high contrast。",
    "某一个人的长相、衣服、表情和单独的动作不放场景里。不写英文句子。"
  ].join('\n')},
  {id: 'cast', title: '角色', text: [
    "画面里每个看得见、能单独认出来的人写一行「角色」，按从左到右排，四段用｜隔开：名字｜这一刻的 tag｜不要出现的 tag｜站位。",
    "名字：已登记的角色必须和名单一字不差。名单和固定外貌：{{角色列表}}。插件会把固定外貌补在最前面，你不用再写发色瞳色，只写这一张图里会变的东西。",
    "这一刻的 tag 按这个顺序写：girl、boy 或 other（child、teenage 这类年龄 tag 也放这里；数字人数只放在场景里）→ 衣服和它此刻的状态（wet shirt、disheveled vest、loose necktie）→ 姿势（standing up、sitting in armchair、leaning forward、leaning back、kneeling）→ 动作 → 表情 → 视线。",
    "动作写到身体部位和对象：arms around another's neck、legs wrapped around another's waist、head on another's chest、hand slamming desk、holding teacup。tag 里不写任何人的名字——画图模型不认识剧情里的名字——别人一律写 another，必要时写 boy、girl；也不写比喻（像章鱼、像考拉），直接写身体在做什么。",
    "每个人都要有表情和视线，用真实存在的 tag，情绪叠两三个写足，比如 angry, furrowed brow, open mouth，或者 flustered, heavy blush, wide-eyed。表情如 smile、grin、laughing、blush、heavy blush、embarrassed、flustered、pout、frown、furrowed brow、surprised、wide-eyed、crying、tears、angry、shouting、glaring、serious、sad、worried、scared、smug、expressionless、half-closed eyes、open mouth；视线如 looking at viewer、looking at another、looking away、looking down、looking up、looking back、closed eyes。正文没写表情就推断一个。",
    "加重：这张图最要紧的一两个 tag 写成 1.2::tag::（数字 1.1 到 1.4，一张图最多三处），只加在一个短 tag 上，比如 1.3::heavy blush::，不要加在一整句或一串词上。",
    "不要出现的 tag：写这个人最容易被画错的方向，三到六个——和这一刻相反的表情（在发火就写 smile, calm），错的性别或年龄（男孩写 female，女孩写 male，孩子写 adult），多人同框时写 fused bodies, background characters。",
    "站位：A 到 E 是从左到右，1 到 5 是从上到下，C3 是正中间。一个人写 C3；两个人并排常用 B3 和 D3，抱在一起、叠在一起的都写 C3；拿不准就留空。",
    "镜头之外的身体部位不写：选了 upper body 或 close-up，就别再写鞋、袜、裙长和腿，否则模型会硬把它们画进来。",
    "互动：两个人之间每个有方向的动作都用 source#、target#、mutual# 标出来，双方都写、用同一个词——抱的人 source#hug，被抱的人 target#hug，互相的就都写 mutual#hug。一个人可以同时有几个，比如 target#hug, source#pushing away。露骨场景写清画面里真正露出的部位和动作，不要用 nsfw 这类笼统的词代替；被遮住或出画的部位不写。",
    "正文里没有名字、但作为一个具体的人出现的（店员、对手、抱着孩子的路人），也给他一行，名字就用正文对他的称呼，外貌在这一张图里写全；不要替他编名字，也不要登记。成群的人（人群、士兵、围观的学生）不单独写角色，画面需要时在场景里写成一群人。"
  ].join('\n')},
  {id: 'tension', title: '张力', text: [
    "画面要有张力：",
    "- 挑动作最满的那一刻，不挑动作之前、之后的平静瞬间：拍桌站起的那一下，而不是站着说话。",
    "- 动作用最强的说法：hand slamming desk 而不是 hand on desk，spilling tea 而不是 teacup，clinging hug 而不是 hug。",
    "- 情绪往满里写，给最关键的一个加重：1.2::angry shouting::, furrowed brow, glaring。",
    "- 情绪激烈时镜头跟上：dynamic angle、dutch angle、from below、close-up，光用 dramatic lighting、backlighting、high contrast；安静、温柔的画面用 soft lighting、eye level、depth of field。",
    "- 正在发生的物理效果要写：spilling、splashing、flying papers、hair flowing、motion lines。",
    "张力只来自正文里真的发生的事，不为了好看加剧情。"
  ].join('\n')},
  {id: 'truth', title: '忠于正文', text: [
    '怎么拍可以由你补全，画面里有什么必须来自正文和设定：',
    '- 在场的人、动作、事件、关键道具严格照正文，不加人、不加剧情。没入镜的人不写。',
    '- 角色固定的长相照名单和设定，不自己发明。',
    '- 先定下时代和世界观再具体化：优先看世界书和角色设定，其次看称呼、身份、物件；选一个统一的风格，衣服、建筑、器物前后一致，不混搭互相冲突的年代。',
    '- 地面、天气、环境也是事实：正文没说下雨就不写 rain、puddles、wet，没说泥路就不写 muddy，只知道在户外就写 outdoors。'
  ].join('\n')},
  {id: 'identity', title: '作品角色与新角色', text: [
    '明确来自已有动画、游戏、小说的角色，tag 第一个写模型认得的英文识别 tag，格式「角色名 (作品名)」，比如 hatsune miku (vocaloid)；括号不转义，作品名不缩写。拿不准是哪部作品就当原创角色，不写。',
    '名单里没有、但有名字的新角色第一次入画时，在这个出图块里加一行「新外貌」：名字｜固定外貌 tag。只写不会随场景变的特征：1girl 或 1boy、发型发色、瞳色、体型、显眼的特征，作品角色把识别 tag 放最前；不写衣服、表情、动作。名字照正文原文，中文名不要翻译或改成拼音。'
  ].join('\n')},
  {id: 'size', title: '画幅', text: '「画幅」写 竖、横、方 之一：单人、站姿、特写、贴得很近的两个人用竖；多人铺开、远景、全景用横。先想好镜头再定画幅，拿不准用竖。'}
]);
// Rules shipped in 0.6.0 (pick, scene, cast). An entry that still holds one of these word for word gets the current text.
export const V06_DRAW_ENTRIES = [
  {id: 'pick', title: '挑画面', text: [
    '从正文里挑出 {{出图数量}} 个最值得画的瞬间：换场景、关键动作、角色登场、情绪到顶点、两个人之间有明显互动的时刻。几张图挑不同的瞬间，不要把同一个画面画两遍。',
    '每个瞬间写成一个出图块：',
    '{{出图格式}}',
    '一律用英文 danbooru tag，逗号分隔，越具体越好——画图模型认得的是 tag，不是句子。只有角色名保持剧情里的原文写法。不要写画师、质量词和通用负面词，插件会自己加。'
  ].join('\n')},
  {id: 'scene', title: '场景与镜头', text: [
    '「场景」写整张图共用的东西，按这个顺序：',
    '1. 分级：正文没有露骨内容写 sfw，有就写 nsfw。',
    '2. 人数：只数镜头里看得见的人，写 1girl、1boy、2girls、1girl 1boy 这类；只有一个人时再加 solo。',
    '3. 时代和类型：一两个就够，如 modern、school、victorian、fantasy、sci-fi、chinese clothes。',
    '4. 地点具体到房间或街景，再写镜头里看得见的家具和道具：不写 room、outside，写 ornate study、classroom、cafe interior、rainy street；再加 armchair、fireplace、bookshelf、window、teacup on saucer 这样的东西。角色手里拿着、正在用的东西一定要写进来。',
    '5. 动态和特效：正文里有才写，如 splashing tea、falling petals、steam、wind、sparks、motion lines。',
    '6. 镜头：景别只选一个（close-up、portrait、upper body、cowboy shot、full body、wide shot），可以再加一个角度（from above、from below、from side、dutch angle、pov）和 depth of field。关键动作必须在镜头里：腿、脚、坐姿、躺着这些下半身的事，不要选 close-up 或 upper body。',
    '7. 光线和色调：正文一般不写，由你补全，如 soft sunlight、golden hour、moonlight、candlelight、fireplace light、backlighting；warm colors、cold colors、muted colors、high contrast。',
    '某一个人的长相、衣服、表情和单独的动作不放场景里。',
    '「描述」可以不写；要写就一句短英文，讲清几个人的相对位置和正在发生的事。'
  ].join('\n')},
  {id: 'cast', title: '角色', text: [
    '画面里每个看得见、能单独认出来的人写一行「角色」，按从左到右排，四段用｜隔开：名字｜这一刻的 tag｜不要出现的 tag｜站位。',
    '名字：已登记的角色必须和名单一字不差。名单和固定外貌：{{角色列表}}。插件会把固定外貌补在最前面，你不用再写发色瞳色，只写这一张图里会变的东西。',
    '这一刻的 tag 按这个顺序写：girl、boy 或 other（数字人数只放在场景里）→ 衣服和配饰 → 姿势（standing、sitting、kneeling、lying、leaning forward）→ 动作，连同动作的对象一起写（holding teacup、reaching towards another、hand on own chest）→ 表情 → 视线。',
    '每个人都要有表情和视线，用真实存在的 tag，情绪可以叠两三个写足，比如 angry, surprised, open mouth, blush。表情如 smile、grin、laughing、blush、embarrassed、pout、frown、surprised、crying、tears、angry、glaring、serious、sad、worried、scared、smug、expressionless、half-closed eyes、open mouth；视线从 looking at viewer、looking at another、looking away、looking down、looking up、looking back、closed eyes 里挑一个。正文没写表情就推断一个，不要自造“温柔的笑”这类短语。',
    '加重：这张图最要紧的一两个 tag（通常是情绪，或者一定要画对的特征）写成 1.2::tag::，比如 1.2::furious::、1.2::deep blue eyes::。数字在 1.1 到 1.4 之间，一张图最多三处，不要给整串加。',
    '不要出现的 tag：写这个人最容易被画错的方向，三到六个——和这一刻相反的表情（在发火就写 smile, calm），错的性别或年龄（男孩写 female，女孩写 male），多人同框时写 fused bodies, extra arms。没有就留空。',
    '站位：A 到 E 是从左到右，1 到 5 是从上到下，C3 是正中间。一个人写 C3；两个人并排常用 B3 和 D3；照画面里的左右和高低来写，拿不准就留空。',
    '镜头之外的身体部位不写：选了 upper body 或 close-up，就别再写鞋、袜、裙长和腿，否则模型会硬把它们画进来。',
    '两个人以上、动作有明确方向时，用 source#、target#、mutual# 标出谁对谁做，比如一人写 source#hug，另一人写 target#hug。露骨场景写清画面里真正露出的部位和动作，不要用 nsfw 这类笼统的词代替；被遮住或出画的部位不写。',
    '正文里没有名字、但作为一个具体的人出现的（店员、对手、抱着孩子的路人），也给他一行，名字就用正文对他的称呼，外貌在这一张图里写全；不要替他编名字，也不要登记。成群的人（人群、士兵、围观的学生）不单独写角色，画面需要时在场景里写成一群人。'
  ].join('\n')}
];

// Rules shipped in 0.5. An entry that still holds its 0.5 text word for word gets the current text.
export const V05_DRAW_ENTRIES = [
  {id: 'pick', title: '挑画面', text: [
    '从正文里挑出 {{出图数量}} 个最值得画的瞬间：换场景、关键动作、角色登场、情绪到顶点、两个人之间有明显互动的时刻。几张图挑不同的瞬间，不要把同一个画面画两遍。',
    '每个瞬间写成一个出图块：',
    '{{出图格式}}',
    '所有 tag 用英文 danbooru tag，逗号分隔；描述用英文句子，模型对英文理解最稳。只有角色名保持剧情里的原文写法。不要写画师、质量词和通用负面词，插件会自己加。'
  ].join('\n')},
  {id: 'scene', title: '场景与镜头', text: [
    '「场景」写整张图共用的东西：画面里看得见的人数（1girl、2girls、1boy、1girl 1boy……只数镜头里的人，不数在场的人）、地点、时间和天气、镜头、光线、色调，以及几个人共同在做的事。某一个人的长相、衣服、单独的动作不放这里。',
    '镜头只写一个：close-up、upper body、cowboy shot、full body、wide shot 里选一。这张图的关键动作必须在镜头里：腿、脚、坐姿、躺着这些下半身的事，不要选 close-up 或 upper body。',
    '正文不会写怎么拍，这部分由你补全：光线如 soft sunlight、golden hour、moonlight、candlelight、backlighting、indoor lighting，色调如 warm colors、cold colors、muted colors、high contrast。',
    '「描述」用一两句英文讲清整个画面：谁在哪里、彼此的位置、从哪个角度看过去、正在发生什么。同样不写某个人的长相。'
  ].join('\n')},
  {id: 'cast', title: '角色', text: [
    '画面里每个看得见、能单独认出来的人写一行「角色」，按从左到右、从上到下排，三段用｜隔开：名字｜tag｜描述。',
    '名字：已登记的角色必须和名单一字不差。名单和固定外貌：{{角色列表}}。插件会把固定外貌自动补进去，你不用再写发色瞳色，只写这一张图里会变的东西。',
    'tag：先写 girl、boy 或 other（数字人数只放在场景里），再写这一刻的衣服、表情、视线、姿势、动作，必要时写左右位置。每个人都必须有表情和视线，而且要用真实存在的 tag。表情如 smile、grin、laughing、blush、embarrassed、pout、frown、surprised、crying、tears、angry、serious、sad、worried、scared、smug、expressionless、half-closed eyes、open mouth；视线从 looking at viewer、looking at another、looking away、looking down、looking up、looking back、closed eyes 里挑一个。正文没写表情就推断一个，实在推断不出写 expressionless，不要自造“温柔的笑”这类短语。',
    '镜头之外的身体部位不写：选了 upper body 或 close-up，就别再写鞋、袜、裙长和腿，否则模型会硬把它们画进来。',
    '两个人以上、动作有明确方向时，用 source#、target#、mutual# 标出谁对谁做，比如一人写 source#hug，另一人写 target#hug。露骨场景写清画面里真正露出的部位和动作，不要用 nsfw 这类笼统的词代替；被遮住或出画的部位不写。',
    '描述：一句英文，讲这个人此刻的样子、朝向、动作和大概位置，不能和 tag 矛盾。',
    '正文里没有名字、但作为一个具体的人出现的（店员、对手、抱着孩子的路人），也给他一行，名字就用正文对他的称呼，外貌在这一张图里写全；不要替他编名字，也不要登记。成群的人（人群、士兵、围观的学生）不单独写角色，画面需要时在场景里写成一群人。'
  ].join('\n')},
  {id: 'truth', title: '忠于正文', text: [
    '怎么拍可以由你补全，画面里有什么必须来自正文和设定：',
    '- 在场的人、动作、事件、关键道具严格照正文，不加人、不加剧情。没入镜的人不写。',
    '- 角色固定的长相照名单和设定，不自己发明。',
    '- 先定下时代和世界观再具体化：优先看世界书和角色设定，其次看称呼、身份、物件；选一个统一的风格，衣服、建筑、器物前后一致，不混搭互相冲突的年代。',
    '- 地面、天气、环境也是事实：正文没说下雨就不写 rain、puddles、wet，没说泥路就不写 muddy，只知道在户外就写 outdoors。'
  ].join('\n')},
  {id: 'identity', title: '作品角色与新角色', text: [
    '明确来自已有动画、游戏、小说的角色，tag 第一个写模型认得的英文识别 tag，格式「角色名 (作品名)」，比如 hatsune miku (vocaloid)；括号不转义，作品名不缩写。拿不准是哪部作品就当原创角色，不写。',
    '名单里没有、但有名字的新角色第一次入画时，在这个出图块里加一行「新外貌」：名字｜固定外貌 tag。只写不会随场景变的特征：1girl 或 1boy、发型发色、瞳色、体型、显眼的特征，作品角色把识别 tag 放最前；不写衣服、表情、动作。名字照正文原文，中文名不要翻译或改成拼音。'
  ].join('\n')},
  {id: 'size', title: '画幅', text: '「画幅」写 竖、横、方 之一：单人、站姿、特写、贴得很近的两个人用竖；多人铺开、远景、全景用横。先想好镜头再定画幅，拿不准用竖。'}
];

export const DEFAULT_DRAW_RULE = DEFAULT_DRAW_ENTRIES.map(e => e.text).join('\n\n');

/** Appended to the rules in 'inline' mode: the reply itself carries exactly `count` blocks. */
export const drawContract = count => [
  '【出图硬性规则】',
  `这条回复必须正好写 ${count} 个出图块，不能多也不能少。每个出图块单独成段，放在它所画的那一段正文后面${count > 1 ? '，几个出图块分散在正文不同位置' : ''}。`,
  '出图块严格照这个格式写并闭合：',
  '{{出图格式}}',
  '已登记角色的名字只能从名单里选，一字不差。写完正文后自己数一遍出图块，不对就补上或删掉。不输出核对过程。'
].join('\n');
/** Appended to the rules in 'separate' mode: the reply is already written; answer with blocks only. */
export const planContract = count => [
  '【出图硬性规则】',
  `下面的正文已经写好，每一段前面标了 [P1]、[P2]…… 按上面的规则挑 ${count} 个画面，正好输出 ${count} 个出图块，每块第一行写「位置：P几」，表示这张图放在哪一段后面。`,
  '出图块严格照这个格式写并闭合：',
  '{{出图格式}}',
  '只输出出图块，不要复述正文，不要解释，不要放进代码块。已登记角色的名字只能从名单里选，一字不差。'
].join('\n');

// Rule texts shipped earlier. A preset that still holds one of them word for word gets the current default rules.
const OLD_DEFAULT_RULES = [
  ['画面有明显变化时（换了场景、重要动作、角色登场、情绪到了高点），在那一段正文后面单独写一个出图标签，格式：', '{{出图格式}}',
    'prompt 用英文 danbooru tag 描述这一刻的画面：人数（1girl、2girls、1boy 等）、动作、表情、服装、场景、光线、镜头构图，用英文逗号分隔。不要写画师名和质量词，也不要写角色固定的外貌特征，这些会自动补上。',
    'characters 写画面里出现的角色名，用逗号分隔，只写这些名字：{{角色列表}}。', '每条回复最多写一个出图标签。不要解释这个标签，也不要放进代码块。'],
  ['在这条回复里挑出 {{出图数量}} 个最有画面感的时刻（换了场景、重要动作、角色登场、情绪到了高点），在每个时刻那一段正文后面单独写一个出图标签，格式：', '{{出图格式}}',
    '竖线前用英文 danbooru tag 描述这一刻的画面：人数（1girl、2girls、1boy 等）、动作、表情、服装、场景、光线、镜头构图，用英文逗号分隔。不要写画师名和质量词，也不要写角色固定的外貌特征，这些会自动补上。',
    '竖线后写画面里出现的角色名，用逗号分隔，只写这些名字：{{角色列表}}。画面里没有这些角色时，连同竖线一起省略。', '不要解释这些标签，也不要放进代码块。']
].map(lines => lines.join('\n'));

const DEFAULT_STYLE = {id: 'default', name: '默认画风', artist: '', positive: 'masterpiece, best quality, very aesthetic, absurdres', negative: 'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digits, cropped, worst quality, jpeg artifacts, signature, watermark, blurry'};
// rev 2 (0.6.1): presets made earlier get the 张力 entry once, after 角色; deleting it afterwards sticks.
// rev 3 (0.6.49): the engine entries (用 tag 写, GPT, NovelAI / ComfyUI / GPT 的角色写法) are added once.
export const PRESET_REV = 3;
const DEFAULT_PRESET = {id: 'default', name: '默认出图规则', rev: PRESET_REV, count: 1, injection: {position: 'in_chat', depth: 1, role: 'system'}, entries: DEFAULT_DRAW_ENTRIES.map(e => ({...e, enabled: true}))};

/**
 * Vibe Transfer in the drawing app: on or off for every picture (whatever the 画风), what is in use (a group, or one
 * vibe), and the groups: [{id, name, items: [{vibe, strength}]}]. The vibes themselves live in the local library.
 */
export const defaultVibe = () => ({enabled: false, use: {kind: '', id: ''}, groups: []});
export function normalizeVibeSettings(value) {
  const v = value && typeof value === 'object' ? value : {};
  const groups = (Array.isArray(v.groups) ? v.groups : []).slice(0, 200).map(g => ({
    id: /^[\w-]{1,64}$/.test(String(g?.id || '')) ? String(g.id) : crypto.randomUUID(), name: text(g?.name, 40).trim() || 'Vibe 组',
    items: (Array.isArray(g?.items) ? g.items : []).filter(i => /^[0-9a-f]{64}$/.test(String(i?.vibe || ''))).filter((i, n, all) => all.findIndex(x => x.vibe === i.vibe) === n).slice(0, 50).map(i => ({vibe: i.vibe, strength: vibeStrength(i.strength)}))
  }));
  const kind = ['group', 'vibe'].includes(v.use?.kind) ? v.use.kind : '', id = typeof v.use?.id === 'string' ? v.use.id : '';
  const use = kind === 'group' && groups.some(g => g.id === id) || kind === 'vibe' && /^[0-9a-f]{64}$/.test(id) ? {kind, id} : {kind: '', id: ''};
  return {enabled: !!v.enabled, use, groups};
}
export function defaultDraw() {
  return {enabled: false, auto: true, guard: true, fold: false, mode: 'separate', strip: true, engine: 'nai', gpt: defaultGpt(), comfy: defaultComfy(),
    connections: {nai: normalizeImageConnections('nai'), gpt: normalizeImageConnections('gpt')},
    queue: {gap: 3, retries: 4, cloud: {enabled: false, kind: 'room', url: '', room: ''}}, relay: {url: '', assumeOpus: false}, vibe: defaultVibe(), params: defaultDrawParams(),
    styles: [structuredClone(DEFAULT_STYLE)], activeStyle: 'default', presets: [structuredClone(DEFAULT_PRESET)], activePreset: 'default'};
}

/** Connection presets contain no secrets. Legacy single connections become the default preset. */
export function normalizeImageConnections(engine, value, legacy = {}) {
  const rows = Array.isArray(value?.presets) && value.presets.length ? value.presets : [{...legacy, id: 'default', name: '默认连接'}];
  if (rows.length > 50) throw Error('每个生图引擎最多保存 50 组连接');
  const ids = new Set();
  const presets = rows.map(row => {
    const id = String(row?.id || '');
    if (!/^[\w-]{1,64}$/.test(id) || ids.has(id)) throw Error('生图连接编号无效或重复');
    ids.add(id);
    const name = String(row.name || '未命名连接').trim().slice(0, 60) || '未命名连接';
    if (engine === 'gpt') { const g = normalizeGpt(row); return {id, name, url: g.url, model: g.model}; }
    return {id, name, url: relayUrl(row.url, ''), assumeOpus: !!row.assumeOpus};
  });
  return {active: ids.has(value?.active) ? value.active : presets[0].id, presets};
}

/** Keep the existing drawing callers reading the selected connection's public fields. */
export function applyImageConnection(draw, engine) {
  const group = draw.connections[engine], p = group.presets.find(p => p.id === group.active);
  if (engine === 'nai') draw.relay = {url: p.url, assumeOpus: p.assumeOpus};
  else Object.assign(draw.gpt, {url: p.url, model: p.model});
}

const text = (value, max) => String(value ?? '').slice(0, max);
/** An entry's engines: kept only when it is some of them (all or none means every engine). */
const entryEngines = value => { const list = DRAW_ENGINES.filter(x => Array.isArray(value) && value.includes(x)); return list.length && list.length < DRAW_ENGINES.length ? {engines: list} : {}; };
/** Whether an entry is sent with this engine. */
export const forEngine = (entry, engine) => !entry.engines?.length || entry.engines.includes(engine);
export function normalizeDraw(value) {
  const base = defaultDraw();
  if (!value || typeof value !== 'object') return base;
  const d = {...base, ...structuredClone(value)};
  d.enabled = !!d.enabled;
  d.auto = d.auto !== false;
  d.guard = d.guard !== false;
  d.fold = !!d.fold;
  d.strip = d.strip !== false;
  d.mode = d.mode === 'inline' ? 'inline' : 'separate';
  d.engine = DRAW_ENGINES.includes(d.engine) ? d.engine : 'nai';
  d.gpt = normalizeGpt(d.gpt);
  d.comfy = normalizeComfy(d.comfy);
  const n = (v, min, max, fallback) => { const x = Math.round(Number(v)); return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : fallback; };
  const cloud = d.queue?.cloud || {};
  d.queue = {gap: n(d.queue?.gap, 0, 60, 3), retries: n(d.queue?.retries, 0, 10, 4),
    cloud: {enabled: !!cloud.enabled, kind: cloud.kind === 'keyhash' ? 'keyhash' : 'room', url: text(cloud.url, 300).trim().replace(/\/+$/, ''), room: text(cloud.room, 80).trim()}};
  const relay = d.relay && typeof d.relay === 'object' ? d.relay : {};
  d.relay = {url: (() => { try { return relayUrl(relay.url, ''); } catch { return ''; } })(), assumeOpus: !!relay.assumeOpus};
  d.connections = Object.fromEntries(['nai', 'gpt'].map(engine => [engine, normalizeImageConnections(engine, value.connections?.[engine], engine === 'nai' ? d.relay : d.gpt)]));
  for (const engine of ['nai', 'gpt']) {
    const group = d.connections[engine], p = group.presets.find(p => p.id === group.active);
    // Existing settings editors still write these fields; they belong to the selected preset.
    if (engine === 'nai' && value.relay) Object.assign(p, d.relay);
    if (engine === 'gpt' && value.gpt) Object.assign(p, {url: d.gpt.url, model: d.gpt.model});
    applyImageConnection(d, engine);
  }
  d.vibe = normalizeVibeSettings(d.vibe);
  d.params = normalizeDrawParams(d.params);
  d.styles = (Array.isArray(d.styles) && d.styles.length ? d.styles : base.styles).map(s => ({id: String(s.id || crypto.randomUUID()), name: text(s.name, 60) || '画风', artist: text(s.artist, 4000), positive: text(s.positive, 4000), negative: text(s.negative, 4000)}));
  d.activeStyle = d.styles.some(s => s.id === d.activeStyle) ? d.activeStyle : d.styles[0].id;
  for (const key of ['gpt', 'comfy']) if (!d.styles.some(s => s.id === d[key].style)) d[key].style = '';
  d.presets = (Array.isArray(d.presets) && d.presets.length ? d.presets : base.presets).map(p => {
    let entries = Array.isArray(p.entries) ? p.entries : [];
    // A preset that is just an old default rule gets the current default rules; untouched 0.5 entries get their new text.
    if (entries.length === 1 && OLD_DEFAULT_RULES.includes(entries[0].text)) entries = DEFAULT_PRESET.entries;
    entries = entries.map(e => {
      const now = DEFAULT_DRAW_ENTRIES.find(x => x.id === e.id);
      const old = [V05_DRAW_ENTRIES, V06_DRAW_ENTRIES, V07_DRAW_ENTRIES].some(list => list.find(x => x.id === e.id)?.text === e.text);
      return now && old ? {...e, text: now.text} : e;
    });
    if (!(Number(p.rev) >= 2) && entries.some(e => e.id === 'cast') && !entries.some(e => e.id === 'tension')) {
      const at = entries.findIndex(e => e.id === 'cast') + 1;
      entries = [...entries.slice(0, at), {...DEFAULT_DRAW_ENTRIES.find(e => e.id === 'tension'), enabled: true}, ...entries.slice(at)];
    }
    // The engine entries, once: after 挑画面 the ways of writing, after 角色 each engine's rules for people. The NovelAI
    // one only when 角色 holds the shipped text (an edited 角色 already has its own NovelAI rules).
    if (!(Number(p.rev) >= 3)) {
      const add = (after, ids) => {
        const missing = ids.filter(id => !entries.some(e => e.id === id)).map(id => ({...DEFAULT_DRAW_ENTRIES.find(e => e.id === id), enabled: true}));
        const at = entries.findIndex(e => e.id === after);
        entries = at < 0 ? [...entries, ...missing] : [...entries.slice(0, at + 1), ...missing, ...entries.slice(at + 1)];
      };
      const shipped = entries.find(e => e.id === 'cast')?.text === DEFAULT_DRAW_ENTRIES.find(e => e.id === 'cast').text;
      add('pick', ['lang', 'lang-gpt']);
      add('cast', [...(shipped ? ['cast-nai'] : []), 'cast-comfy', 'cast-gpt']);
    }
    return {
      id: String(p.id || crypto.randomUUID()), name: text(p.name, 60) || '出图规则', rev: PRESET_REV,
      count: Math.min(DRAW_COUNT_MAX, Math.max(1, Math.round(Number(p.count)) || 1)),
      injection: {...DEFAULT_PRESET.injection, ...p.injection},
      entries: entries.map(e => ({id: String(e.id || crypto.randomUUID()), title: text(e.title, 80), enabled: e.enabled !== false, text: text(e.text, 20000), ...entryEngines(e.engines), ...(e.injection ? {injection: {...DEFAULT_PRESET.injection, ...e.injection}} : {})}))
    };
  });
  d.activePreset = d.presets.some(p => p.id === d.activePreset) ? d.activePreset : d.presets[0].id;
  return d;
}

export function validateDrawPreset(p) {
  if (!p?.name?.trim()) throw Error('请填写绘图预设名称');
  for (const i of [p.injection, ...p.entries.map(e => e.injection).filter(Boolean)]) {
    if (!['in_chat', 'in_prompt', 'before_prompt'].includes(i.position) || !['system', 'user', 'assistant'].includes(i.role)) throw Error('插入位置或身份无效');
    if (!Number.isInteger(Number(i.depth)) || i.depth < 0 || i.depth > 10000) throw Error('插入深度需为 0–10000 的整数');
  }
  const body = p.entries.filter(e => e.enabled).map(e => e.text).join('\n');
  if (!body.trim()) throw Error('至少启用一条出图规则');
  return p;
}

/** The 画风 of the engine in use: each engine remembers its own (NovelAI artist tags mean nothing to GPT). GPT and
 *  ComfyUI start with NovelAI's until one is picked for them. */
export const styleIdFor = (draw, engine = draw.engine) => (engine === 'nai' ? '' : draw[engine]?.style) || draw.activeStyle;
export const activeStyle = draw => draw.styles.find(s => s.id === styleIdFor(draw)) || draw.styles[0];
const activePreset = (draw, preset) => preset || draw.presets.find(x => x.id === draw.activePreset) || draw.presets[0];
const countOf = p => Math.min(DRAW_COUNT_MAX, Math.max(1, Math.round(Number(p.count)) || 1));

/** 名单 for the rules: registered names with their fixed appearance. only: the story's speakers (story requests name
 *  nobody else, or the model takes them as the cast). */
export function castList(settings, only = null) {
  const wanted = Array.isArray(only) ? new Set(only.map(n => String(n).trim())) : null;
  const roles = settings.routes.filter(r => !isPlaceholderRole(r.name) && (!wanted || wanted.has(r.name)));
  if (!roles.length) return wanted ? '（这段剧情里还没有登记的角色）' : '（还没有登记的角色）';
  return roles.map(r => r.appearance?.trim() ? `${r.name}（${r.appearance.trim().slice(0, 160)}）` : `${r.name}（还没有外貌）`).join('；');
}
function ruleText(settings, p, format, contract, only = null) {
  const count = countOf(p), list = castList(settings, only);
  const fill = t => t.replaceAll('{{出图格式}}', format).replaceAll('{{角色列表}}', list).replaceAll('{{出图数量}}', String(count));
  const engine = settings.draw?.engine || 'nai', entries = p.entries.filter(e => e.enabled && e.text.trim() && forEngine(e, engine));
  return {entries, fill, tail: fill(contract(count))};
}

/** Prompt entries injected with the story request ('inline' mode only). Keys share the sttts.entry. prefix. */
export function drawPromptPlan(settings, preset, only = null) {
  const draw = settings.draw;
  if (!preset && (!draw?.enabled || draw.mode !== 'inline')) return [];
  const p = activePreset(draw, preset);
  if (!p) return [];
  const {entries, fill, tail} = ruleText(settings, p, PIC_TAG_FORMAT, drawContract, only);
  return entries.map((e, index) => {
    const i = e.injection || p.injection;
    return {
      key: 'sttts.entry.draw.' + String(index).padStart(4, '0'),
      text: fill(e.text) + (index === entries.length - 1 ? '\n\n' + tail : ''),
      position: {in_chat: 1, in_prompt: 0, before_prompt: 2}[i.position],
      depth: i.position === 'in_chat' ? Number(i.depth) : 0,
      role: i.position === 'in_chat' ? {system: 0, user: 1, assistant: 2}[i.role] : 0
    };
  });
}

// ---------- Planning pictures after the reply ('separate' mode) ----------
const TTS_BLOCK = /<tts\b[^>]*>[\s\S]*?<\/tts\s*>/gi;
const IMG_BLOCK = /<img\b[^<>]*>[^<]*<\/img\s*>|<img\b[^<>]*\/?>/gi;
const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'wbr', 'area', 'col', 'embed', 'track', 'tts']);
/**
 * Parts of a reply a picture must not be put inside: every tag that spans several lines (a status bar, <details>, a
 * preset's own blocks), code fences and HTML comments, as [start, end, name]. Tags left open are not counted.
 */
export function blockRanges(source) {
  const text = String(source), ranges = [], stack = [];
  for (const m of text.matchAll(/```[\s\S]*?(?:```|$)|<!--[\s\S]*?(?:-->|$)/g)) if (m[0].includes('\n')) ranges.push([m.index, m.index + m[0].length, m[0].startsWith('<') ? '!--' : '```']);
  const hidden = at => ranges.some(([a, b]) => at >= a && at < b);
  for (const m of text.matchAll(/<(\/?)([A-Za-z一-鿿][\w一-鿿:-]*)\b[^<>]*?(\/?)>/g)) {
    if (hidden(m.index)) continue;
    const [, closing, raw, self] = m, name = raw.toLowerCase();
    if (self || (!closing && VOID_TAGS.has(name))) continue;
    if (!closing) { stack.push({name, start: m.index}); continue; }
    const at = stack.map(x => x.name).lastIndexOf(name);
    if (at < 0) continue;
    const open = stack[at];
    stack.length = at;
    const end = m.index + m[0].length;
    if (text.slice(open.start, end).includes('\n')) ranges.push([open.start, end, name]);
  }
  return ranges;
}
/**
 * Story paragraphs of a reply with their end offsets; picture blocks and voice originals are left out. A paragraph
 * inside a block (a status bar at the end of the reply, a <details>) ends where that block closes, so a picture put
 * "after" it never lands inside the block and breaks it. The block most of the story sits in (a preset's <content>
 * wrapper) is the story itself: pictures go inside it as usual.
 */
export function paragraphs(message) {
  const source = String(message), out = [];
  const hidden = [...source.matchAll(IMG_BLOCK)].map(m => [m.index, m.index + m[0].length]);
  const ranges = blockRanges(source);
  const around = pos => ranges.filter(([a, b]) => pos > a && pos <= b).sort((x, y) => (x[1] - x[0]) - (y[1] - y[0]));
  let at = 0;
  for (const line of source.split('\n')) {
    const start = at, end = at + line.length;
    at = end + 1;
    if (hidden.some(([a, b]) => start >= a && end <= b)) continue;
    const plain = line.replace(IMG_BLOCK, '').replace(TTS_BLOCK, '').replace(/<[^>]+>/g, '').trim();
    if (plain) out.push({text: plain.slice(0, 1200), end, blocks: around(end)});
  }
  // The story's own block: the innermost block holding the most story text (none when most of it is outside blocks).
  const weight = new Map();
  // Code fences and comments are never the story's own block.
  for (const p of out) { const key = p.blocks.find(r => r[2] !== '```' && r[2] !== '!--') || null; weight.set(key, (weight.get(key) || 0) + p.text.length); }
  let main = null, best = -1;
  for (const [key, w] of weight) if (w > best) { best = w; main = key; }
  const mainChain = main ? ranges.filter(([a, b]) => a <= main[0] && b >= main[1]) : [];
  for (const p of out) {
    // Climb out of every block that is not the story's own (or one around it).
    const outer = p.blocks.filter(r => !mainChain.includes(r));
    if (outer.length) { p.end = Math.max(p.end, ...outer.map(r => r[1])); p.aside = true; }
    delete p.blocks;
  }
  // Lines in other blocks (status bars and the like) are not the story: they are not offered as places for pictures,
  // so a picture with no usable 位置 also goes after the last story paragraph. Kept only when there is nothing else.
  const story = out.filter(p => !p.aside);
  return (story.length ? story : out).map(({aside, ...p}) => p);
}
/** Chat-style request asking for the picture blocks of one reply. before: [{name, text}] earlier messages. */
export function planRequest(settings, {message, before = [], preset} = {}) {
  const p = activePreset(settings.draw, preset);
  const {entries, fill, tail} = ruleText(settings, p, PLAN_TAG_FORMAT, planContract);
  const system = entries.map(e => fill(e.text)).join('\n\n') + '\n\n' + tail;
  const context = before.length ? `【前情】\n${before.map(m => `${m.name}：${m.text}`).join('\n')}\n\n` : '';
  const body = paragraphs(message).map((x, i) => `[P${i + 1}] ${x.text}`).join('\n');
  return [{role: 'system', content: system}, {role: 'user', content: `${context}【这段正文】\n${body}\n\n（请输出 ${countOf(p)} 个出图块。）`}];
}
/** 「从剧情生成」 in the drawing app: a request of its own (no story preset, no chain of thought), worded for the engine. */
export function suggestRequest(settings, {before = []} = {}) {
  const gpt = settings.draw?.engine === 'gpt';
  const system = [
    '你是绘图提示词助手。根据给出的剧情，写出最有画面感的一幕的绘图提示词。',
    gpt ? '用英文写，逗号分隔，danbooru tag 和简短的英文短语都可以：人数、动作、表情、服装、场景、光线、构图。不写露骨内容。'
      : '用英文 danbooru tag，逗号分隔：人数（1girl、2girls 等）、动作、表情、服装、场景、光线、构图。',
    '不写剧情里的人名，不写画师名和质量词。只输出这一行提示词，不要思考过程、解释、标题或任何标签。'
  ].join('\n');
  const story = before.length ? before.map(m => `${m.name}：${m.text}`).join('\n') : '（还没有剧情）';
  return [{role: 'system', content: system}, {role: 'user', content: `【最近的剧情】\n${story}\n\n只输出提示词：`}];
}
/** The prompt line out of a reply: thinking blocks, tags, code fences and labels taken out. */
export function cleanSuggestion(text) {
  const lines = String(text || '')
    .replace(/<(think|thinking|reasoning|thought|analysis)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/^[\s\S]*<\/(?:think|thinking|reasoning)\s*>/i, '')
    .replace(/```[a-z]*|```/gi, '').replace(/<[^>]+>/g, '')
    .split('\n').map(l => l.replace(/^\s*(?:prompt|tags?|提示词)\s*[:：]\s*/i, '').trim()).filter(Boolean);
  // Lines of Chinese prose are the model talking about the picture, not the prompt.
  const tagged = lines.filter(l => !/[一-鿿]{4,}/.test(l));
  return (tagged.length ? tagged : lines).join(', ').replace(/\s*,\s*/g, ', ').replace(/(, )+$/, '').trim();
}
/** Puts planned blocks into the reply after their paragraphs. Blocks without a usable 位置 go after the last one. */
export function insertPlanned(message, reply) {
  const source = String(message), paras = paragraphs(source), blocks = [];
  for (const m of String(reply).matchAll(/<img\b[^<>]*>([^<]*)<\/img\s*>/gi)) {
    const at = m[1].match(/(?:^|\n)\s*位置\s*[:：]\s*P?\s*(\d+)/i);
    const body = m[1].replace(/(?:^|\n)\s*位置\s*[:：][^\n]*/i, '').trim();
    if (!parseBlock(body)) continue;
    const index = Math.min(paras.length, Math.max(1, Number(at?.[1]) || paras.length)) - 1;
    blocks.push({end: paras[index]?.end ?? source.length, text: `<img>\n${body}\n</img>`});
  }
  let out = source;
  for (const b of [...blocks].sort((a, b) => b.end - a.end)) out = out.slice(0, b.end) + '\n\n' + b.text + '\n' + out.slice(b.end);
  return {text: out, count: blocks.length};
}
/** The reply without picture blocks, for prompts ('strip' setting) and for planning again. */
export const withoutPictures = message => String(message).replace(IMG_BLOCK, m => /\bsrc\s*=/i.test(m) ? m : '').replace(/\n{3,}/g, '\n\n').trim();

// ---------- <img> blocks in chat text ----------
// Current form: the block above. Earlier forms, still read so old replies keep their pictures:
// <img>prompt|characters</img> and <img prompt="…" characters="…">.
const PAIRED = /<img\b([^<>]*)>([^<]*)<\/img\s*>/gi;
const SINGLE = /<img\b([^<>]*?)\/?>/gi;
const attribute = (source, name) => {
  const m = source.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|“([^”]*)”)`, 'i'));
  return m ? (m[1] ?? m[2] ?? m[3] ?? '').trim() : null;
};
export function hashText(value) {
  let h = 0x811c9dc5;
  for (const ch of value) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

const FIELDS = {画幅: 'size', 尺寸: 'size', 场景: 'tags', 基础: 'tags', 描述: 'nl', 角色: 'cast', 人物: 'cast', 新外貌: 'register', 登记: 'register', 位置: 'at'};
const split = value => value.split(/[|｜]/).map(x => x.trim());
/** Reads a block body; null when it has none of the field lines (an older one-line tag). */
export function parseBlock(body) {
  const spec = {size: '', tags: '', nl: '', cast: [], register: []};
  let found = false;
  for (const line of String(body).split(/\r?\n/)) {
    const m = line.trim().match(/^([^\s:：|｜]{2,3})\s*[:：]\s*(.*)$/);
    const key = m && FIELDS[m[1]];
    if (!key) continue;
    found = true;
    const value = m[2].trim();
    if (key === 'cast') {
      const [name, tags = '', ...rest] = split(value), c = {name, tags, nl: '', negative: '', position: ''};
      for (const part of rest.filter(Boolean)) {
        if (/^[A-Ea-e][1-5]$/.test(part)) c.position = part.toUpperCase();
        else if (/[.!?]["']?$/.test(part) || (!part.includes(',') && part.split(/\s+/).length >= 5)) c.nl = part;
        else c.negative = c.negative ? c.negative + ', ' + part : part;
      }
      if (name) spec.cast.push(c);
    }
    else if (key === 'register') { const [name, ...rest] = split(value); if (name && rest.join(', ').trim()) spec.register.push({name, appearance: rest.join(', ').trim()}); }
    else if (key !== 'at') spec[key] = spec[key] ? spec[key] + ', ' + value : value;
  }
  return found ? spec : null;
}

/**
 * Finds picture blocks: current blocks, <img>prompt|characters</img>, or <img prompt="…">. Images with src are left alone.
 * Each tag: {index, start, end, prompt (base tags), characters (names), hash, spec (block fields or null)}.
 */
export function parsePictures(message) {
  message = String(message);
  const tags = [];
  for (const m of message.matchAll(PAIRED)) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    const spec = parseBlock(m[2]);
    if (spec) { tags.push({start: m.index, end: m.index + m[0].length, prompt: spec.tags, who: spec.cast.map(c => c.name).join(','), spec, body: m[2].trim()}); continue; }
    const [body, ...who] = m[2].split(/[|｜]/);
    tags.push({start: m.index, end: m.index + m[0].length, prompt: attribute(m[1], 'prompt') ?? body.trim(), who: attribute(m[1], 'characters') ?? who.join(',')});
  }
  for (const m of message.matchAll(SINGLE)) {
    if (tags.some(t => t.start <= m.index && m.index < t.end) || /\bsrc\s*=/i.test(m[1])) continue;
    tags.push({start: m.index, end: m.index + m[0].length, prompt: attribute(m[1], 'prompt'), who: attribute(m[1], 'characters') || ''});
  }
  const found = [];
  for (const tag of tags.sort((a, b) => a.start - b.start)) {
    if (!tag.prompt && !tag.spec?.cast.length) continue;
    const characters = tag.who.split(/[,，、]/).map(x => x.trim()).filter(Boolean), index = found.length;
    const hash = tag.spec ? hashText(index + '|' + tag.body) : hashText(index + '|' + tag.prompt + '|' + characters.join(','));
    found.push({index, start: tag.start, end: tag.end, prompt: (tag.prompt || '').slice(0, 4000), characters, hash, spec: tag.spec || null, ...(tag.spec ? {body: tag.body} : {})});
  }
  return found;
}

/** Replaces picture blocks with placeholders that the host fills in after rendering. */
export function renderPictures(message, marker) {
  const tags = parsePictures(message);
  if (!tags.length) return message;
  let out = '', at = 0;
  for (const tag of tags) {
    out += message.slice(at, tag.start) + `<span class="sttts-pic" data-sttts-pic="${tag.index}" data-sttts-hash="${escapeHTML(tag.hash)}" data-sttts-token="${escapeHTML(marker)}"></span>`;
    at = tag.end;
  }
  return out + message.slice(at);
}

// ---------- Characters in a picture ----------
// Names are compared loosely: case, spaces, dots and bracketed notes are ignored, and one name may contain the other
// (the model may write 澄音（Sumine） or "Sumine" for a role named 澄音 Sumine).
const loose = name => String(name || '').toLowerCase().replace(/[（(【\[「『][^）)】\]」』]*[）)】\]」』]/g, '').replace(/[\s·・．.\-_'"“”]/g, '');
/** Same name after loose cleanup, without the containment rule: used before saving a new role. */
export const sameExact = (a, b) => !!loose(a) && loose(a) === loose(b);
export function sameName(a, b) {
  const x = loose(a), y = loose(b);
  if (!x || !y) return false;
  return x === y || (Math.min(x.length, y.length) >= 2 && (x.includes(y) || y.includes(x)));
}
/** How many people the prompt asks for (1girl, 2boys, 3others …); 0 when it does not say. */
export function peopleCount(prompt) {
  let n = 0;
  for (const m of String(prompt).matchAll(/(?:^|[,\s(])(\d+)\+?\s*(?:girls?|boys?|others?)\b/gi)) n += Number(m[1]);
  return n;
}
const drawable = settings => settings.routes.filter(r => r.appearance?.trim() && !isPlaceholderRole(r.name));
/**
 * Roles whose appearance goes into an older one-line picture tag. Names in the tag come first; when the tag names
 * nobody we know, the roles mentioned in the story just before the tag are used, up to the number of people.
 */
export function pictureRoles(settings, tag, text = '') {
  const roles = drawable(settings), named = [];
  for (const name of tag.characters) {
    const role = roles.find(r => sameName(r.name, name));
    if (role && !named.includes(role)) named.push(role);
  }
  if (named.length || !text) return named;
  const before = String(text).slice(Math.max(0, (tag.start ?? 0) - 600), tag.start ?? undefined).toLowerCase();
  const seen = roles.map(r => [r, before.lastIndexOf(r.name.toLowerCase())]).filter(([, at]) => at >= 0).sort((a, b) => b[1] - a[1]).map(([r]) => r);
  return seen.slice(0, peopleCount(tag.prompt) || 1);
}

/** 站位 A1–E5 (column A–E left to right, row 1–5 top to bottom) as NovelAI's 5×5 grid index; -1 when not given. */
export const gridIndex = at => /^[A-E][1-5]$/.test(at || '') ? (Number(at[1]) - 1) * 5 + (at.charCodeAt(0) - 65) : -1;
/** 「1girl 1boy」 becomes 「1girl, 1boy」; a picture of one person gets solo after its count tag. */
export function sceneTags(tags, people) {
  let out = String(tags || '').replace(/\b(\d\+?(?:girls?|boys?|others?))\s+(?=\d\+?(?:girls?|boys?|others?)\b)/gi, '$1, ');
  if (people === 1 && !/(?:^|,)\s*solo\s*(?:,|$)/i.test(out)) out = out.replace(/\b(1(?:girl|boy|other))\b/i, '$1, solo');
  return out;
}
/** Character prompts count nobody: 1girl/1boy/1other in a fixed appearance become girl/boy/other. */
const soloTags = tags => String(tags).replace(/\b1\s*(girl|boy|other)\b/gi, '$1');
function mergeTags(...lists) {
  const seen = new Set(), out = [];
  for (const tag of lists.flatMap(l => String(l || '').split(',')).map(t => t.trim()).filter(Boolean)) {
    const key = tag.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(tag); }
  }
  return out.join(', ');
}
/** Width and height for 竖/横/方 from the drawing app's size: same pixel budget, turned the right way. */
export function sizeFor(params, size) {
  const s = String(size || '');
  const long = Math.max(params.width, params.height), short = Math.min(params.width, params.height);
  if (/竖|portrait|vertical/i.test(s)) return {width: short, height: long};
  if (/横|landscape|horizontal/i.test(s)) return {width: long, height: short};
  if (/方|square/i.test(s)) { const side = Math.max(64, Math.floor(Math.sqrt(params.width * params.height) / 64) * 64); return {width: side, height: side}; }
  return {width: params.width, height: params.height};
}

/**
 * Final NovelAI inputs for a picture: active style + base tags + base sentence; one character caption per person
 * (fixed appearance from the 角色 App or the block's 新外貌 line, then this picture's tags and sentence).
 * names: the people in the picture. text: the message, used by older one-line tags that name nobody we know.
 */
export function pictureInputs(settings, tag, text = '') {
  const draw = settings.draw, style = activeStyle(draw), spec = tag.spec;
  const sized = {...draw.params, ...sizeFor(draw.params, spec?.size)};
  const params = draw.guard ? guardParams(sized) : sized;
  const head = [style.artist, style.positive].map(x => (x || '').trim()).filter(Boolean);
  if (!spec) {
    const roles = pictureRoles(settings, tag, text);
    return {prompt: [...head, tag.prompt].join(', '), negative: style.negative.trim(),
      characters: roles.map(r => ({prompt: r.appearance.trim(), negative: '', position: -1})), names: roles.map(r => r.name), params};
  }
  const roles = drawable(settings), many = spec.cast.length > 1;
  const characters = spec.cast.map(c => {
    const fixed = roles.find(r => sameName(r.name, c.name))?.appearance || spec.register.find(x => sameName(x.name, c.name))?.appearance || '';
    return {prompt: [mergeTags(soloTags(fixed), c.tags), c.nl].filter(Boolean).join(', '), negative: many ? mergeTags(c.negative, 'fused bodies') : c.negative || '', position: gridIndex(c.position)};
  });
  return {prompt: [...head, sceneTags(spec.tags, spec.cast.length), spec.nl].filter(Boolean).join(', '), negative: style.negative.trim(), characters, names: spec.cast.map(c => c.name), params};
}
