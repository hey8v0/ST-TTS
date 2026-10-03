/** Public API returned by the installed ST-iPhonie panel bridge (backend API 1.0.0 plus drawing). */
export type Engine = 'fish' | 'mini' | 'eleven' | 'mimo';
/** Keys cover the voice engines and NovelAI. */
/** llm: the key of the phone's own text model (an OpenAI-compatible API). */
export type KeyEngine = Engine | 'nai' | 'llm' | 'gpt';
/** What the drawing App and every picture use: NovelAI, a GPT image model, or the user's ComfyUI. */
export type DrawEngine = 'nai' | 'gpt' | 'comfy';
export type Theme = 'system' | 'light' | 'dark';
export type InjectionPosition = 'in_chat' | 'in_prompt' | 'before_prompt';
export type MessageRole = 'system' | 'user' | 'assistant';

export interface VoiceBinding { voice: string; model: string; }
export interface Route {
    id?: string;
    name: string;
    engine: Engine;
    voice: string;
    /** Empty string follows the engine connection's model. */
    model: string;
    /** Empty string follows general.defaultLanguage. */
    language?: string;
    bindings: Partial<Record<Engine, VoiceBinding>>;
    /** Fixed appearance tags added when this character appears in a picture. */
    appearance?: string;
}
export type RouteInput = Pick<Route, 'name'> & Partial<Omit<Route, 'name'>>;
export type RequestRoute = Pick<Route, 'voice'> & Partial<Omit<Route, 'voice'>>;
export interface Connection {
    model: string;
    region?: 'cn' | 'uw' | 'global';
    /** Fish Audio only: a relay address in front of api.fish.audio ('' = straight to Fish). */
    relay?: string;
    /** Fish relay only: Fish's own paths ('fish') or OpenAI's /v1/audio/speech ('openai'). */
    relayApi?: 'fish' | 'openai';
    /** Keys are the engine schema field keys, including dotted names. */
    params: Record<string, unknown>;
    parametersVersion?: number;
}
export type ConnectionPatch = Partial<Connection>;
export interface GeneralSettings {
    defaultLanguage: string;
    /** Voice lines in the story and voice messages in the phone chat. Off: no voice rules are sent, tagged lines show only their translation. */
    voiceEnabled: boolean;
    cacheEnabled: boolean;
    floatingEnabled: boolean;
    waveformEnabled: boolean;
    /** Built-in wallpapers move slowly (clouds, stars, bubbles, leaves, fireflies). */
    wallpaperMotion?: boolean;
    /** Story requests send older replies without voice tags (each line becomes its translation); the newest voiced reply keeps them while voice is on. */
    stripVoice?: boolean;
}
export interface Injection {
    position: InjectionPosition;
    depth: number;
    role: MessageRole;
}
export interface PresetEntry {
    id: string;
    title: string;
    enabled: boolean;
    text: string;
    /** Omit to inherit the preset's insertion configuration. */
    injection?: Injection;
}
export interface Preset {
    id: string;
    name: string;
    format: string;
    injection: Injection;
    entries: PresetEntry[];
}
export type PresetInput = Omit<Preset, 'id'> & { id?: string };
export interface Settings {
    version: 1;
    scope: string;
    enabled: boolean;
    theme: Theme;
    general: GeneralSettings;
    selected: string;
    activePreset: string;
    routes: Route[];
    connections: Record<Engine, Connection>;
    presets: Preset[];
    floating?: { side: 'left' | 'right'; y: number };
    draw: DrawSettings;
    chat: ChatSettings;
    moments: MomentsSettings;
    calls: CallsSettings;
    text: TextSettings;
    sync: SyncSettings;
}
export interface DrawParams {
    model: string; width: number; height: number; steps: number; scale: number;
    sampler: string; schedule: string; /** -1 picks a random seed. */ seed: number; cfgRescale: number; variety: boolean;
}
/** 画风预设: artist and fixed tags sent to NovelAI. */
export interface DrawStyle { id: string; name: string; artist: string; positive: string; negative: string; }
/** 绘图预设: rules injected into the chat request so the model writes <img> tags. */
export interface DrawPreset { id: string; name: string; /** Pictures per reply, 1 to drawCountMax. */ count: number; injection: Injection; entries: PresetEntry[]; }
export interface DrawSettings {
    connections: Record<'nai' | 'gpt', {active: string; presets: ImageConnection[]}>;
    /** Inject the drawing preset into chat requests. */
    enabled: boolean;
    /** Draw new replies' pictures automatically when free. */
    auto: boolean;
    /** Keep requests inside the free tier (<=28 steps, <=1024x1024). */
    guard: boolean;
    /** Pictures in the chat start folded. */
    fold: boolean;
    /** 'separate': plan pictures in a request of their own after the reply; 'inline': the reply writes them. */
    mode: 'separate' | 'inline';
    /** Leave picture blocks out of the messages sent to the model. */
    strip: boolean;
    queue: DrawQueueSettings;
    params: DrawParams;
    styles: DrawStyle[]; activeStyle: string;
    presets: DrawPreset[]; activePreset: string;
    /** A NovelAI relay ('' = NovelAI itself); assumeOpus counts small pictures as free when the relay gives no subscription. */
    relay: { url: string; assumeOpus: boolean };
    /** Vibe Transfer for every picture (V4/V4.5): what is in use and the groups; the vibes are in the local library. */
    vibe: VibeSettings;
    /** The engine pictures are drawn with. */
    engine: DrawEngine;
    gpt: GptImageSettings;
    comfy: ComfySettings;
}
/** Saved drawing endpoint; its secret is kept in the key store, outside settings. */
export interface ImageConnection { id: string; name: string; url: string; model?: string; assumeOpus?: boolean; }
export interface ImageConnectionInfo extends ImageConnection { current: boolean; configured: boolean; tail: string; }
/** url: '' for OpenAI, else a relay ending at /v1. ask: confirm every (paid) picture; off also lets new replies draw. style: its own 画风 ('' = NovelAI's). */
export interface GptImageSettings { url: string; model: string; quality: 'auto' | 'low' | 'medium' | 'high'; orientation: 'portrait' | 'landscape' | 'square'; ask: boolean; style: string; }
/** Reached through the tavern's ComfyUI proxy. workflow: API-format JSON with "%prompt%" and the other placeholders ('' = the default one). */
export interface ComfyWorkflow { id: string; name: string; workflow: string; sourceWorkflow?: string; disabledLoras: string[]; model: string; vae: string; sampler: string; scheduler: string; steps: number; scale: number; width: number; height: number; clipSkip: number; }
export interface ComfyDraft { base: ComfyWorkflow; value: ComfyWorkflow; dirty: boolean; conflict: boolean; controls: string[]; missing: string;
    loras: {error?: string; nodes: Array<{id: string; name: string; strength_model: number; strength_clip?: number; modelOnly: boolean; reason?: string}>; sources: Array<{id: string; name: string; modelOnly: boolean}>}; }
