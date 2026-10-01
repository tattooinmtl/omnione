// Local-stub templates. The OmniOne Local provider has no key and no real model,
// so when a real provider isn't available we still want the harness to *do*
// something useful with the prompt. Each template emits a working
// multi-file (or single-file) project that the harness parser can pick up.
//
// Templates are selected by simple keyword matching against the prompt. The
// matcher runs in declared order — first match wins — so order templates
// from most specific (e.g. "asteroid shooter") to most general.
//
// All templates use vanilla HTML/CSS/JS, no build step, no npm. Three.js
// is the default and only loads if a template asks for it. Templates stay
// small enough to fit in a single string per file.

const wrap = (id, title, body) => `<!-- FILE: index.html -->
<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="style.css"></head>
<body><div id="app">${body}</div><script src="main.js"></script></body></html>
`;

const style = (css) => `<!-- FILE: style.css -->
${css}
`;

const main = (js) => `<!-- FILE: main.js -->
${js}
`;

const emit = (html, css, js) => html + style(css) + main(js);

// --------------------------------------------------------------------------
// Snake
// --------------------------------------------------------------------------
function snake() {
  const html = wrap('Snake', 'Snake', '<canvas id="g" width="400" height="400"></canvas><div id="hud">Score: <span id="s">0</span> · High: <span id="hi">0</span></div><div class="hint">Arrow keys or WASD · R to restart</div>');
  const css = `html,body{margin:0;height:100%;background:#050810;color:#e6edf3;font-family:system-ui;display:flex;align-items:center;justify-content:center}
#app{display:flex;flex-direction:column;align-items:center;gap:10px}
canvas{background:#0a1020;border:1px solid #2f7bff;box-shadow:0 0 24px rgba(47,123,255,.35)}
#hud{font-family:ui-monospace,Consolas,monospace;letter-spacing:.05em}
.hint{opacity:.6;font-size:12px}`;
  const js = `const c=document.getElementById('g'),x=c.getContext('2d');
const W=c.width,H=c.height,CELL=20,COLS=W/CELL,ROWS=H/CELL;
let snake,dir,nextDir,food,score,dead=false,last=0;
const hiEl=document.getElementById('hi');
let hi=+localStorage.getItem('snakeHi')||0;hiEl.textContent=hi;
function reset(){snake=[{x:10,y:10},{x:9,y:10},{x:8,y:10}];dir={x:1,y:0};nextDir=dir;placeFood();score=0;dead=false;document.getElementById('s').textContent=score}
function placeFood(){while(true){const f={x:Math.floor(Math.random()*COLS),y:Math.floor(Math.random()*ROWS)};if(!snake.some(s=>s.x===f.x&&s.y===f.y)){food=f;return}}}
function step(){if(dead)return;dir=nextDir;const head={x:snake[0].x+dir.x,y:snake[0].y+dir.y};if(head.x<0||head.y<0||head.x>=COLS||head.y>=ROWS||snake.some(s=>s.x===head.x&&s.y===head.y)){dead=true;if(score>hi){hi=score;localStorage.setItem('snakeHi',hi);hiEl.textContent=hi}return}snake.unshift(head);if(head.x===food.x&&head.y===food.y){score++;document.getElementById('s').textContent=score;placeFood()}else snake.pop()}
function draw(){x.fillStyle='#0a1020';x.fillRect(0,0,W,H);x.fillStyle='#ff2d2d';x.fillRect(food.x*CELL+2,food.y*CELL+2,CELL-4,CELL-4);snake.forEach((s,i)=>{x.fillStyle=i?'#2f7bff':'#5af';x.fillRect(s.x*CELL+1,s.y*CELL+1,CELL-2,CELL-2)});if(dead){x.fillStyle='rgba(255,45,45,.85)';x.font='bold 36px system-ui';x.textAlign='center';x.fillText('GAME OVER',W/2,H/2);x.font='14px system-ui';x.fillText('Press R to restart',W/2,H/2+24)}}
function loop(t){if(t-last>=100){step();last=t}draw();requestAnimationFrame(loop)}
document.addEventListener('keydown',e=>{const k=e.key.toLowerCase();if((k==='arrowup'||k==='w')&&dir.y!==1)nextDir={x:0,y:-1};else if((k==='arrowdown'||k==='s')&&dir.y!==-1)nextDir={x:0,y:1};else if((k==='arrowleft'||k==='a')&&dir.x!==1)nextDir={x:-1,y:0};else if((k==='arrowright'||k==='d')&&dir.x!==-1)nextDir={x:1,y:0};else if(k==='r')reset();e.preventDefault()});
reset();requestAnimationFrame(loop);`;
  return { id: 'snake', text: emit(html, css, js) };
}

