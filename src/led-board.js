import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {ANIMATIONS} from './protocol.js';

export const LED_BOARD_SIZE=16;
export const LED_BOARD_STATES=Object.freeze([...ANIMATIONS]);
const PIXELS=LED_BOARD_SIZE*LED_BOARD_SIZE;
const STATE_COLORS={idle:'#f472b6',thinking:'#a78bfa',working:'#38bdf8',input:'#fbbf24',approval:'#fb923c',done:'#4ade80',error:'#f87171',sleep:'#818cf8'};
const GLYPHS={
  idle:['.A.A.','AAAAA','AAAAA','.AAA.','..A..','.....'],
  thinking:['.AAA.','....A','...A.','..A..','.....','..A..'],
  working:['...A.','..AA.','.AAA.','...A.','..A..','.A...'],
  input:['.....','.....','.....','A.A.A','.....','.....'],
  approval:['..A..','..A..','..A..','..A..','.....','..A..'],
  done:['.....','....A','...A.','A.A..','.A...','.....'],
  error:['A...A','.A.A.','..A..','..A..','.A.A.','A...A'],
  sleep:['AAAAA','...A.','..A..','.A...','A....','AAAAA'],
};

export function emptyLedPattern(){return Array(PIXELS).fill(null);}
export function normalizeLedState(state){return LED_BOARD_STATES.includes(state)?state:'idle';}

function color(value){
  if(value===null||value==='.'||value==='')return null;
  if(typeof value!=='string'||!/^#[0-9a-f]{6}$/i.test(value))throw new Error('图案颜色必须是 #RRGGBB');
  return value.toLowerCase();
}

export function normalizeLedPattern(value){
  if(!Array.isArray(value)||value.length!==PIXELS)throw new Error('灯板图案必须是 16×16');
  return value.map(color);
}

export function normalizeLedHost(value){
  const raw=String(value||'bottle.local').trim();
  let url;
  try{url=new URL(raw.includes('://')?raw:'http://'+raw);}catch{throw new Error('灯板地址无效');}
  if(url.protocol!=='http:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('灯板地址仅支持 http://主机[:端口]');
  return url.host;
}

export function createDefaultLedPatterns(){
  const patterns={};
  for(const state of LED_BOARD_STATES){
    const pixels=emptyLedPattern(),put=(x,y,value)=>{if(x>=0&&x<16&&y>=0&&y<16)pixels[y*16+x]=value;};
    for(let y=3;y<=14;y++)for(let x=1;x<=14;x++){
      const d=((x-7.5)/6.5)**2+((y-9)/5.5)**2;
      if(d<=1)put(x,y,d>.72?'#7c2d12':'#fbbf24');
    }
    for(const [x,y] of [[3,3],[4,2],[5,3],[10,3],[11,2],[12,3],[5,7],[10,7]])put(x,y,'#7c2d12');
    for(const [x,y] of [[5,8],[10,8]])put(x,y,'#292524');
    for(const [x,y] of [[7,10],[8,10]])put(x,y,'#f472b6');
    GLYPHS[state].forEach((row,y)=>[...row].forEach((cell,x)=>{if(cell==='A')put(x+11,y,STATE_COLORS[state]);}));
    patterns[state]=pixels;
  }
  return patterns;
}

export function defaultLedBoardConfig(){return {version:1,enabled:false,host:'bottle.local',patterns:createDefaultLedPatterns()};}
export function normalizeLedBoardConfig(value={}){
  const defaults=defaultLedBoardConfig(),patterns={};
  for(const state of LED_BOARD_STATES)patterns[state]=normalizeLedPattern(value.patterns?.[state]??defaults.patterns[state]);
  return {version:1,enabled:Boolean(value.enabled),host:normalizeLedHost(value.host),patterns};
}

export function encodeLedPattern(pattern){
  const pixels=normalizeLedPattern(pattern);
  return '1010'+pixels.map(value=>value?value.slice(1)+'ff':'00000000').join('');
}

export class LedBoardStore{
  constructor(dir){this.file=path.join(dir,'led-board.json');this.config=defaultLedBoardConfig();this.loadError=null;}
  async load(){
    try{this.config=normalizeLedBoardConfig(JSON.parse(await readFile(this.file,'utf8')));this.loadError=null;}
    catch(error){this.config=defaultLedBoardConfig();this.loadError=error.code==='ENOENT'?null:error.message;}
    return this.config;
  }
  async save(value){
    const config=normalizeLedBoardConfig(value),temp=this.file+'.tmp';
    await mkdir(path.dirname(this.file),{recursive:true});
    await writeFile(temp,JSON.stringify(config));await rename(temp,this.file);
    this.config=config;this.loadError=null;return config;
  }
}

export class LedBoard{
  constructor({dir,fetchImpl=globalThis.fetch,now=Date.now,retryMs=5000,timeoutMs=1500}={}){
    if(typeof fetchImpl!=='function')throw new Error('当前运行环境不支持网络请求');
    this.store=new LedBoardStore(dir);this.fetch=fetchImpl;this.now=now;this.retryMs=retryMs;this.timeoutMs=timeoutMs;
    this.state='idle';this.status={ok:null,error:null,lastSentState:null,updatedAt:null};this.lastKey=null;this.retryAt=0;this.revision=0;this.sending=null;this.queued=false;
  }
  async init(){await this.store.load();if(this.store.loadError)this.status={ok:false,error:'配置读取失败，已使用默认图案：'+this.store.loadError,lastSentState:null,updatedAt:this.now()};return this.snapshot();}
  snapshot(){return {...structuredClone(this.store.config),state:this.state,status:{...this.status},configError:this.store.loadError};}
  async request(route,body){
    const host=normalizeLedHost(this.store.config.host);
    const response=await this.fetch(`http://${host}${route}`,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:body??'',signal:AbortSignal.timeout(this.timeoutMs)});
    if(!response.ok)throw new Error(`灯板返回 HTTP ${response.status}`);
  }
  sync(state=this.state,{force=false}={}){
    this.state=normalizeLedState(state);
    if(!force&&!this.store.config.enabled)return Promise.resolve(this.snapshot());
    if(this.sending){this.queued=true;return this.sending;}
    const key=`${this.store.config.host}:${this.revision}:${this.state}`;
    if(!force&&key===this.lastKey||!force&&this.now()<this.retryAt)return Promise.resolve(this.snapshot());
    this.sending=this.runSync(key);return this.sending;
  }
  async runSync(key){
    const state=this.state;
    try{
      await this.request('/pattern',encodeLedPattern(this.store.config.patterns[state]));
      this.lastKey=key;this.retryAt=0;this.status={ok:true,error:null,lastSentState:state,updatedAt:this.now()};
    }catch(error){
      this.retryAt=this.now()+this.retryMs;this.status={ok:false,error:String(error?.message||error),lastSentState:this.status.lastSentState,updatedAt:this.now()};
    }finally{
      this.sending=null;
      if(this.queued){this.queued=false;return this.sync(this.state,{force:true});}
    }
    return this.snapshot();
  }
  async save(value){
    await this.store.save(value);this.revision++;this.lastKey=null;this.retryAt=0;
    if(!this.store.config.enabled)return this.clear();
    return this.sync(this.state,{force:true});
  }
  async clear(){
    if(this.sending){this.queued=false;await this.sending;}
    try{await this.request('/clear');this.lastKey=null;this.retryAt=0;this.status={ok:true,error:null,lastSentState:null,updatedAt:this.now()};}
    catch(error){this.status={ok:false,error:String(error?.message||error),lastSentState:this.status.lastSentState,updatedAt:this.now()};}
    return this.snapshot();
  }
}
