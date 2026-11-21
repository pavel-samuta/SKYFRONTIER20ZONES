'use strict';
// SKY FRONTIER multiplayer relay prototype. Node.js 18+, no npm dependencies.
// Movement is server-validated for maximum speed; economy and hits are local MVP state.
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const PORT = Number(process.env.PORT || 3000);
const clients = new Map();
let nextId = 1;
const world = { width: 8000, height: 4800 };

function send(c, obj) {
  if (!c || c.socket.destroyed) return;
  const payload = Buffer.from(JSON.stringify(obj));
  let header;
  if (payload.length < 126) {header = Buffer.from([0x81, payload.length]);}
  else if (payload.length < 65536) {header = Buffer.alloc(4);header[0]=0x81;header[1]=126;header.writeUInt16BE(payload.length,2);}
  else {header=Buffer.alloc(10);header[0]=0x81;header[1]=127;header.writeBigUInt64BE(BigInt(payload.length),2);}
  c.socket.write(Buffer.concat([header,payload]));
}
function broadcast(obj, excludeId) {for(const c of clients.values()) if(c.id!==excludeId)send(c,obj);}
function parseFrames(c, incoming) {
  c.buffer = Buffer.concat([c.buffer,incoming]);
  while(c.buffer.length >= 2) {
    const b=c.buffer, opcode=b[0]&0x0f, masked=!!(b[1]&0x80);
    let len=b[1]&0x7f,offset=2;
    if(len===126){if(b.length<4)return;len=b.readUInt16BE(2);offset=4;}
    else if(len===127){if(b.length<10)return;const big=b.readBigUInt64BE(2);if(big>65536n){c.socket.destroy();return;}len=Number(big);offset=10;}
    if(!masked){c.socket.destroy();return;}
    if(len>8192){c.socket.destroy();return;}
    if(b.length<offset+4+len)return;
    const mask=b.subarray(offset,offset+4);offset+=4;
    const data=Buffer.from(b.subarray(offset,offset+len));
    for(let i=0;i<data.length;i++)data[i]^=mask[i%4];
    c.buffer=b.subarray(offset+len);
    if(opcode===8){c.socket.end(Buffer.from([0x88,0x00]));return;}
    if(opcode===9){c.socket.write(Buffer.from([0x8A,0x00]));continue;}
    if(opcode!==1)continue;
    let msg;try{msg=JSON.parse(data.toString('utf8'));}catch{continue;}
    handle(c,msg);
  }
}
function valid(v){return typeof v==='number'&&Number.isFinite(v);}
function handle(c,m){
  if(!m||typeof m!=='object')return;
  if(m.type==='join'){
    c.player.name=String(m.name||'PILOT').slice(0,18).replace(/[<>]/g,'');
    send(c,{type:'welcome',id:c.id,players:[...clients.values()].map(x=>({id:x.id,...x.player}))});
  } else if(m.type==='state'){
    if(![m.x,m.y,m.heading,m.speed,m.alt,m.hp].every(valid))return;
    if(m.x<0||m.x>world.width||m.y<0||m.y>world.height)return;
    const now=Date.now(),dt=Math.max(.05,(now-c.lastTime)/1000),step=Math.hypot(m.x-c.player.x,m.y-c.player.y);
    // Allow first position and bursts following transient network delays.
    if(c.hasState&&step>Math.max(125,dt*520+70))return;
    c.player.x=m.x;c.player.y=m.y;c.player.heading=m.heading;
    c.player.speed=Math.max(0,Math.min(500,m.speed));
    c.player.alt=Math.max(0,Math.min(1600,m.alt));
    c.player.hp=Math.max(0,Math.min(150,m.hp));
    c.lastTime=now;c.hasState=true;
  } else if(m.type==='shot'){
    if(![m.x,m.y,m.vx,m.vy].every(valid))return;
    if(Math.hypot(m.x-c.player.x,m.y-c.player.y)>160)return;
    const now=Date.now();if(now-c.lastShot<90)return;c.lastShot=now;
    broadcast({type:'shot',id:c.id,x:m.x,y:m.y,vx:Math.max(-1100,Math.min(1100,m.vx)),vy:Math.max(-1100,Math.min(1100,m.vy))},c.id);
  }
}
const server=http.createServer((req,res)=>{
  const url=(req.url||'/').split('?')[0];
  if(url!=='/'&&url!=='/index.html'&&url!=='/health') {res.writeHead(404);res.end('Not found');return;}
  if(url==='/health'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,players:clients.size}));return;}
  fs.readFile(path.join(__dirname,'index.html'),(err,data)=>{
    if(err){res.writeHead(500);res.end('Missing index.html');return;}
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(data);
  });
});
server.on('upgrade',(req,socket)=>{
  if(req.url!=='/ws'||req.headers.upgrade?.toLowerCase()!=='websocket'||!req.headers['sec-websocket-key']){socket.destroy();return;}
  if(clients.size>=100){socket.destroy();return;}
  const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  const id=String(nextId++);
  const c={id,socket,buffer:Buffer.alloc(0),lastTime:Date.now(),lastShot:0,hasState:false,player:{name:'PILOT',x:800,y:600,heading:-1.57,speed:0,alt:250,hp:100}};
  clients.set(id,c);
  socket.on('data',b=>{try{parseFrames(c,b)}catch{socket.destroy()}});
  socket.on('error',()=>{});
  socket.on('close',()=>clients.delete(id));
  socket.setTimeout(180000,()=>socket.destroy());
});
setInterval(()=>{
  const players=[...clients.values()].map(c=>({id:c.id,...c.player}));
  for(const c of clients.values())send(c,{type:'snapshot',players});
},100);
server.listen(PORT,'0.0.0.0',()=>console.log(`SKY FRONTIER → http://localhost:${PORT} | WebSocket /ws`));