// --------------------------------------------------------------------------
// Asteroids (HTML5 canvas, no Three.js so the stub works offline too)
// --------------------------------------------------------------------------
function asteroids() {
  const html = wrap('Asteroids', 'Asteroids', '<canvas id="g" width="640" height="480"></canvas><div id="hud">Score: <span id="s">0</span> · Lives: <span id="l">3</span></div><div class="hint">← → turn · ↑ thrust · Space fire</div>');
  const css = `html,body{margin:0;height:100%;background:#000;color:#e6edf3;font-family:system-ui;display:flex;align-items:center;justify-content:center}
#app{display:flex;flex-direction:column;align-items:center;gap:8px}
canvas{background:#000;border:1px solid #2f7bff;box-shadow:0 0 24px rgba(47,123,255,.25)}
#hud{font-family:ui-monospace,Consolas,monospace;letter-spacing:.1em}
.hint{opacity:.6;font-size:12px}`;
  const js = `const c=document.getElementById('g'),x=c.getContext('2d');
const W=c.width,H=c.height;
let ship,bullets,rocks,score,lives,keys={},last=0,spawn=0;
function reset(){ship={x:W/2,y:H/2,a:-Math.PI/2,vx:0,vy:0};bullets=[];rocks=[];for(let i=0;i<5;i++)spawnRock();score=0;lives=3;document.getElementById('s').textContent=score;document.getElementById('l').textContent=lives}
function spawnRock(){const r=24+Math.random()*24;const a=Math.random()*Math.PI*2;const m=Math.random()<.4?1:0;rocks.push({x:Math.random()*W,y:Math.random()*H,vx:Math.cos(a)*(1+Math.random()*1.5),vy:Math.sin(a)*(1+Math.random()*1.5),r,size:m,age:0})}
function split(p){if(p.size===2){for(let i=0;i<2;i++){const a=Math.random()*Math.PI*2;rocks.push({x:p.x,y:p.y,vx:Math.cos(a)*2,vy:Math.sin(a)*2,r:p.r/2,size:1,age:0})}}}
document.addEventListener('keydown',e=>{keys[e.key.toLowerCase()]=true;if(e.key===' '&&!e.repeat)fire();e.preventDefault()});
document.addEventListener('keyup',e=>{keys[e.key.toLowerCase()]=false});
function fire(){bullets.push({x:ship.x,y:ship.y,vx:Math.cos(ship.a)*6,vy:Math.sin(ship.a)*6,life:60})}
function step(dt){if(keys['arrowleft'])ship.a-=.04;if(keys['arrowright'])ship.a+=.04;if(keys['arrowup']){ship.vx+=Math.cos(ship.a)*.12;ship.vy+=Math.sin(ship.a)*.12}const sp=Math.hypot(ship.vx,ship.vy);if(sp>5){ship.vx=ship.vx/sp*5;ship.vy=ship.vy/sp*5}ship.x+=ship.vx;ship.y+=ship.vy;if(ship.x<0)ship.x=W;if(ship.x>W)ship.x=0;if(ship.y<0)ship.y=H;if(ship.y>H)ship.y=0;bullets.forEach(b=>{b.x+=b.vx;b.y+=b.vy;b.life--});bullets=bullets.filter(b=>b.life>0&&b.x>=0&&b.x<=W&&b.y>=0&&b.y<=H);rocks.forEach(r=>{r.x+=r.vx;r.y+=r.vy;r.age++;if(r.x<0)r.x=W;if(r.x>W)r.x=0;if(r.y<0)r.y=H;if(r.y>H)r.y=0});for(let i=bullets.length-1;i>=0;i--){for(let j=rocks.length-1;j>=0;j--){const r=rocks[j],b=bullets[i];if(Math.hypot(b.x-r.x,b.y-r.y)<r.r){split(r);rocks.splice(j,1);bullets.splice(i,1);score+=r.size===0?50:20;document.getElementById('s').textContent=score;break}}}spawn+=dt;if(spawn>2000){spawnRock();spawn=0}if(rocks.length<3)spawnRock();for(let i=rocks.length-1;i>=0;i--){const r=rocks[i];if(Math.hypot(ship.x-r.x,ship.y-r.y)<r.r+8){lives--;document.getElementById('l').textContent=lives;rocks.splice(i,1);if(lives<=0){reset();return}}}}
function draw(){x.fillStyle='rgba(0,0,0,.4)';x.fillRect(0,0,W,H);x.strokeStyle='#fff';x.lineWidth=2;x.beginPath();x.moveTo(ship.x+Math.cos(ship.a)*14,ship.y+Math.sin(ship.a)*14);x.lineTo(ship.x+Math.cos(ship.a+2.5)*10,ship.y+Math.sin(ship.a+2.5)*10);x.lineTo(ship.x+Math.cos(ship.a-2.5)*10,ship.y+Math.sin(ship.a-2.5)*10);x.closePath();x.stroke();x.fillStyle='#ff2d2d';bullets.forEach(b=>{x.fillRect(b.x-2,b.y-2,4,4)});rocks.forEach(r=>{x.strokeStyle='#888';x.lineWidth=1.5;x.beginPath();x.arc(r.x,r.y,r.r,0,Math.PI*2);x.stroke()})}
function loop(t){const dt=t-last;last=t;step(dt);draw();requestAnimationFrame(loop)}
reset();requestAnimationFrame(loop);`;
  return { id: 'asteroids', text: emit(html, css, js) };
}