export interface ComfySettings extends Omit<ComfyWorkflow, 'id' | 'name'> { url: string; loraTransport: 'tavern' | 'direct'; style: string; activeWorkflow: string; workflows: ComfyWorkflow[]; }
export interface VibeGroup { id: string; name: string; items: Array<{ vibe: string; strength: number }>; }
export interface VibeSettings { enabled: boolean; use: { kind: '' | 'group' | 'vibe'; id: string }; groups: VibeGroup[]; }
/** One saved vibe as the phone sees it: never the image or the encodings. keys: models it is encoded for (v4-5full …). */
export interface VibeSummary { id: string; name: string; thumb: string; strength: number; ie: number; image: boolean; keys: string[]; }
/** The vibes a picture would use: encode = how many need encoding first (2 Anlas each), over = left out by the free-tier guard. */
export interface VibePlan { on: boolean; model: boolean; used: Array<{ id: string; name: string; strength: number; encode: boolean }>; skipped: Array<{ name: string; why: 'missing' | 'model' | 'no-encoding' }>; over: number; encode: number; extra: number; }
export interface DrawSettingsPatch { enabled?: boolean; auto?: boolean; guard?: boolean; fold?: boolean; queue?: Partial<DrawQueueSettings>; params?: Partial<DrawParams>; activeStyle?: string; activePreset?: string; relay?: Partial<{ url: string; assumeOpus: boolean }>; vibe?: Partial<VibeSettings>; engine?: DrawEngine; gpt?: Partial<GptImageSettings>; comfy?: Partial<ComfySettings>; }
/** gap: seconds between two NovelAI requests (0-60). retries: how often an "account busy" (429) is retried (0-10). */
export interface DrawQueueSettings { gap: number; retries: number; cloud: CloudQueueSettings; }
/** Shared queue service (cloud-queue/worker.js) that everyone using one NovelAI account joins with the same room code. */
/** kind 'room': our own service (cloud-queue/), joined with a room code. kind 'keyhash': a service that groups people by the
 *  SHA-256 of their NovelAI key (the 智绘姬 / st-chatu8 queue protocol); no room code, only the hash is sent. */
export interface CloudQueueSettings { enabled: boolean; kind: 'room' | 'keyhash'; url: string; room: string; }
/** A NovelAI job: waiting in line, keeping the gap (spacing), waiting after a 429 (busy), or running. */
export interface DrawJob { key: string; label: string; state: 'waiting' | 'spacing' | 'remote' | 'busy' | 'running'; attempt: number; until: number; position: number;
    /** While waiting in the cloud queue: people ahead, who is drawing, and the shared cooldown in ms. */
    cloud: { position: number; holder: string; cooldown: number } | null; }
/** unlimited: an active Opus subscription (free small images). usage: the V5 allowance, when NovelAI reports it. */
export interface NovelAISubscription { tier: number; active: boolean; unlimited: boolean; usage: { percent: number; negative: boolean } | null; anlas: number; checkedAt: number; }
export interface DrawQuote { params: DrawParams; clamped: boolean; /** null when the subscription is unknown. */ free: boolean | null; guard: boolean; v5: boolean; usage: NovelAISubscription['usage'];
    /** The vibes this picture would use; vibeAnlas: what encoding them and vibes past four add (2 each). */
    vibes: VibePlan; vibeAnlas: number;
    /** GPT / ComfyUI only: which engine; paid: GPT (every picture costs money). */
    engine?: DrawEngine; paid?: boolean; }
export interface DrawCharacter { prompt: string; negative?: string; /** 0-24 on a 5x5 grid, -1 lets the model decide. */ position: number; }
export interface DrawInput { useComfyDraft?: boolean; prompt: string; negative?: string; characters?: DrawCharacter[]; params?: Partial<DrawParams>; allowPaid?: boolean; name?: string; /** Queue key; the same key joins the waiting job. */ key?: string; label?: string; }
/** seed is -1 for GPT (it takes none); params are what the engine used (GPT has no steps). */
export interface DrawResult { photoId: string; seed: number; params: DrawParams; prompt: string; engine: DrawEngine; }
export interface SettingsSnapshot { state: Settings; revision: number; }

/** 聊天预设: how phone contacts reply, how much they see, and how a chat is brought into the story. */
export interface ChatPreset {
    id: string; name: string;
    /** Recent story messages the reply prompt includes (0-40). */ context: number;
    /** Recent chat messages the reply prompt includes (2-200). */ history: number;
    /** Template for 带进剧情; must contain {{聊天记录}}. */ bring: string;
    /** Where the brought chat is injected into the next story request. */ injection: Injection;
    /** Most posts one 朋友圈 refresh makes (1-5). */ posts: number;
    /** use: where the rule is used. */
    entries: Array<{ id: string; title: string; enabled: boolean; text: string; use: Array<'dm' | 'group' | 'moments'> }>;
}
/** A contact added by hand; story roles come from the 角色 App. */
export interface Contact { id: string; name: string; persona: string; }
/** Voice messages show only the voice bar until 转文字 (or `auto`); then the translation, the original line, or both. */
export interface VoiceTextOptions { mode: 'translation' | 'original' | 'both'; auto: boolean; }
/** 朋友圈 preset: rules for posts and reactions, how much story the model reads, and posts per refresh. */
/** 朋友圈 options; its rules are the chat preset's rules used in 朋友圈. */
/** 来电: characters call by themselves every `every` story replies, at most `dailyMax` a day; `ring` seconds before a missed call. */
/** 文字模型: who writes the phone's text. 'tavern' = the tavern's connected model; 'custom' = an OpenAI-compatible API (key kept as KeyEngine 'llm'). */
export interface SyncSettings { enabled: boolean; }
export interface SyncStatus { enabled: boolean; available: boolean; parts: Record<string, string>; busy: boolean; pending: boolean; error: string; lastAt: number; memoryAt: number;
    remote: { savedAt: number; deviceName: string; device: string } | null; lastResult?: { pulled: string[]; pushed: string[]; merged: string[] }; }
