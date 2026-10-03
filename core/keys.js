// Voice engines, NovelAI for drawing, and llm: the phone's own text model (an OpenAI-compatible API).
import {connectionLost} from './idb.js';
const engines=['fish','mini','eleven','mimo','nai','llm','gpt'];
// Keys copied from web pages and chat apps often carry invisible characters (zero-width spaces, line breaks), full-width
// letters typed with a Chinese input method, quotes, or a "Bearer " prefix. No key contains any of these, and a service
// answers such a key with 401 although the key itself is valid, so they are taken out before the key is kept or sent.
export function cleanKey(value){
 let key=String(value??'').normalize('NFKC').replace(/[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g,'');
 key=key.trim().replace(/^bearer\s+/i,'').replace(/\s+/g,'').replace(/^["'`“”‘’「」]+|["'`“”‘’「」]+$/g,'');
 return key;
}
// Engines that take several keys, one per line: when one is refused or used up, the next one is used (core/providers.js).
export const MULTI_KEY=new Set(['fish','mini','eleven','mimo']);
function checkKey(key){if(key.length>4096)throw Error('密钥格式无效');if(/[^\x21-\x7E]/.test(key))throw Error('密钥里有不是英文字母、数字或符号的字，请回到官网重新复制一次');return key;}
// Text and image models keep one key per connection preset: lines of "<preset id><tab><key>". A key saved before presets
// (a line without a tab) belongs to the first preset, 'default'.
export function parseTextKeys(value){const out=new Map();for(const line of String(value??'').split('\n')){if(!line.trim())continue;const at=line.indexOf('\t'),id=at<0?'default':line.slice(0,at).trim(),key=checkKey(cleanKey(at<0?line:line.slice(at+1)));if(/^[\w-]{1,64}$/.test(id)&&key)out.set(id,key);}return out;}
export const joinTextKeys=map=>[...map].filter(([,key])=>key).map(([id,key])=>id+'\t'+key).join('\n');
export function validateKey(engine,value){if(!engines.includes(engine))throw Error('引擎无效');
 if(engine==='llm'||(['nai','gpt'].includes(engine)&&String(value??'').includes('\t')))return joinTextKeys(parseTextKeys(value));
 // Several keys come one per line (commas, semicolons and spaces also separate them); repeats are kept once, in order.
 if(MULTI_KEY.has(engine)){const keys=[...new Set(String(value??'').normalize('NFKC').split(/[\s,;，；、]+/).map(cleanKey).filter(part=>part&&!/^bearer$/i.test(part)))];if(keys.length>50)throw Error('最多填 50 个密钥');return keys.map(checkKey).join('\n');}
 return checkKey(cleanKey(value));}
/** The last characters of a key, to tell which key is saved without showing it. */
export const keyTail=key=>key&&key.length>=8?key.slice(-4):'';
export class LocalKeyStore{
 constructor(scope,storage=()=>globalThis.localStorage){this.prefix='sttts.keys.v1:'+encodeURIComponent(scope)+':';this.storage=storage;}
 load(){const result=new Map();let storage;try{storage=this.storage();for(const engine of engines){const value=storage.getItem(this.prefix+engine);if(value){try{const key=validateKey(engine,value);if(key)result.set(engine,key);}catch{}}}}catch{throw Error('浏览器无法读取已保存的密钥，请在引擎设置重新填写');}return result;}
 save(engine,value){const key=validateKey(engine,value);try{const storage=this.storage();if(key)storage.setItem(this.prefix+engine,key);else storage.removeItem(this.prefix+engine);}catch(error){throw Error(storageFailure(error));}return key;}
 /** Removes a key without checking it (moving keys elsewhere). */
 drop(engine){try{this.storage().removeItem(this.prefix+engine);}catch{}}
}
/** Why the browser would not keep something: full, or site data not allowed (private window, blocked cookies). */
export function storageFailure(error){
 const full=error?.name==='QuotaExceededError'||/quota|full|space/i.test(String(error?.message||''));
 return full?'浏览器的网站存储满了，密钥没有存上：先在 设置 → 备份与恢复 备份一次，再清理这个酒馆地址的网站数据，或者删掉占地方的插件数据'
  :'浏览器不让保存密钥：可能是无痕窗口，或者禁用了这个网站的数据（Cookie 和网站数据）';
}
const KEY_DB='st-iphonie-keys',KEY_STORE='keys';
/**
 * Keys in their own IndexedDB database (not in localStorage: its ~5 MB per address is shared with the tavern and every
 * other extension, and once another one fills it nothing can be saved). open() reads this account's keys into memory
 * and moves keys saved by older versions out of localStorage; load() and save() then work at once, and save() writes
 * in the background, in order. Without IndexedDB (or when it will not open) keys stay in localStorage as before.
 * A key that could not be written still works until the page is closed; onError says so.
 */
export class KeyStore{
 constructor(scope,{indexedDB=globalThis.indexedDB,storage=()=>globalThis.localStorage,onError=()=>{}}={}){this.scope=String(scope);this.factory=indexedDB;this.legacy=new LocalKeyStore(scope,storage);this.onError=onError;this.keys=new Map();this.touched=new Set();this.db=null;this.opening=null;this.writing=Promise.resolve();this.fallback=false;}
 open(){return this.opening??=this.#open();}
 async #open(){
  // A database of this name without the store (made by something else opening it first) is upgraded once to add it.
  const connect=version=>new Promise((resolve,reject)=>{const req=version?this.factory.open(KEY_DB,version):this.factory.open(KEY_DB);req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains(KEY_STORE))req.result.createObjectStore(KEY_STORE,{keyPath:'id'});};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);req.onblocked=()=>reject(Error('blocked'));});
  try{this.db=await connect(0);if(!this.db.objectStoreNames.contains(KEY_STORE)){const next=this.db.version+1;this.db.close();this.db=await connect(next);}}
  catch{this.fallback=true;try{for(const [engine,key] of this.legacy.load())if(!this.touched.has(engine))this.keys.set(engine,key);}catch{}return this;}
  this.#watch(this.db);
  const rows=await this.#run('readonly',store=>store.getAll()).catch(()=>[]);
  // A key saved before this finished (save() does not wait) is newer than what is stored.
  for(const row of rows||[])if(row?.scope===this.scope&&engines.includes(row.engine)&&!this.touched.has(row.engine)){try{const key=validateKey(row.engine,row.key);if(key)this.keys.set(row.engine,key);}catch{}}
  // Keys of older versions: moved over, then taken out of localStorage (which frees a little of its room too).
  let old=new Map();try{old=this.legacy.load();}catch{}
  const moving=[...old].filter(([engine])=>!this.keys.has(engine)&&!this.touched.has(engine));
  for(const [engine,key] of moving)this.keys.set(engine,key);
  if(old.size){try{await this.#run('readwrite',store=>{for(const [engine,key] of moving)store.put({id:this.scope+':'+engine,scope:this.scope,engine,key});});for(const engine of old.keys())this.legacy.drop(engine);}catch{/* kept in localStorage; tried again next time */}}
  return this;
 }
 load(){return new Map(this.keys);}
 save(engine,value){
  if(this.fallback){const key=this.legacy.save(engine,value);if(key)this.keys.set(engine,key);else this.keys.delete(engine);return key;}
  const key=validateKey(engine,value);if(key)this.keys.set(engine,key);else this.keys.delete(engine);
  this.touched.add(engine);
  const id=this.scope+':'+engine;
  // An old copy left in localStorage (a move that failed) is dropped too, so a cleared key cannot come back.
  this.writing=this.writing.then(()=>this.open()).then(()=>this.fallback?this.legacy.save(engine,key):this.#run('readwrite',store=>key?store.put({id,scope:this.scope,engine,key}):store.delete(id))).then(()=>{if(!this.fallback)this.legacy.drop(engine);}).catch(error=>{this.onError('密钥这次能用，但没有存进浏览器，刷新以后要重新填。'+storageFailure(error));});
  return key;
 }
 /** Resolves when every save so far has been written. */
 flush(){return this.writing;}
 close(){this.db?.close();this.db=null;}
 #watch(db){db.onversionchange=()=>{db.close();if(this.db===db)this.db=null;};db.onclose=()=>{if(this.db===db)this.db=null;};}
 // A dropped connection (iPhone Safari after the page sat in the background) is reopened once; nothing was written.
 async #run(mode,work){
  if(!this.db&&!this.fallback)await this.#reconnect().catch(()=>{});
  try{return await this.#once(mode,work);}
  catch(error){if(!connectionLost(error)&&this.db)throw error;try{this.db?.close();}catch{}this.db=null;await this.#reconnect();return this.#once(mode,work);}
 }
 #reconnect(){return new Promise((resolve,reject)=>{const req=this.factory.open(KEY_DB);req.onsuccess=()=>{const db=req.result;if(!db.objectStoreNames.contains(KEY_STORE)){db.close();reject(Error('密钥库没有打开'));return;}this.db=db;this.#watch(db);resolve(db);};req.onerror=()=>reject(req.error);req.onblocked=()=>reject(Error('blocked'));});}
 #once(mode,work){return new Promise((resolve,reject)=>{if(!this.db){reject(Error('密钥库没有打开'));return;}let tx,result;try{tx=this.db.transaction(KEY_STORE,mode);const r=work(tx.objectStore(KEY_STORE));if(r&&'onsuccess' in r)r.onsuccess=()=>{result=r.result;};}catch(error){reject(error);return;}tx.oncomplete=()=>resolve(result);tx.onabort=tx.onerror=()=>reject(tx.error);});}
}