// --------------------------------------------------------------------------
// Tetris
// --------------------------------------------------------------------------
function tetris() {
  const html = wrap('Tetris', 'Tetris', '<canvas id="g" width="240" height="480"></canvas><div id="hud">Score: <span id="s">0</span></div><div class="hint">← → move · ↓ soft · ↑ rotate · Space hard drop</div>');
  const css = `html,body{margin:0;height:100%;background:#050810;color:#e6edf3;font-family:system-ui;display:flex;align-items:center;justify-content:center}
#app{display:flex;flex-direction:column;align-items:center;gap:10px}
canvas{background:#0a1020;border:1px solid #2f7bff;box-shadow:0 0 24px rgba(47,123,255,.3)}
#hud{font-family:ui-monospace,Consolas,monospace}
.hint{opacity:.6;font-size:12px}`;
  const js = `const c=document.getElementById('g'),x=c.getContext('2d');
const W=10,H=20,CELL=24,cW=W*CELL,cH=H*CELL;
c.width=cW;c.height=cH;
const COLORS=['#000','#2f7bff','#ff2d2d','#5af','#ffd23f','#a0f','#0fa','#f80'];
const SHAPES={
  I:[[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]],
  O:[[2,2],[2,2]],
  T:[[0,3,0],[3,3,3],[0,0,0]],
  S:[[0,4,4],[4,4,0],[0,0,0]],
  Z:[[5,5,0],[0,5,5],[0,0,0]],
  J:[[6,0,0],[6,6,6],[0,0,0]],
  L:[[0,0,7],[7,7,7],[0,0,0]],
};
let board,cur,score=0,last=0,drop=600,over=false;
function newPiece(){const keys=Object.keys(SHAPES);const k=keys[Math.floor(Math.random()*keys.length)];return{k,shape:SHAPES[k].map(r=>r.slice()),x:Math.floor(W/2)-2,y:0}}
function reset(){board=Array.from({length:H},()=>Array(W).fill(0));cur=newPiece();score=0;over=false;document.getElementById('s').textContent=score}
function collide(p,dx,dy,shape){for(let r=0;r<shape.length;r++)for(let cc=0;cc<shape[r].length;cc++)if(shape[r][cc]){const nx=p.x+cc+dx,ny=p.y+r+dy;if(nx<0||nx>=W||ny>=H||(ny>=0&&board[ny][nx]))return true}return false}
function merge(p,shape){shape.forEach((row,r)=>row.forEach((v,cc)=>{if(v&&p.y+r>=0)board[p.y+r][p.x+cc]=v}))}
function rotate(s){const n=s.length;const r=Array.from({length:n},()=>Array(n).fill(0));for(let i=0;i<n;i++)for(let j=0;j<n;j++)r[j][n-1-i]=s[i][j];return r}
function clearLines(){let cleared=0;for(let r=H-1;r>=0;r--){if(board[r].every(v=>v)){board.splice(r,1);board.unshift(Array(W).fill(0));cleared++;r++}}if(cleared){score+=[0,40,100,300,1200][cleared];document.getElementById('s').textContent=score}}
function step(){if(over)return;if(!collide(cur,0,1,cur.shape)){cur.y++}else{merge(cur,cur.shape);clearLines();cur=newPiece();if(collide(cur,0,0,cur.shape)){over=true}}}
function dropHard(){while(!collide(cur,0,1,cur.shape))cur.y++;step()}
document.addEventListener('keydown',e=>{if(over){reset();e.preventDefault();return}const k=e.key;if(k==='ArrowLeft'&&!collide(cur,-1,0,cur.shape))cur.x--;else if(k==='ArrowRight'&&!collide(cur,1,0,cur.shape))cur.x++;else if(k==='ArrowDown')step();else if(k==='ArrowUp'){const r=rotate(cur.shape);if(!collide(cur,0,0,r))cur.shape=r}else if(k===' '){dropHard()}e.preventDefault()});
function draw(){x.fillStyle='#0a1020';x.fillRect(0,0,cW,cH);for(let r=0;r<H;r++)for(let cc=0;cc<W;cc++)if(board[r][cc]){x.fillStyle=COLORS[board[r][cc]];x.fillRect(cc*CELL+1,r*CELL+1,CELL-2,CELL-2)}cur.shape.forEach((row,r)=>row.forEach((v,cc)=>{if(v){x.fillStyle=COLORS[v];x.fillRect((cur.x+cc)*CELL+1,(cur.y+r)*CELL+1,CELL-2,CELL-2)}}));if(over){x.fillStyle='rgba(255,45,45,.9)';x.font='bold 24px system-ui';x.textAlign='center';x.fillText('GAME OVER',cW/2,cH/2)}}
function loop(t){if(t-last>=drop){step();last=t}draw();requestAnimationFrame(loop)}
reset();requestAnimationFrame(loop);`;
  return { id: 'tetris', text: emit(html, css, js) };
}