export interface TextPreset { id: string; name: string; url: string; model: string; temperature: number; maxTokens: number; }
export interface TextSettings { source: 'tavern' | 'custom'; active: string; presets: TextPreset[]; }
/** A change to the text settings: whole presets, or name/url/model/temperature/maxTokens of the preset in use. */
export type TextPatch = Partial<TextSettings> & Partial<Omit<TextPreset, 'id'>>;
export interface SpokenLine { role: string; text: string; emotion?: string; translation?: string; }
/** A call as the phone draws it. `since`/`answeredAt` are ms timestamps; `ended` is set once it is over. */
export interface CallState { id: number; name: string; dir: 'in' | 'out'; state: 'ringing' | 'talking' | 'ended'; since: number; answeredAt: number; lines: CallLine[]; thinking: boolean; speaking: boolean; voiced: boolean; error: string; auto: boolean;
    ended: { state: 'answered' | 'missed' | 'declined' | 'cancelled'; by: string; duration: number } | null; }
export interface CallsSettings { auto: boolean; every: number; dailyMax: number; ring: number; }
export interface MomentsSettings { auto: boolean; every: number; dailyMax: number; images: boolean; replyToMe: boolean; }
/** The user in the chat app. name '' shows the tavern's persona name. */
export interface ChatProfile { name: string; status: 'online' | 'qme' | 'busy' | 'away' | 'hidden'; statusText: string; signature: string; bubble: 'default' | 'candy' | 'mint' | 'night' | 'ink'; frame: 'none' | 'star' | 'cat' | 'flower' | 'halo'; background: 'none' | 'clouds' | 'stars' | 'grid' | 'sakura'; backgroundPhoto: string; }
/** 论坛: a post by a character, a stranger (any screen name) or the user ('me'); heat is how many have looked. */
export interface ForumReply { id: string; from: string; to?: string; text: string; at: number; }
export interface ForumPost { id: string; kind: 'forum'; author: string; title: string; text: string; at: number; source: 'auto' | 'me'; likes: number; liked: boolean; heat: number; replies: ForumReply[]; }
/** 查手机: a character's phone as the model made it up. */
export interface PeekSnapshot { id: string; kind: 'peek'; name: string; at: number; chats: Array<{ with: string; lines: Array<{ from: string; text: string }> }>; searches: string[]; notes: Array<{ title: string; text: string }>; photos: Array<{ text: string; tags: string; photoId?: string; state?: 'waiting' | 'done' | 'failed'; note?: string }>; }
export interface MomentComment { id: string; from: string; to?: string; text: string; at: number; }
/** author and comment names are 'me' for the user. */
export interface MomentPost { id: string; author: string; text: string; at: number; source: 'manual' | 'auto' | 'me'; photoId?: string; imageTags?: string; imageState?: 'waiting' | 'done' | 'failed'; imageNote?: string; likes: string[]; comments: MomentComment[]; }
export interface ChatSettings { presets: ChatPreset[]; activePreset: string; contacts: Contact[]; voiceText: VoiceTextOptions; profile: ChatProfile; /** 特别关心 */ starred: string[];
    /** Avatar choices by name ('me' = the user); names not listed use the tavern's avatar, else the first letter. */
    avatars: Record<string, AvatarChoice>;
    /** One wallet for the whole phone. */
    wallet: Wallet; }
/** 零钱 and its 明细 (newest first), decorations bought ('bubble:aurora'), the user's own shop gifts, gifts taken from characters. */
export interface Wallet { balance: number; ledger: Array<{ id: string; at: number; amount: number; kind: string; note: string; who: string }>; owned: string[]; gifts: ShopGift[]; received: Array<{ id: string; at: number; from: string; name: string; emoji: string; note: string }>; }
export interface ShopGift { id: string; name: string; emoji: string; price: number; note: string; /** true for a gift the user added */ own?: boolean; }
export type AvatarChoice = { kind: 'photo'; photoId: string } | { kind: 'text' };
export interface ChatContact { name: string; source: 'role' | 'manual'; id?: string; voice: boolean; engine: Engine | 'none'; language: string; persona: string; }
export type ChatKind = 'text' | 'voice' | 'photo' | 'system' | 'redpacket' | 'transfer' | 'location' | 'pat' | 'dice' | 'notice' | 'recall' | 'call' | 'gift';
export interface CallLine { from: 'me' | string; text: string; translation: string; emotion: string; }
/** notice: `text` says what `from` did, with {对方} standing for `target`. recall: a withdrawn message (no content). */
export interface ChatMessage { id: string; from: 'me' | string; kind: ChatKind; text: string; translation?: string; emotion?: string; photoId?: string; amount?: string; /** kind 'gift': what it is (price 0 when a character sends it) */ gift?: { name: string; emoji: string; price: number }; state?: 'sent' | 'opened' | 'accepted' | 'returned' | 'answered' | 'missed' | 'declined' | 'cancelled'; openedBy?: string; detail?: string; target?: string; quote?: { from: string; text: string }; at: number;
    /** call: who called (from), how it ended, how long it lasted, what was said and a missed call's voice message. */
    dir?: 'in' | 'out'; duration?: number; lines?: CallLine[]; voicemail?: Omit<CallLine, 'from'>[]; }
/** pinned: 置顶. muted: 免打扰 (its unread messages do not count toward the badge). */
export interface ChatThread { id: string; type: 'dm' | 'group'; name: string; members: string[]; unread: number; pinned: boolean; muted: boolean; createdAt: number; updatedAt: number; messages: ChatMessage[]; }
/** streak: 聊天火花, days in a row both sides wrote. */
export interface ChatThreadSummary extends Omit<ChatThread, 'messages'> { count: number; last: ChatMessage | null; streak: number; }
export type ChatMessageInput = Omit<ChatMessage, 'id' | 'at'>;
export interface PromptPlanEntry {
    key: string;
    text: string;
    /** SillyTavern's insertion-position number. */
    position: 0 | 1 | 2;
    depth: number;
    /** SillyTavern's role number: system 0, user 1, assistant 2. */
    role: 0 | 1 | 2;
}

