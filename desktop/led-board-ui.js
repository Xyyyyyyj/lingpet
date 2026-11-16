import {navigate} from './navigation.js';

const $=id=>document.getElementById(id);
const labels={idle:'空闲',thinking:'处理中',working:'执行工具',input:'等待输入',approval:'等待批准',done:'本轮完成',error:'出错',sleep:'休眠'};
const states=Object.keys(labels),canvas=$('boardCanvas'),ctx=canvas.getContext('2d');
let config=await window.pet.board({action:'get'}),selected='idle',liveState=config.state,status=config.status;
let drawing=false,strokeErase=false,dirty=false,pending=0,saveQueue=Promise.resolve();
$('openLedBoard').onclick=()=>navigate('ledBoard');

for(const state of states){
  const button=document.createElement('button');button.type='button';button.dataset.boardState=state;button.setAttribute('role','tab');
  button.onclick=()=>{selected=state;draw();renderStates();};$('boardStates').append(button);
}
function renderStates(){
  for(const button of document.querySelectorAll('[data-board-state]')){
    const state=button.dataset.boardState,active=state===selected,live=state===liveState;
    button.textContent=labels[state]+(live?' · 当前':'');button.classList.toggle('selected',active);button.classList.toggle('live',live);
    button.setAttribute('aria-selected',String(active));
  }
}
function draw(){
  const pixels=config.patterns[selected],cell=canvas.width/16;ctx.clearRect(0,0,canvas.width,canvas.height);
  for(let y=0;y<16;y++)for(let x=0;x<16;x++){
    const value=pixels[y*16+x];ctx.fillStyle=value||((x+y)%2?'#172c31':'#1d3439');ctx.fillRect(x*cell,y*cell,cell,cell);
    ctx.strokeStyle='#ffffff12';ctx.strokeRect(x*cell+.5,y*cell+.5,cell-1,cell-1);
  }
  $('boardEditing').textContent=`正在编辑：${labels[selected]}`;
}
function renderStatus(){
  $('boardEnabled').checked=config.enabled;
  if(document.activeElement!==$('boardHost'))$('boardHost').value=config.host;
  let text='启用后自动跟随当前桌宠状态。';
  if(pending)text='正在保存图案与设置…';
  else if(status?.error)text=`设置已保留；灯板连接失败：${status.error}`;
  else if(!config.enabled&&status?.ok)text='输出已关闭，灯板已恢复流水。';
  else if(status?.ok&&status.lastSentState)text=`连接正常，已发送「${labels[status.lastSentState]}」。`;
  $('boardStatus').textContent=text;$('boardStatus').classList.toggle('error',Boolean(status?.error));
  $('boardLive').textContent=`实时状态：${labels[liveState]||'空闲'}`;
  renderStates();
}
function persist(){
  const value=structuredClone({version:1,enabled:config.enabled,host:$('boardHost').value.trim(),patterns:config.patterns});
  config.host=value.host;pending++;renderStatus();
  saveQueue=saveQueue.catch(()=>{}).then(()=>window.pet.board({action:'save',value})).then(result=>{
    config.enabled=result.enabled;config.host=result.host;status=result.status;
  }).catch(error=>{status={ok:false,error:error.message};}).finally(()=>{pending--;renderStatus();});
  return saveQueue;
}
function paint(event){
  const bounds=canvas.getBoundingClientRect(),x=Math.floor((event.clientX-bounds.left)/bounds.width*16),y=Math.floor((event.clientY-bounds.top)/bounds.height*16);
  if(x<0||x>=16||y<0||y>=16)return;
  const value=strokeErase?null:$('boardColor').value,index=y*16+x;
  if(config.patterns[selected][index]===value)return;
  config.patterns[selected][index]=value;dirty=true;draw();
}
canvas.addEventListener('contextmenu',event=>event.preventDefault());
canvas.addEventListener('pointerdown',event=>{
  if(event.button!==0&&event.button!==2)return;event.preventDefault();drawing=true;dirty=false;strokeErase=event.button===2||$('boardErase').checked;
  canvas.setPointerCapture(event.pointerId);paint(event);
});
canvas.addEventListener('pointermove',event=>{if(drawing)paint(event);});
async function finishStroke(){if(!drawing)return;drawing=false;if(dirty)await persist();}
canvas.addEventListener('pointerup',finishStroke);canvas.addEventListener('pointercancel',finishStroke);
$('boardEnabled').onchange=()=>{config.enabled=$('boardEnabled').checked;void persist();};
$('boardSaveHost').onclick=()=>void persist();
$('boardHost').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();void persist();}});
$('boardClearState').onclick=()=>{
  if(!confirm(`清空「${labels[selected]}」图案？`))return;
  config.patterns[selected]=Array(256).fill(null);draw();void persist();
};
$('boardTest').onclick=async()=>{
  await saveQueue;const result=await window.pet.board({action:'test',state:selected});status=result.status;renderStatus();
};
$('boardClear').onclick=async()=>{
  await saveQueue;const result=await window.pet.board({action:'clear'});config.enabled=result.enabled;status=result.status;renderStatus();
};
window.pet.onUpdate(value=>{liveState=labels[value.current.state]?value.current.state:'idle';renderStates();});
setInterval(async()=>{
  if(document.body.dataset.page!=='ledBoard'||pending||drawing)return;
  try{const result=await window.pet.board({action:'get'});status=result.status;liveState=result.state;config.enabled=result.enabled;config.host=result.host;renderStatus();}catch{}
},2000);
draw();renderStatus();