// --------------------------------------------------------------------------
// Pong
// --------------------------------------------------------------------------
function pong() {
  const html = wrap('Pong', 'Pong', '<canvas id="g" width="640" height="360"></canvas><div id="hud"><span id="l">0</span> : <span id="r">0</span></div><div class="hint">W/S — left · ↑/↓ — right</div>');
  const css = `html,body{margin:0;height:100%;background:#000;color:#e6edf3;font-family:system-ui;display:flex;align-items:center;justify-content:center}
#app{display:flex;flex-direction:column;align-items:center;gap:10px}
canvas{background:#000;border:1px solid #2f7bff;box-shadow:0 0 24px rgba(47,123,255,.3)}
#hud{font-family:ui-monospace,Consolas,monospace;font-size:24px;letter-spacing:.4em}
.hint{opacity:.6;font-size:12px}`;
  const js = `const c=document.getElementById('g'),x=c.getContext('2d');
const W=c.width,H=c.height;
let p1={x:20,y:H/2-40,vy:0},p2={x:W-30,y:H/2-40,vy:0},b={x:W/2,y:H/2,vx:4,vy:3},s1=0,s2=0,keys={},last=0;
function reset(bx,by){b.x=W/2;b.y=H/2;b.vx=bx;b.vy=by}
function step(){if(keys['w'])p1.vy=-6;else if(keys['s'])p1.vy=6;else p1.vy*=.6;if(keys['arrowup'])p2.vy=-6;else if(keys['arrowdown'])p2.vy=6;else p2.vy*=.6;p1.y+=p1.vy;p2.y+=p2.vy;p1.y=Math.max(0,Math.min(H-80,p1.y));p2.y=Math.max(0,Math.min(H-80,p2.y));b.x+=b.vx;b.y+=b.vy;if(b.y<6||b.y>H-6)b.vy*=-1;if(b.x<p1.x+10&&b.x>p1.x&&b.y>p1.y&&b.y<p1.y+80){b.vx=Math.abs(b.vx)*1.05;b.vy+=(b.y-(p1.y+40))*.15}if(b.x>p2.x-10&&b.x<p2.x+10&&b.y>p2.y&&b.y<p2.y+80){b.vx=-Math.abs(b.vx)*1.05;b.vy+=(b.y-(p2.y+40))*.15}if(b.x<0){s2++;document.getElementById('r').textContent=s2;reset(4,3)}if(b.x>W){s1++;document.getElementById('l').textContent=s1;reset(-4,3)}}
document.addEventListener('keydown',e=>{keys[e.key.toLowerCase()]=true;e.preventDefault()});
document.addEventListener('keyup',e=>{keys[e.key.toLowerCase()]=false});
function draw(){x.fillStyle='#000';x.fillRect(0,0,W,H);x.fillStyle='#2f7bff';x.fillRect(p1.x,p1.y,10,80);x.fillRect(p2.x,p2.y,10,80);x.fillStyle='#fff';x.beginPath();x.arc(b.x,b.y,6,0,Math.PI*2);x.fill()}
function loop(t){if(t-last>=16){step();last=t}draw();requestAnimationFrame(loop)}
reset(4,3);requestAnimationFrame(loop);`;
  return { id: 'pong', text: emit(html, css, js) };
}