export interface DialogueLine {
    role: string;
    emotion: string;
    /** Complete original-language text, including supported speech tags. */
    text: string;
    translation: string;
    start?: number;
    end?: number;
    uiIndex?: number;
}
export interface ParsedDialogueLine extends DialogueLine { start: number; end: number; }
export interface ParsedDialogue { format: string | undefined; lines: ParsedDialogueLine[]; }
export type PlaybackPhase = 'idle' | 'waiting' | 'generating' | 'playing' | 'paused' | 'error';
export type LineState = 'ungenerated' | 'ready' | 'played';
export interface PlaybackSnapshot {
    phase: PlaybackPhase;
    message: string;
    index: number;
    total: number;
    engine: Engine | '';
    speaker: string;
    line: DialogueLine | null;
    source: 'dialogue' | 'favorite';
    requestKey: string | null;
    volume: number;
}
export interface ReadyAudio {
    key: string;
    line: DialogueLine;
    route: Route;
    bytes: number;
    fromCache: boolean;
}
export interface RequestPreview {
    engine: Engine;
    url: string;
    body: Record<string, unknown>;
    format: string;
    sampleRate: number;
    channels: number;
}

export type ParameterType = 'number' | 'select' | 'boolean' | 'text' | 'lines' | 'textarea' | 'rows' | 'file';
export type ParameterOption = [value: string | number, label: string | number];
export interface ParameterField {
    key: string;
    label: string;
    type: ParameterType;
    value: unknown;
    help: string;
    min?: number;
    max?: number;
    step?: number;
    optional?: boolean;
    options?: ParameterOption[];
    columns?: ParameterField[];
    /** Empty means available; otherwise contains the reason this field is disabled. */
    unavailable?: string;
}
export interface EngineSchema {
    engine: Engine;
    model: string;
    models: Array<{ id: string; supported: boolean; reason: string }>;
    source: string;
    sourceDate: string;
    groups: Array<{ id: string; title: string; fields: ParameterField[] }>;
    connection: Connection;
    tags: string[];
    /** How this model reads emotion and tags, for the engine card. */
    tagNote: string;
    /** Fish S1 tone and sound tags (empty for other models). */
    sounds: string[];
}
/** What is left on a voice account. ElevenLabs: credits of the current period. Fish: API balance in US dollars. */
export type VoiceBalance =
    | { engine: 'eleven'; kind: 'characters'; used: number; limit: number; left: number; resetAt: number | null; tier: string; status: string }
    | { engine: 'fish'; kind: 'credit'; credit: number; free: boolean };
export interface VoiceQuery { search?: string; page?: number; token?: string; }
export interface VoiceList {
    voices: Array<{ id: string; name: string }>;
    more: boolean;
    token: string;
    note: string;
}

export type PhoneApp = 'roles' | 'engines' | 'presets' | 'library' | 'gallery' | 'notes' | 'listen' | 'settings' | 'draw' | 'chat';
export type BuiltinWallpaper = 'sky' | 'silver' | 'midnight' | 'rose' | 'sand' | 'aero';
/** Look of the whole phone: colours, cards, buttons and icons. Each skin also has a matching wallpaper of the same key. */
export type PhoneSkin = 'sky' | 'aero';
export type PhoneGlyph = 'default' | PhoneApp | 'wave' | 'book' | 'music' | 'camera' | 'sliders' | 'note' | 'person' | 'microphone' | 'star' | 'headphones';
export type Wallpaper = { kind: 'builtin'; key: BuiltinWallpaper } | { kind: 'photo'; photoId: string };
export type AppIcon = { kind: 'glyph'; key: PhoneGlyph } | { kind: 'photo'; photoId: string };
export interface PhonePreferences {
    wallpaper: Wallpaper;
    icons: Partial<Record<PhoneApp, AppIcon>>;
    iconStyle: 'color' | 'glass' | 'mono';
    skin: PhoneSkin;
    lockOnOpen: boolean;
    volume: number;
    theme: Theme;
}
export interface PhonePatch extends Partial<Omit<PhonePreferences, 'icons'>> {
    /** Entries merge with saved icons; null resets only that app's icon. */
    icons?: Partial<Record<PhoneApp, AppIcon | null>>;
}
export interface PhoneCatalog {
    readonly apps: readonly PhoneApp[];
    readonly wallpapers: readonly BuiltinWallpaper[];
    readonly glyphs: readonly PhoneGlyph[];
    readonly skins: readonly PhoneSkin[];
}
export interface LocalTimestamps { createdAt: number; updatedAt: number; }
export interface Note extends LocalTimestamps { id: string; title: string; text: string; }
export interface NoteInput { id?: string; title?: string; text?: string; }
export interface MediaMetadata extends LocalTimestamps {
    id: string;
    name: string;
    type: string;
    size: number;
}
export interface Photo extends MediaMetadata { blob: Blob; }
export interface PhotoInput { name?: string; blob: Blob; }
export type ReferenceMetadata = MediaMetadata;
export interface FavoriteMetadata extends LocalTimestamps {
    id: string;
    requestKey: string;
    role: string;
    text: string;
    translation: string;
    engine: Engine;
    model: string;
    voice: string;
    type: string;
    size: number;
}
export interface Favorite extends FavoriteMetadata { blob: Blob; }
export interface FavoriteQuery { role?: string; }
export interface AudioMetadata {
    /** Earlier plugin cache entries can have no metadata. */
    line?: DialogueLine;
    route?: Partial<Pick<Route, 'name' | 'engine' | 'model' | 'voice'>>;
    requestKey?: string;
}
export interface CachedAudio { key: string; at: number; bytes: number; metadata: AudioMetadata; }
export interface CacheStats { count: number; bytes: number; available: boolean; }
export interface LibraryStats { bytes: number; limit: number; notes: number; photos: number; favorites: number; references: number; }
export type LibraryCollection = 'favorites' | 'cache' | 'photos' | 'notes';

export type BackendEvent =
    | ({ type: 'playback'; revision: number } & PlaybackSnapshot)
    | ({ type: 'audio-ready'; revision: number } & ReadyAudio)
    | { type: 'settings'; revision: number; state: Settings }
    | { type: 'keys'; revision: number; engine: Engine; configured: boolean }
    | { type: 'library'; revision: number; collection: LibraryCollection }
    | { type: 'phone'; revision: number; preferences: PhonePreferences }
    | { type: 'draw'; revision: number; phase?: 'generating' | 'done' | 'error' | 'cancelled'; message?: string; subscription?: NovelAISubscription; queue?: DrawJob[]; /** Why the cloud queue could not be used, when it could not. */ cloud?: string }
    /** A chat changed; typing is set while a reply is being generated. threadId is null when a chat was created. */
    | { type: 'chat'; revision: number; threadId: string | null; typing?: boolean; bring?: boolean };

