import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {LedBoard,LedBoardStore,LED_BOARD_STATES,createDefaultLedPatterns,defaultLedBoardConfig,emptyLedPattern,encodeLedPattern,normalizeLedHost} from '../src/led-board.js';

async function tempDir(t){const dir=await mkdtemp(path.join(tmpdir(),'lingpet-led-board-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
const ok=()=>({ok:true,status:200});

test('eight editable default patterns encode to the firmware 16x16 RGBA protocol',()=>{
  const patterns=createDefaultLedPatterns(),signatures=new Set();
  assert.deepEqual(Object.keys(patterns),LED_BOARD_STATES);
  for(const state of LED_BOARD_STATES){assert.equal(patterns[state].length,256);assert.equal(encodeLedPattern(patterns[state]).length,2052);signatures.add(encodeLedPattern(patterns[state]));}
  assert.equal(signatures.size,8);
  const pixels=emptyLedPattern();pixels[0]='#ABCDEF';
  assert.ok(encodeLedPattern(pixels).startsWith('1010abcdefff00000000'));
});

test('host and pixel validation reject malformed device configuration',()=>{
  assert.equal(normalizeLedHost('bottle.local'),'bottle.local');
  assert.equal(normalizeLedHost('http://192.168.1.8:8080/'),'192.168.1.8:8080');
  assert.throws(()=>normalizeLedHost('https://bottle.local'),/仅支持/);
  assert.throws(()=>normalizeLedHost('bottle.local/admin'),/仅支持/);
  assert.throws(()=>encodeLedPattern([null]),/16×16/);
  assert.throws(()=>encodeLedPattern(Array(256).fill('red')),/#RRGGBB/);
});

test('configuration persists independently in led-board.json',async t=>{
  const dir=await tempDir(t),store=new LedBoardStore(dir),config=defaultLedBoardConfig();
  config.enabled=true;config.host='127.0.0.1:8080';config.patterns.working[0]='#123456';
  await store.save(config);
  const restored=new LedBoardStore(dir);await restored.load();
  assert.equal(restored.config.enabled,true);assert.equal(restored.config.host,'127.0.0.1:8080');assert.equal(restored.config.patterns.working[0],'#123456');
  assert.equal(path.basename(restored.file),'led-board.json');
});

test('state changes are sent once and unsupported states fall back to idle',async t=>{
  const dir=await tempDir(t),calls=[];
  const board=new LedBoard({dir,fetchImpl:async(url,options)=>{calls.push({url,options});return ok();}});
  await board.init();const config=defaultLedBoardConfig();config.enabled=true;
  await board.save(config);assert.equal(calls.length,1);
  await board.sync('idle');assert.equal(calls.length,1);
  await board.sync('working');assert.equal(calls.length,2);
  assert.equal(calls[1].options.body,encodeLedPattern(config.patterns.working));
  await board.sync('interrupted');assert.equal(calls.length,3);assert.equal(board.snapshot().state,'idle');
});

test('network failures are contained and retried after backoff',async t=>{
  const dir=await tempDir(t);let now=1000,calls=0;
  const board=new LedBoard({dir,now:()=>now,retryMs:5000,fetchImpl:async()=>{calls++;throw new Error('offline');}});
  await board.init();const config=defaultLedBoardConfig();config.enabled=true;
  await board.save(config);assert.equal(calls,1);assert.equal(board.snapshot().status.ok,false);
  await board.sync('idle');assert.equal(calls,1);
  now+=5001;await board.sync('idle');assert.equal(calls,2);
});

test('a state arriving during an active request is queued and sent',async t=>{
  const dir=await tempDir(t),states=[];let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const board=new LedBoard({dir,fetchImpl:async(_url,options)=>{states.push(options.body);if(states.length===1)await gate;return ok();}});
  await board.init();const config=defaultLedBoardConfig();config.enabled=true;await board.store.save(config);
  const first=board.sync('thinking');await new Promise(resolve=>setImmediate(resolve));
  const second=board.sync('working');release();await Promise.all([first,second]);
  assert.equal(states.length,2);assert.equal(states[1],encodeLedPattern(config.patterns.working));assert.equal(board.snapshot().status.lastSentState,'working');
});

test('real HTTP requests reach pattern and clear endpoints with valid payloads',async t=>{
  const dir=await tempDir(t),requests=[];
  const server=createServer((req,res)=>{let body='';req.on('data',chunk=>{body+=chunk;});req.on('end',()=>{requests.push({url:req.url,body});res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');});});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const config=defaultLedBoardConfig();config.enabled=true;config.host=`127.0.0.1:${server.address().port}`;
  const board=new LedBoard({dir});await board.init();await board.save(config);await board.sync('approval');await board.clear();
  assert.deepEqual(requests.map(r=>r.url),['/pattern','/pattern','/clear']);
  assert.equal(requests[0].body.length,2052);assert.ok(requests[0].body.startsWith('1010'));assert.equal(requests[1].body,encodeLedPattern(config.patterns.approval));
});