// --------------------------------------------------------------------------
// Bouncing ball
// --------------------------------------------------------------------------
function bouncing() {
  const html = wrap('Bounce', 'Bouncing Balls', '<canvas id="g" width="640" height="360"></canvas><div id="hud"><span id="n">0</span> balls</div><div class="hint">Click to spawn a ball</div>');
  const css = `html,body{margin:0;height:100%;background:#050810;color:#e6edf3;font-family:system-ui;display:flex;align-items:center;justify-content:center}
#app{display:flex;flex-direction:column;align-items:center;gap:10px}
canvas{background:#0a1020;border:1px solid #2f7bff}
#hud{font-family:ui-monospace,Consolas,monospace}
.hint{opacity:.6;font-size:12px}`;
  const js = `const c=document.getElementById('g'),x=c.getContext('2d');
const W=c.width,H=c.height;const balls=[];let n=0;
function spawn(x0,y0){balls.push({x:x0,y:y0,vx:(Math.random()-.5)*8,vy:(Math.random()-.5)*8,r:6+Math.random()*16,c:'hsl('+Math.random()*360+',80%,60%)'});document.getElementById('n').textContent=balls.length}
c.addEventListener('click',e=>{const r=c.getBoundingClientRect();spawn((e.clientX-r.left)*(W/r.width),(e.clientY-r.top)*(H/r.height))});
function step(){x.fillStyle='rgba(10,16,32,.4)';x.fillRect(0,0,W,H);balls.forEach(b=>{b.x+=b.vx;b.y+=b.vy;if(b.x<b.r){b.x=b.r;b.vx*=-1}if(b.x>W-b.r){b.x=W-b.r;b.vx*=-1}if(b.y<b.r){b.y=b.r;b.vy*=-1}if(b.y>H-b.r){b.y=H-b.r;b.vy*=-1}x.fillStyle=b.c;x.beginPath();x.arc(b.x,b.y,b.r,0,Math.PI*2);x.fill()})}
function loop(){step();requestAnimationFrame(loop)}
for(let i=0;i<5;i++)spawn(W/2,H/2);requestAnimationFrame(loop);`;
  return { id: 'bouncing', text: emit(html, css, js) };
}

// --------------------------------------------------------------------------
// Todo
// --------------------------------------------------------------------------
function todo() {
  const html = wrap('Todo', 'Todo', '<h1>tasks</h1><form id="f"><input id="i" placeholder="what needs doing?" autocomplete="off"><button>add</button></form><ul id="l"></ul>');
  const css = `html,body{margin:0;height:100%;background:#050810;color:#e6edf3;font-family:system-ui;display:flex;align-items:flex-start;justify-content:center;padding-top:8vh}
#app{width:min(420px,90vw)}
h1{font-family:ui-monospace,Consolas,monospace;letter-spacing:.2em;font-size:18px;color:#2f7bff;margin:0 0 16px}
#f{display:flex;gap:8px;margin-bottom:16px}
#f input{flex:1;background:#0a1020;border:1px solid #2f7bff;color:#e6edf3;padding:8px 10px;font:inherit;border-radius:2px;outline:none}
#f input:focus{box-shadow:0 0 0 1px #2f7bff}
#f button{background:#2f7bff;color:#000;border:0;padding:0 14px;cursor:pointer;font:inherit;border-radius:2px}
#f button:hover{filter:brightness(1.1)}
ul{list-style:none;padding:0;margin:0}
li{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid #1a2238;border-radius:2px;margin-bottom:6px;background:rgba(47,123,255,.04)}
li.done span{text-decoration:line-through;opacity:.5}
li span{flex:1}
li button{background:transparent;border:0;color:#ff2d2d;cursor:pointer;font-size:14px;opacity:.6}
li button:hover{opacity:1}`;
  const js = `const f=document.getElementById('f'),i=document.getElementById('i'),l=document.getElementById('l');
const KEY='gwn-todo';
let items=JSON.parse(localStorage.getItem(KEY)||'[]');
function render(){l.innerHTML='';items.forEach((t,idx)=>{const li=document.createElement('li');if(t.done)li.className='done';const cb=document.createElement('input');cb.type='checkbox';cb.checked=t.done;cb.onchange=()=>{items[idx].done=cb.checked;save()};const sp=document.createElement('span');sp.textContent=t.text;const rm=document.createElement('button');rm.textContent='×';rm.onclick=()=>{items.splice(idx,1);save()};li.append(cb,sp,rm);l.append(li)})}
function save(){localStorage.setItem(KEY,JSON.stringify(items));render()}
f.onsubmit=e=>{e.preventDefault();const t=i.value.trim();if(!t)return;items.push({text:t,done:false});i.value='';save()};
render();`;
  return { id: 'todo', text: emit(html, css, js) };
}