/** Framework-independent facade. Methods may throw validation/lifecycle errors. */
export interface BackendFacade {
    readonly apiVersion: string;
    readonly defaultPrompt: string;
    readonly defaultFormat: string;
    readonly phoneCatalog: PhoneCatalog;
    /** The picture block format shown to the model. */
    readonly picTagFormat: string;
    readonly defaultDrawRule: string;
    readonly drawCountMax: number;
    readonly defaultChatPreset: Omit<ChatPreset, 'id'>;
    /** The shipped voice preset (without id), for 恢复默认. */
    readonly defaultVoicePreset: Omit<Preset, 'id'>;
    /** The shipped drawing preset (without id), for 恢复默认. */
    readonly defaultDrawPreset: Omit<DrawPreset, 'id'>;
    readonly drawCatalog: { readonly models: readonly string[]; readonly modelNames: Readonly<Record<string, string>>; readonly samplers: readonly string[]; readonly schedules: readonly string[];
        readonly engines: readonly DrawEngine[]; readonly engineNames: Readonly<Record<DrawEngine, string>>; readonly gptModels: readonly string[]; readonly gptQualities: readonly string[]; readonly comfyWorkflow: string };
    getState(): Settings;
    getSnapshot(): SettingsSnapshot;
    save(next: Settings, expectedRevision?: number): Settings;
    updateGeneral(patch: Partial<GeneralSettings>): Settings;
    saveRoute(route: RouteInput): Route;
    deleteRoute(id: string): Settings;
    /** Returns a changed draft; it does not save the route. */
    switchRouteEngine(route: RouteInput, engine: Engine): Route;
    validRoleName(name: unknown): boolean;
    saveConnection(engine: Engine, patch: ConnectionPatch): Connection;
    savePreset(preset: PresetInput): Preset;
    deletePreset(id: string): Settings;
    selectPreset(id: string): Settings;
    /** Returns an empty string when valid, otherwise a displayable error. */
    validatePreset(preset: PresetInput): string;
    previewPrompt(preset?: Preset): string;
    promptPlan(): PromptPlanEntry[];
    parse(text: string): ParsedDialogue;
    /** ElevenLabs or Fish balance; null without a key. Cached for a minute unless `refresh`. */
    voiceBalance(engine: 'eleven' | 'fish', refresh?: boolean): Promise<VoiceBalance | null>;
    keyStatus(engine: KeyEngine): boolean;
    /** The last 4 characters of the saved key ('' when none is saved), to tell which key is in use. */
    keyHint(engine: KeyEngine): string;
    /** Several keys (Fish): how many, which one is in use (1-based) and how many were refused while this page is open. */
    keyPool(engine: Engine): { count: number; current: number; refused: number } | null;
    /** The saved keys of a voice engine: last 4 characters, whether in use, whether refused while this page is open. */
    keyList(engine: Engine): Array<{ tail: string; current: boolean; refused: boolean }>;
    /** Adds keys (several, one per line) after those saved; returns how many were new. */
    addKeys(engine: Engine, value: string): number;
    /** Deletes the saved key at this place in keyList (0-based). */
    removeKey(engine: Engine, index: number): void;
    /** Uses this saved key from now on and moves it to the front, so it is used first next time too. */
    useKey(engine: Engine, index: number): void;
    setKey(engine: KeyEngine, key: string): void;
    clearKey(engine: KeyEngine): void;
    saveDraw(patch: DrawSettingsPatch): DrawSettings;
    imageConnectionList(engine: 'nai' | 'gpt'): ImageConnectionInfo[];
    saveImageConnection(engine: 'nai' | 'gpt', patch?: Partial<ImageConnection> & {key?: string}): ImageConnectionInfo;
    selectImageConnection(engine: 'nai' | 'gpt', id: string): void;
    deleteImageConnection(engine: 'nai' | 'gpt', id: string): void;
    /** Whether the engine in use can draw (NovelAI / GPT key saved, ComfyUI address set); drawMissing says what is missing ('' when ready). */
    drawReady(): boolean;
    drawMissing(): string;
    /** What to ask before a picture that costs money with the engine in use. note: the line shown on a picture left undrawn. */
    paidPrompt(): { title: string; text: string; note: string };
    /** ComfyUI through the tavern: connection check and what it offers. url: an address not saved yet. */
    comfyCatalog(url?: string): Promise<{ models: Array<{ value: string; text: string }>; samplers: string[]; schedulers: string[] }>;
    /** Workflows saved in the tavern's own image generation (file names), and one of them as text. */
    comfyWorkflows(): Promise<string[]>;
    comfyWorkflow(name: string): Promise<string>;
    saveComfyWorkflow(patch: {id?: string; name?: string; workflow?: string; sourceWorkflow?: string; disabledLoras?: string[]; params?: Partial<ComfyWorkflow>; expected?: Partial<ComfyWorkflow>}): ComfyWorkflow;
    getComfyDraft(): ComfyDraft;
    updateComfyDraft(patch: {workflow?: string; disabledLoras?: string[]; params?: Partial<ComfyWorkflow>}, expected?: ComfyWorkflow): ComfyDraft;
    resetComfyDraft(): ComfyDraft;
    saveComfyDraft(options?: {name?: string; copy?: boolean}): ComfyWorkflow;
    selectComfyWorkflow(id: string): void;
    deleteComfyWorkflow(id: string): void;
    comfyLoras(options?: {transport?: 'tavern' | 'direct'; signal?: AbortSignal}): Promise<string[]>;
    saveStyle(style: Omit<DrawStyle, 'id'> & { id?: string }): DrawStyle;
    deleteStyle(id: string): DrawSettings;
    saveDrawPreset(preset: Omit<DrawPreset, 'id'> & { id?: string }): DrawPreset;
    deleteDrawPreset(id: string): DrawSettings;
    /** Text injected for the active drawing preset, or for the given draft. */
    previewDrawPrompt(preset?: DrawPreset): string;
    /** Cached for ten minutes unless refresh is true; null without a NovelAI key. */
    naiSubscription(refresh?: boolean): Promise<NovelAISubscription | null>;
    /** Jobs waiting for NovelAI, first one running. */
    drawQueue(): DrawJob[];
    cancelDraw(key: string): boolean;
    cancelAllDraws(): void;
    /** Empty when the cloud queue works or is off. */
    cloudQueueError(): string;
    testCloudQueue(value?: Partial<CloudQueueSettings>): Promise<{ ok: true; length: number; holder: string; cooldown: number } | { ok: false; message: string }>;
    newRoomCode(): string;
    drawQuote(params?: Partial<DrawParams>, useComfyDraft?: boolean): DrawQuote;
    /** Saved vibes (summaries, newest first). */
    listVibes(): VibeSummary[];
    /** Imports .naiv4vibe, .naiv4vibebundle, 智绘姬 exports and pictures; groups in the files become groups. */
    importVibes(files: ArrayLike<File>, options?: { names?: boolean }): Promise<{ added: number; updated: number; renamed: number; groups: number; errors: Array<{ name: string; message: string }> }>;
    updateVibe(id: string, patch: { name?: string; strength?: number }): Promise<VibeSummary>;
    /** Deletes a vibe and takes it out of every group. */
    deleteVibe(id: string): Promise<void>;
    /** Deletes several vibes at once; returns how many were deleted. */
    deleteVibes(ids: string[]): Promise<number>;
    /** {vibe} → .naiv4vibe, {group} → .naiv4vibebundle, {all} → everything in the 智绘姬 form. */
    exportVibes(target: { vibe?: string; group?: string; all?: boolean }): Promise<{ name: string; blob: Blob }>;
    vibePlan(model?: string): VibePlan;
    /** Generates one image and saves it to the album. Rejects paid requests unless allowPaid. */
    generateImage(input: DrawInput): Promise<DrawResult>;
    reference(file: Blob & { readonly name?: string }): Promise<string>;
    listReferences(): Promise<ReferenceMetadata[]>;
    deleteReference(id: string): Promise<void>;
    engineSchema(engine: Engine, connection?: Connection): EngineSchema;
    validateConnection(engine: Engine, connection: Connection): string;
    voices(engine: Engine, connection?: Connection | null, query?: VoiceQuery): Promise<VoiceList>;
    previewRequest(engine: Engine, connection: Connection | null | undefined, route: RequestRoute, line: DialogueLine): RequestPreview;
    status(): PlaybackSnapshot;
    /** Immediately sends the current playback state; call the result when unmounting. */
    subscribe(listener: (event: BackendEvent) => void): () => boolean;
    levels(): number[];
    pendingRole(): string | null;
    stop(): void;
    toggle(): void | Promise<void>;
    resume(): void | Promise<void>;
    audition(route: RouteInput): void;
    lineState(line: DialogueLine): Promise<LineState>;
    /** Persists the volume; valid values are 0 through 1. */
    setVolume(value: number): Promise<PhonePreferences>;
    getVolume(): number;
    cacheStats(): Promise<CacheStats>;
    clearCache(): Promise<CacheStats>;
    listAudio(): Promise<CachedAudio[]>;
    deleteAudio(key: string): Promise<void>;
    latestAudio(): ReadyAudio | null;
    favoriteAudio(key: string): Promise<Favorite>;
    /** The parts a backup can hold, key -> label. */
    backupParts(): Record<'settings' | 'chats' | 'moments' | 'notes' | 'photos' | 'favorites' | 'vibes' | 'keys', string>;
    /** A backup file of the chosen parts, named for saving. Never contains keys. */
    /** parts may include 'keys', which needs `password` (at least 6 characters): the keys are sealed with it. */
    exportBackup(parts: string[], version?: string, options?: { password?: string }): Promise<{ blob: Blob; name: string }>;
    /** What a backup file holds; rejects when it is not an ST-iPhonie backup. */
    inspectBackup(file: Blob): Promise<{ version: string; createdAt: number; summary: { settings: { roles: number; presets: number } | null; chats: number | null; moments: number | null; notes: number | null; photos: number | null; favorites: number | null; vibes: { vibes: number; groups: number } | null; keys: number | null } }>;
    /** Restores the chosen parts; replace empties those kinds of data first. Returns how many of each came back. */
    importBackup(file: Blob, options: { parts: string[]; replace?: boolean; password?: string }): Promise<{ settings?: boolean; chats?: number; moments?: number; notes?: number; photos?: number; favorites?: number; vibes?: number; vibeGroups?: number; references?: number; phone?: number; keys?: number }>;
    /** The audio of a favorite, a cached line, or a line with its speaker's current voice, named for saving.
     *  Rejects when that line has not been generated yet. */
    audioFile(ref: { favorite: string } | { key: string } | { line: { role: string; text: string; emotion?: string; translation?: string } }): Promise<{ blob: Blob; name: string }>;
    listFavorites(query?: FavoriteQuery): Promise<FavoriteMetadata[]>;
    getFavorite(id: string): Promise<Favorite | null>;
    /** Resolves after lookup and playback handoff, not after audio playback ends. */
    playFavorite(id: string): Promise<void>;
    deleteFavorite(id: string): Promise<boolean>;
    listPhotos(): Promise<MediaMetadata[]>;
    addPhoto(value: PhotoInput): Promise<Photo>;
    getPhoto(id: string): Promise<Photo | null>;
    deletePhoto(id: string): Promise<boolean>;
    listNotes(): Promise<Note[]>;
    saveNote(value: NoteInput): Promise<Note>;
    deleteNote(id: string): Promise<boolean>;
    getPhone(): Promise<PhonePreferences>;
    savePhone(patch: PhonePatch): Promise<PhonePreferences>;
    libraryStats(): Promise<LibraryStats>;
    /** Album photos made by drawing (the workbench and in-text pictures). */
    generatedPhotos(): Promise<{ count: number; bytes: number }>;
    /** Deletes those photos from the album; returns how many were deleted. Imported photos stay. */
    deleteGeneratedPhotos(): Promise<number>;
    saveChatPreset(preset: Partial<ChatPreset> & { name: string }): ChatPreset;
    /** 朋友圈 options. */
    saveCalls(patch: Partial<CallsSettings>): CallsSettings;
    saveText(patch: TextPatch): TextSettings;
    /** The key of one text model preset (each preset keeps its own). */
    setTextKey(id: string, key: string): void;
    clearTextKey(id: string): void;
    textKeyHint(id: string): string;
    /** 保存到酒馆: whether it is on, whether the tavern's files can be reached here, and how the last sync went. */
    syncStatus(): SyncStatus;
    saveSync(patch: Partial<SyncSettings>): SyncSettings;
    /** Syncs now: takes what changed in the tavern, writes what changed here. */
    syncNow(): Promise<SyncStatus>;
    /** Model ids the custom text API lists (a free connection check); `draft` are options not saved yet. */
    textModels(draft?: TextPatch): Promise<string[]>;
    /** Checks NovelAI or the relay: the drawing route (an empty request, nothing drawn, no Anlas) and the subscription. */
    /** Checks the Fish relay (or Fish itself): the speech path and the voice list; status 0 = no answer (address, CORS, HTTPS). */
    fishProbe(): Promise<{ relay: boolean; base: string; openaiUrl: string; api: 'fish' | 'openai'; detected: '' | 'fish' | 'openai'; speech: { status: number; ok: boolean }; compat: { status: number; ok: boolean }; openai: { status: number; ok: boolean }; voices: { status: number; ok: boolean } }>;
    naiProbe(): Promise<{ relay: boolean; draw: { ok: boolean; status: number }; subscription: { ok: true; tier: number } | { ok: false; status: number; message: string } }>;
    saveMoments(patch: Partial<Pick<MomentsSettings, 'auto' | 'every' | 'dailyMax' | 'images' | 'replyToMe'>>): MomentsSettings;
    /** Newest first. */
    listMoments(): Promise<MomentPost[]>;
    getMoment(id: string): Promise<MomentPost | null>;
    /** A post by the user. */
    postMoment(post: { text: string; photoId?: string }): Promise<MomentPost>;
    likeMoment(id: string, on?: boolean): Promise<MomentPost>;
    commentMoment(id: string, comment: { text: string; to?: string }): Promise<{ post: MomentPost; comment: MomentComment }>;
    deleteMoment(id: string): Promise<boolean>;
    deleteMomentComment(id: string, commentId: string): Promise<MomentPost>;
    clearMoments(): Promise<number>;
    /** 论坛, newest first. */
    listForum(): Promise<ForumPost[]>;
    getForumPost(id: string): Promise<ForumPost | null>;
    /** The latest 热搜 topics. */
    forumHot(): Promise<string[]>;
    postForum(post: { title?: string; text: string }): Promise<ForumPost>;
    replyForum(id: string, reply: { text: string; to?: string }): Promise<{ post: ForumPost; reply: ForumReply }>;
    likeForum(id: string, on?: boolean): Promise<ForumPost>;
    deleteForumReply(id: string, replyId: string): Promise<ForumPost>;
    deleteForum(id: string): Promise<boolean>;
    clearForum(): Promise<number>;
    /** 分区: the character card open in the tavern ({key, name, members}) and whether 分区 is on. */
    phoneSpace(): { key: string; name: string; members: string[]; on: boolean };
    /** 查手机 snapshots, newest first; one per character. */
    listPeeks(): Promise<PeekSnapshot[]>;
    getPeek(name: string): Promise<PeekSnapshot | null>;
    deletePeek(name: string): Promise<boolean>;
    deleteChatPreset(id: string): ChatSettings;
    selectChatPreset(id: string): ChatSettings;
    /** Reply prompt with sample chat content, for the preset editor. */
    previewChatPrompt(preset?: ChatPreset): string;
    /** Empty string when the preset is valid. */
    validateChatPreset(preset: ChatPreset): string;
    /** 钱包 and 商城. */
    wallet(): Wallet;
    /** Buys a decoration once (paid from the wallet; too little left: an error with code 'BROKE'). */
    buyDecoration(kind: 'bubble' | 'frame' | 'background', key: string): Wallet;
    saveGift(gift: Partial<ShopGift>): ShopGift;
    deleteGift(id: string): Wallet;
    /** The user sends a red packet ({kind, amount, text}), a transfer, or a gift ({kind: 'gift', giftId, text}): paid first, refunded if it cannot be sent. */
    sendPaid(threadId: string, message: { kind: 'redpacket' | 'transfer'; amount: string; text?: string } | { kind: 'gift'; giftId: string; text?: string }): Promise<ChatThread>;
    /** Takes (or returns) what a contact sent: red packet, transfer or gift. Money goes into the wallet, a gift into 收到的礼物. */
    takeSent(threadId: string, messageId: string, accept?: boolean): Promise<ChatThread>;
    shopCatalog(): { premium: Record<'bubble' | 'frame' | 'background', Record<string, [string, number]>>; kinds: Record<string, string>; gifts: ShopGift[]; ledgerKinds: Record<string, string> };
    saveChatOptions(patch: { voiceText?: Partial<VoiceTextOptions>; profile?: Partial<ChatProfile>; starred?: string[]; /** null: back to the tavern's avatar */ avatars?: Record<string, AvatarChoice | null> }): ChatSettings;
    saveContact(contact: Partial<Contact> & { name: string }): Contact;
    deleteContact(id: string): ChatSettings;
    /** Story roles (角色 App) first, then manual contacts. */
    chatContacts(): ChatContact[];
    listThreads(): Promise<ChatThreadSummary[]>;
    getThread(id: string): Promise<ChatThread | null>;
    chatUnread(): Promise<number>;
    createThread(value: { type: 'dm' | 'group'; members: string[]; name?: string }): Promise<ChatThread>;
    updateThread(id: string, patch: { name?: string; members?: string[]; pinned?: boolean; muted?: boolean }): Promise<ChatThread>;
    deleteThread(id: string): Promise<boolean>;
    /** read: the chat is on screen, so new replies do not count as unread. */
    appendChat(id: string, messages: ChatMessageInput[], options?: { read?: boolean }): Promise<ChatThread>;
    deleteChatMessages(id: string, ids: string[]): Promise<ChatThread>;
    /** {state, openedBy} for a red packet or transfer, or {recall: true} to withdraw a message. */
    updateChatMessage(id: string, messageId: string, patch: { state?: string; openedBy?: string; recall?: boolean }): Promise<ChatThread>;
    markThreadRead(id: string): Promise<ChatThread>;
    /** Plays a voice message through the normal player. */
    /** Plays one voice line, or several in a row (a voicemail). */
    speak(line: SpokenLine | SpokenLine[]): Promise<void> | void;
    /** The voice tag format voice messages use (the active voice preset's format). */
    voiceFormat(): string;
}

