// A/B 截图：node scripts/_cdpab.mjs <url> <waitSec> <outPrefix> <jsBefore,jsAfter>
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const EDGE='C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const url=process.argv[2], wait=Number(process.argv[3]||40), out=process.argv[4];
const W=1600,H=900,PORT=9344;
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'edge-ab-'));
const child=spawn(EDGE,['--headless=new','--enable-unsafe-swiftshader','--use-angle=swiftshader','--hide-scrollbars','--no-first-run','--disable-extensions',`--window-size=${W},${H}`,`--remote-debugging-port=${PORT}`,`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let ws;
for(let i=0;i<60;i++){try{const r=await fetch(`http://127.0.0.1:${PORT}/json/list`);const l=await r.json();const p=l.find(t=>t.type==='page');if(p&&p.webSocketDebuggerUrl){ws=p.webSocketDebuggerUrl;break;}}catch(e){}await sleep(400);}
const sock=new WebSocket(ws); await new Promise(r=>sock.addEventListener('open',r));
let id=0; const pend=new Map();
sock.addEventListener('message',ev=>{let m;try{m=JSON.parse(ev.data)}catch(e){return}
 if(m.id&&pend.has(m.id)){const{res,rej}=pend.get(m.id);pend.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);}});
const send=(m,p={})=>new Promise((res,rej)=>{const i=++id;pend.set(i,{res,rej});sock.send(JSON.stringify({id:i,method:m,params:p}));setTimeout(()=>{if(pend.has(i)){pend.delete(i);rej(new Error('timeout '+m))}},180000)});
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride',{width:W,height:H,deviceScaleFactor:1,mobile:false});
await send('Network.enable'); await send('Network.setCacheDisabled',{cacheDisabled:true});
await send('Page.navigate',{url});
await sleep(wait*1000);
async function shot(tag){
  const s=await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(out+tag+'.png',Buffer.from(s.data,'base64'));
  console.log('SHOT '+out+tag+'.png');
}
await shot('_a');
const js=process.argv[5];
if(js){ await send('Runtime.evaluate',{expression:js}); await sleep(wait*0.7*1000); await shot('_b'); }
child.kill(); await sleep(300);
try{fs.rmSync(profile,{recursive:true,force:true})}catch(e){}
process.exit(0);