// --------------------------------------------------------------------------
// Calculator
// --------------------------------------------------------------------------
function calculator() {
  const html = wrap('Calc', 'Calculator', '<div id="calc"><div id="d">0</div><div id="k"></div></div>');
  const css = `html,body{margin:0;height:100%;background:#050810;color:#e6edf3;font-family:system-ui;display:flex;align-items:center;justify-content:center}
#calc{width:280px;background:#0a1020;border:1px solid #2f7bff;border-radius:4px;padding:14px;box-shadow:0 0 24px rgba(47,123,255,.25)}
#d{background:#000;color:#5af;font:bold 32px ui-monospace,Consolas,monospace;text-align:right;padding:12px;border-radius:2px;margin-bottom:10px;min-height:48px;overflow:hidden}
#k{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
#k button{background:#1a2238;color:#e6edf3;border:0;padding:14px 0;font:600 16px system-ui;cursor:pointer;border-radius:2px}
#k button:hover{background:#2a3258}
#k button.op{background:#2f7bff;color:#000}
#k button.eq{background:#5af;color:#000;grid-column:span 2}
#k button.clr{background:#ff2d2d;color:#000}`;
  const js = `const d=document.getElementById('d'),k=document.getElementById('k');
const keys=['7','8','9','/','4','5','6','*','1','2','3','-','0','.','=','+','C'];
let expr='';
function paint(){d.textContent=expr||'0'}
function press(v){if(v==='C'){expr=''}else if(v==='='){try{const r=Function('return '+expr)();expr=String(r)}catch{expr='Error'}}else{expr+=v}paint()}
keys.forEach(v=>{const b=document.createElement('button');b.textContent=v;if(/[+\\-*/]/.test(v))b.className='op';else if(v==='=')b.className='eq';else if(v==='C')b.className='clr';b.onclick=()=>press(v);k.append(b)});
document.addEventListener('keydown',e=>{const k=e.key;if(/[0-9+\\-*/.=]/.test(k))press(k==='='?'=':k);else if(k==='Enter'||k==='=')press('=');else if(k==='Backspace')expr=expr.slice(0,-1),paint();else if(k.toLowerCase()==='c')press('C');e.preventDefault()});
paint();`;
  return { id: 'calculator', text: emit(html, css, js) };
}