export interface LatestMessage { id: number; lines: ParsedDialogueLine[]; }
/** Installed-panel API: facade plus actions that access the current SillyTavern chat. */
export interface BackendAPI extends BackendFacade {
    /** Closes the settings panel; it does not dispose the backend or stop audio. */
    close(): void;
    /** id is -1 when there is no readable assistant dialogue. */
    latest(): LatestMessage;
    /** Omit lineIndex to play the whole message. Generation requires an explicit user action. */
    play(messageId: number, lineIndex?: number): void;
    /** Latest chat messages, newest first, for choosing where to insert a picture. */
    recentMessages(): Array<{ id: number; name: string; user: boolean; preview: string }>;
    /** Uploads an album photo to the tavern and attaches it to the message. */
    insertImage(messageId: number, photoId: string): Promise<{ id: number; url: string }>;
    /** Asks the chat model for picture tags describing the latest scene. */
    suggestPrompt(): Promise<string>;
    /** Pictures stored in the open tavern chat. */
    chatPictureStats(): { count: number };
    /** Plans the pictures of the newest character reply again and queues them. */
    planLatestPictures(): Promise<boolean>;
    /** Deletes every picture of the open chat from the tavern; their tags show "点击生成" again. */
    clearChatPictures(): Promise<{ count: number; failed: number }>;
    /** A picture the chat asked to open in the drawing app, if any. */
    takeDraw(): (DrawInput & { tag?: string; seed?: number }) | null;
    /** Generates the contacts' next messages with the tavern's connected model and stores them. */
    chatReply(threadId: string): Promise<ChatThread>;
    /** Prepares chat messages to be injected once into the next story reply. */
    chatBring(threadId: string, messageIds: string[]): Promise<{ threadId: string; name: string; count: number; text: string }>;
    chatPendingBring(): { threadId: string; name: string; count: number } | null;
    chatCancelBring(): void;
    /** True while a reply for this chat is being generated. */
    chatTyping(threadId: string): boolean;
    /** New 朋友圈 posts from the characters (one model request). */
    momentsRefresh(): Promise<MomentPost[]>;
    /** Friends react to the user's post. */
    momentsReact(id: string): Promise<MomentPost>;
    /** Answers to the user's comment. */
    momentsReply(id: string, commentId: string): Promise<MomentPost>;
    /** Draws a post's picture; allowPaid lets it spend Anlas. */
    momentsDrawImage(id: string, allowPaid?: boolean): Promise<string | null>;
    /** True while a 朋友圈 request is running. */
    momentsBusy(): boolean;
    /** The call going on (or just ended), null when there is none. */
    callStatus(): CallState | null;
    /** Calls a contact; they pick up after a few rings. */
    callDial(name: string): CallState;
    /** Answers the ringing incoming call. */
    callAnswer(): CallState;
    /** Declines a ringing call (or cancels the user's own). */
    callDecline(): Promise<CallState | null>;
    /** Hangs up (or cancels while it rings); the call is kept in the private chat. */
    callHangup(): Promise<CallState | null>;
    /** Says something in the call. Only puts the words in the call; the contact answers on callReply(). */
    callSay(text: string): Promise<CallState | null>;
    /** The contact answers everything said so far (goes on talking when the user said nothing), aloud. */
    callReply(): Promise<void>;
    /** Asks the contact again after a turn failed. */
    callRetry(): Promise<void>;
    /** The tavern's own avatar pictures: the current persona's, and each character card's by name (URLs). */
    tavernAvatars(): { me: string; characters: Record<string, string> };
    /** How many single vibes and groups 智绘姬 (st-chatu8) has in this tavern; 0 when it is not installed. */
    /** 论坛: new posts and the 热搜; replies to the user's post; answers to the user's reply. */
    forumRefresh(): Promise<ForumPost[]>;
    forumReact(id: string): Promise<ForumPost>;
    forumReply(id: string, replyId: string): Promise<ForumPost>;
    forumBusy(): boolean;
    /** 查手机: looks into a character's phone (a new snapshot). */
    peekLook(name: string): Promise<PeekSnapshot>;
    peekBusy(): boolean;
    /** Draws one album photo of a character's phone with NovelAI; allowPaid when it would cost Anlas. */
    peekDraw(name: string, index: number, allowPaid?: boolean): Promise<string>;
    chatu8Vibes(): number;
    /** The World Info books turned on now (global, character, chat, persona) with their entries that are on, for picking
     *  what the phone leaves out. Entry ids are "book#uid". */
    loreBooks(): Promise<Array<{ name: string; from: string[]; entries: Array<{ id: string; title: string; keys: string[]; constant: boolean; preview: string }> }>>;
    /** Imports every vibe and group 智绘姬 keeps (read only: nothing of 智绘姬's changes). */
    importChatu8(): Promise<{ added: number; updated: number; renamed: number; groups: number; errors: Array<{ name: string; message: string }> }>;
    /** On a computer the phone is a floating window beside the story (false when it is full screen). */
    panelFloating(): boolean;
    /** Moves the floating phone by its top bar, in screen coordinates; 'reset' puts it back at the right edge. */
    panelDrag(phase: 'start' | 'move' | 'end' | 'reset', screenX?: number, screenY?: number): boolean;
    /** Switches the floating phone to the next size and returns its name (小 / 中 / 大). */
    panelSize(): string;
    panelSizeName(): string;
    /** The tavern's persona name ('' outside the tavern). */
    userName(): string;
    /** Facts for the self-check report (core/diagnostics.js buildReport). Asks whether keys work; never returns them. */
    diagnose(): Promise<DiagnosticFacts>;
    /** Remembers an error shown in the phone, for the self-check. */
    noteError(text: string): void;
}
/** What the self-check found in the tavern page; core/diagnostics.js buildReport turns it into the report. */
export interface DiagnosticFacts {
    at: number;
    plugin: { version: string; copies: string[] };
    tavern: { version: string; mode: 'hook' | 'legacy' };
    browser: { secure: boolean; audio: boolean; indexedDB: boolean; storage: { usage: number; quota: number } | null; agent: string };
    extensions: string[];
    voice: { enabled: boolean; preset: string; format: string; injection: string; roles: { name: string; voice: boolean }[] };
    keys: Partial<Record<'fish' | 'mini' | 'eleven' | 'nai', { set: boolean; needed: string; check?: 'ok' | 'error'; detail?: string }>>;
    reply: { id: number; name: string; lines: number; tags: boolean; problems: { at: number; role: string; reason: string; snippet: string }[];
        inChat: boolean; waves: number; stale: number; iframes: number; covered: string; streaming: boolean } | null;
    errors: { at: number; kind: 'notice' | 'error'; message: string }[];
}
export interface PanelHostBridge { connect(source: Window): BackendAPI; }

declare global {
    interface Window {
        __stIphoniePanelBridge?: PanelHostBridge;
        /** Legacy callbacks remain supported; new views should use subscribe(). */
        stTtsUpdate?: (state: PlaybackSnapshot) => void;
        stTtsOpenRole?: (routeId: string) => void;
        stTtsPanelVisibility?: (visible: boolean) => void;
        stTtsOpenDraw?: () => void;
    }
}
/** Connect only from the installed plugin's settings iframe. Defaults to its window. */
export declare function connectBackend(view?: Window): BackendAPI;