// --------------------------------------------------------------------------
// Analog clock
// --------------------------------------------------------------------------
function clock() {
  const html = wrap('Clock', 'Clock', '<canvas id="g" width="320" height="320"></canvas><div id="hud"></div>');
  const css = `html,body{margin:0;height:100%;background:#050810;color:#e6edf3;font-family:system-ui;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px}
canvas{background:#0a1020;border:1px solid #2f7bff;border-radius:50%;box-shadow:0 0 30px rgba(47,123,255,.3)}
#hud{font-family:ui-monospace,Consolas,monospace;letter-spacing:.15em;font-size:18px}`;
  const js = `const c=document.getElementById('g'),x=c.getContext('2d');
const R=c.width/2;
function tick(){x.fillStyle='#0a1020';x.beginPath();x.arc(R,R,R,0,Math.PI*2);x.fill();x.strokeStyle='#2f7bff';x.lineWidth=2;x.stroke();for(let i=0;i<12;i++){const a=i/12*Math.PI*2-Math.PI/2;x.beginPath();x.moveTo(R+Math.cos(a)*R*.92,R+Math.sin(a)*R*.92);x.lineTo(R+Math.cos(a)*R*.97,R+Math.sin(a)*R*.97);x.stroke()}const d=new Date();const h=d.getHours()%12,m=d.getMinutes(),s=d.getSeconds();const ha=(h+m/60)/12*Math.PI*2-Math.PI/2,ma=(m+s/60)/60*Math.PI*2-Math.PI/2,sa=s/60*Math.PI*2-Math.PI/2;x.strokeStyle='#fff';x.lineWidth=4;x.beginPath();x.moveTo(R,R);x.lineTo(R+Math.cos(ha)*R*.5,R+Math.sin(ha)*R*.5);x.stroke();x.strokeStyle='#5af';x.lineWidth=3;x.beginPath();x.moveTo(R,R);x.lineTo(R+Math.cos(ma)*R*.7,R+Math.sin(ma)*R*.7);x.stroke();x.strokeStyle='#ff2d2d';x.lineWidth=2;x.beginPath();x.moveTo(R,R);x.lineTo(R+Math.cos(sa)*R*.8,R+Math.sin(sa)*R*.8);x.stroke();x.fillStyle='#2f7bff';x.beginPath();x.arc(R,R,4,0,Math.PI*2);x.fill();document.getElementById('hud').textContent=d.toLocaleTimeString()}
setInterval(tick,1000);tick();`;
  return { id: 'clock', text: emit(html, css, js) };
}

// --------------------------------------------------------------------------
// Pomodoro timer
// --------------------------------------------------------------------------
function pomodoro() {
  const html = wrap('Pomo', 'Pomodoro', '<div id="big">25:00</div><div id="lbl">focus</div><div id="btns"><button id="go">start</button><button id="rst">reset</button></div><div id="hist"></div>');
  const css = `html,body{margin:0;height:100%;background:#050810;color:#e6edf3;font-family:system-ui;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
#big{font:bold 96px ui-monospace,Consolas,monospace;color:#2f7bff;text-shadow:0 0 24px rgba(47,123,255,.5);letter-spacing:.04em}
#lbl{font-family:ui-monospace,Consolas,monospace;letter-spacing:.3em;color:#5af}
#btns{display:flex;gap:8px}
#btns button{background:#1a2238;color:#e6edf3;border:0;padding:10px 18px;cursor:pointer;font:inherit;border-radius:2px;min-width:80px}
#btns button#go{background:#2f7bff;color:#000;font-weight:600}
#btns button:hover{filter:brightness(1.1)}
#hist{font-family:ui-monospace,Consolas,monospace;opacity:.6;font-size:13px;margin-top:6px}`;
  const js = `const big=document.getElementById('big'),lbl=document.getElementById('lbl'),go=document.getElementById('go'),rst=document.getElementById('rst'),hist=document.getElementById('hist');
let mode='focus',secs=25*60,total=secs,tick=null,cycles=+localStorage.getItem('pomo')||0;
function fmt(s){const m=Math.floor(s/60),ss=String(s%60).padStart(2,'0');return m+':'+ss}
function paint(){big.textContent=fmt(secs);lbl.textContent=mode;go.textContent=tick?'pause':'start';hist.textContent=cycles?'completed today: '+cycles:''}
go.onclick=()=>{if(tick){clearInterval(tick);tick=null}else{tick=setInterval(()=>{secs--;if(secs<=0){clearInterval(tick);tick=null;if(mode==='focus'){cycles++;localStorage.setItem('pomo',cycles);mode='break';secs=5*60}else{mode='focus';secs=25*60}paint()}else paint()},1000)}paint()};
rst.onclick=()=>{if(tick){clearInterval(tick);tick=null}mode='focus';secs=25*60;paint()};
paint();`;
  return { id: 'pomodoro', text: emit(html, css, js) };
}

// --------------------------------------------------------------------------
// Image gallery (CSS grid of colored "photos" — no external assets needed)
// --------------------------------------------------------------------------
function gallery() {
  const html = wrap('Gallery', 'Gallery', '<h1>gallery</h1><div id="g"></div>');
  const css = `html,body{margin:0;min-height:100%;background:#050810;color:#e6edf3;font-family:system-ui;padding:24px;box-sizing:border-box}
h1{font-family:ui-monospace,Consolas,monospace;letter-spacing:.25em;font-size:18px;color:#2f7bff;margin:0 0 16px}
#g{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}
#g div{aspect-ratio:4/3;border-radius:2px;cursor:pointer;transition:transform .15s,box-shadow .15s;display:flex;align-items:flex-end;padding:8px;color:#000;font-weight:600;font-family:ui-monospace,Consolas,monospace;font-size:12px;letter-spacing:.1em;text-shadow:0 1px 0 rgba(255,255,255,.3)}
#g div:hover{transform:scale(1.04);box-shadow:0 0 24px rgba(47,123,255,.5)}`;
  const js = `const g=document.getElementById('g');
const names=['aurora','nebula','pulse','horizon','cinder','moss','echo','lumen','drift','vesper','sable','harbor'];
for(let i=0;i<24;i++){const d=document.createElement('div');const h=Math.floor(Math.random()*360);d.style.background='linear-gradient(135deg, hsl('+h+',70%,55%), hsl('+(h+40)%360+',70%,40%))';d.textContent=names[i%names.length]+' '+(i+1);g.append(d)}`;
  return { id: 'gallery', text: emit(html, css, js) };
}

// --------------------------------------------------------------------------
// Three.js default (matches the original canned output for unknown prompts)
// --------------------------------------------------------------------------
function threeDefault() {
  return {
    id: 'three',
    text: `<!-- FILE: index.html -->
<!DOCTYPE html><html><head><meta charset="utf-8"><title>OmniOne stub</title><link rel="stylesheet" href="style.css"></head>
<body><canvas id="g"></canvas><script type="importmap">{"imports":{"three":"https://unpkg.com/three@0.169.0/build/three.module.js"}}</script><script type="module" src="main.js"></script></body></html>

<!-- FILE: style.css -->
html,body{margin:0;height:100%;background:#050810;color:#e6edf3;font-family:system-ui;display:flex;align-items:center;justify-content:center}
canvas{border:1px solid #2f7bff}

<!-- FILE: main.js -->
import * as THREE from 'three';
const c=document.getElementById('g');c.width=640;c.height=360;
const r=new THREE.WebGLRenderer({canvas:c,antialias:true});
const s=new THREE.Scene();s.background=new THREE.Color(0x050810);
const cam=new THREE.PerspectiveCamera(60,640/360,0.1,100);cam.position.z=3;
const g=new THREE.IcosahedronGeometry(1,1);
const m=new THREE.MeshStandardMaterial({color:0x2f7bff,wireframe:true});
const o=new THREE.Mesh(g,m);s.add(o);
s.add(new THREE.PointLight(0xffffff,1));
function f(){o.rotation.x+=0.01;o.rotation.y+=0.015;r.render(s,cam);requestAnimationFrame(f)}f();
`,
  };
}

// --------------------------------------------------------------------------
// Dispatch table. First match wins. Order matters.
// --------------------------------------------------------------------------
const TEMPLATES = [
  { id: 'snake',     test: /\bsnake\b/i,           build: snake },
  { id: 'tetris',    test: /\btetris\b|falling\s+blocks?/i, build: tetris },
  { id: 'asteroids', test: /\basteroid|space\s*shooter|neon.*shooter/i, build: asteroids },
  { id: 'pong',      test: /\bpong\b|\bpaddles?\b/i, build: pong },
  { id: 'bouncing',  test: /\bbounc|\bball(s)?\b/i, build: bouncing },
  { id: 'todo',      test: /\btodo|\btasks?\b|\bchecklist/i, build: todo },
  { id: 'calc',      test: /\bcalc(ulator)?\b|\barithmetic/i, build: calculator },
  { id: 'clock',     test: /\bclock\b|\banalog\b|\bwatch\b/i, build: clock },
  { id: 'pomodoro',  test: /\bpomodoro|\bcountdown|\b(?:study|focus)\s*timer/i, build: pomodoro },
  { id: 'gallery',   test: /\bgallery|\bphotos?\b|\balbum/i, build: gallery },
];

export function pickStubTemplate(prompt) {
  for (const t of TEMPLATES) {
    if (t.test.test(prompt || '')) {
      return t.build();
    }
  }
  return threeDefault();
}
