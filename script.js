const S = {
  shape:'sphere', tab:'lighting', sceneBg:'white',
  az:45, el:40, amb:0.25, dif:0.85,
  hard:0.92, shcol:0.45, facemap:0.65,
  bands:2, rough:0.4,
  rim:0.75, rimcol:0.2, spec:0.14,
  olt:2.0, oltsens:0.5, normedge:0.3,
  outlineMode:'depth', outlineCol:'ink',
  shadowMode:'native',
};

// ── Rotation state ─────────────────────────────────────
let rotX=-0.25, rotY=0.35;
let cx_,sx_,cy_,sy_;
function updateRot(){cx_=Math.cos(rotX);sx_=Math.sin(rotX);cy_=Math.cos(rotY);sy_=Math.sin(rotY);}
updateRot();
function rotOW(v){return[cy_*v[0]+sy_*sx_*v[1]+sy_*cx_*v[2], cx_*v[1]-sx_*v[2], -sy_*v[0]+cy_*sx_*v[1]+cy_*cx_*v[2]];}
function rotWO(v){return[cy_*v[0]-sy_*v[2], sy_*sx_*v[0]+cx_*v[1]+cy_*sx_*v[2], sy_*cx_*v[0]-sx_*v[1]+cy_*cx_*v[2]];}

// ── Canvas sizing (viewer column = 46% of window) ──────
const DPR=Math.min(window.devicePixelRatio||1,2);
function cssW(){
  const vw=window.innerWidth*0.38-40;
  return Math.max(110,Math.min(210,Math.floor(vw/3)));
}
function cssH(){return Math.round(cssW()*1.18);}

let CW,CH,RS,CX,CY,GROUND_Y;
function updSZ(){
  CW=Math.round(cssW()*DPR); CH=Math.round(cssH()*DPR);
  RS=Math.round(Math.min(CW,CH)*0.38);
  CX=Math.round(CW*0.5); CY=Math.round(CH*0.42);
  GROUND_Y=Math.round(CH*0.82);
}
updSZ();

const SPHERES=[
  {key:'pbr',      label:'PBR',      subE:'realistic',         subT:'continuous GGX',   col:[52,130,230],  accent:'#1a6fd4'},
  {key:'nintendo', label:'Nintendo', subE:'simplified',        subT:'posterized',         col:[42,185,100],  accent:'#1a9e58'},
  {key:'genshin',  label:'Genshin',  subE:'drawn',             subT:'authored toon',      col:[220,100,175], accent:'#d4437a'},
];
let cvs={},offscreens={},mode='explore';

function buildDisplay(){
  const area=document.getElementById('display');
  area.innerHTML=''; cvs={}; offscreens={};
  SPHERES.forEach(cfg=>{
    const wrap=document.createElement('div'); wrap.className='sph-col';
    const c=document.createElement('canvas');
    c.width=CW; c.height=CH;
    c.style.width=cssW()+'px'; c.style.height=cssH()+'px';
    const lbl=document.createElement('div');
    lbl.className='sph-label'; lbl.style.color=cfg.accent; lbl.textContent=cfg.label;
    const sub=document.createElement('div'); sub.className='sph-sub';
    sub.dataset.e=cfg.subE; sub.dataset.t=cfg.subT;
    sub.textContent=mode==='explore'?cfg.subE:cfg.subT;
    wrap.append(c,lbl,sub); area.appendChild(wrap);
    cvs[cfg.key]={canvas:c,ctx:c.getContext('2d'),col:cfg.col};
    const oc=document.createElement('canvas'); oc.width=CW; oc.height=CH;
    offscreens[cfg.key]={canvas:oc,ctx:oc.getContext('2d')};
  });
}

// ── Math ───────────────────────────────────────────────
const norm=v=>{const l=Math.sqrt(v[0]**2+v[1]**2+v[2]**2)||1;return v.map(x=>x/l);};
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
function getL(){const a=S.az*Math.PI/180,e=S.el*Math.PI/180;return norm([Math.cos(e)*Math.sin(a),Math.sin(e),Math.cos(e)*Math.cos(a)]);}

// ── Shape raycasting ───────────────────────────────────
function samplePx(px,py){
  const u=(px-CX)/RS, v=(CY-py)/RS;
  if(S.shape==='sphere'){const r2=u*u+v*v;if(r2>1)return null;const z=Math.sqrt(1-r2);const Nw=rotOW([u,v,z]);return{N:norm(Nw),depth:Nw[2]};}
  if(S.shape==='diamond')return rayDiamond(u,v);
  return null;
}
function getObjRay(u,v){return{o:rotWO([u,v,0]),d:[-sy_,cy_*sx_,cy_*cx_]};}

// ── Diamond (octahedron) — Möller–Trumbore ray-triangle ──
// 8 faces of a unit octahedron, vertices at (±1,0,0), (0,±1,0), (0,0,±1)
// Scaled so it fits in the same unit sphere as the sphere shape
const OCT_SCALE = 0.72;
const OV = [ // 6 vertices
  [ 1,0,0],[-1,0,0],[0, 1,0],[0,-1,0],[0,0, 1],[0,0,-1]
].map(v=>v.map(x=>x*OCT_SCALE));
// 8 faces (CCW when viewed from outside = normal pointing out)
const OCT_FACES = [
  [4,0,2],[4,2,1],[4,1,3],[4,3,0], // top 4 (z+)
  [5,2,0],[5,1,2],[5,3,1],[5,0,3], // bottom 4 (z-)
];
// Precomputed face normals (outward)
const OCT_NORMALS = OCT_FACES.map(([a,b,c])=>{
  const v=OV, ab=[v[b][0]-v[a][0],v[b][1]-v[a][1],v[b][2]-v[a][2]];
  const ac=[v[c][0]-v[a][0],v[c][1]-v[a][1],v[c][2]-v[a][2]];
  const n=[ab[1]*ac[2]-ab[2]*ac[1], ab[2]*ac[0]-ab[0]*ac[2], ab[0]*ac[1]-ab[1]*ac[0]];
  const l=Math.sqrt(n[0]**2+n[1]**2+n[2]**2); return n.map(x=>x/l);
});

function rayDiamond(u,v){
  const{o,d}=getObjRay(u,v);
  let tBest=Infinity, Nbest=null;
  for(let fi=0;fi<OCT_FACES.length;fi++){
    const[ia,ib,ic]=OCT_FACES[fi];
    const va=OV[ia],vb=OV[ib],vc=OV[ic];
    const e1=[vb[0]-va[0],vb[1]-va[1],vb[2]-va[2]];
    const e2=[vc[0]-va[0],vc[1]-va[1],vc[2]-va[2]];
    // h = d × e2
    const h=[d[1]*e2[2]-d[2]*e2[1], d[2]*e2[0]-d[0]*e2[2], d[0]*e2[1]-d[1]*e2[0]];
    const a=e1[0]*h[0]+e1[1]*h[1]+e1[2]*h[2];
    if(Math.abs(a)<1e-8)continue; // parallel
    const f=1/a;
    const s=[o[0]-va[0],o[1]-va[1],o[2]-va[2]];
    const u2=f*(s[0]*h[0]+s[1]*h[1]+s[2]*h[2]);
    if(u2<0||u2>1)continue;
    const q=[s[1]*e1[2]-s[2]*e1[1], s[2]*e1[0]-s[0]*e1[2], s[0]*e1[1]-s[1]*e1[0]];
    const v2=f*(d[0]*q[0]+d[1]*q[1]+d[2]*q[2]);
    if(v2<0||u2+v2>1)continue;
    const t=f*(e2[0]*q[0]+e2[1]*q[1]+e2[2]*q[2]);
    if(t>0.001&&t<tBest){
      // only accept front-facing triangles (outward normal faces viewer)
      const Nw=rotOW(OCT_NORMALS[fi]);
      if(Nw[2]>=0){tBest=t;Nbest=OCT_NORMALS[fi];}
    }
  }
  if(!Nbest)return null;
  const p=[o[0]+tBest*d[0],o[1]+tBest*d[1],o[2]+tBest*d[2]];
  return{N:norm(rotOW(Nbest)), depth:rotOW(p)[2]};
}

// ── Outline buffers ────────────────────────────────────
function buildBufs(){
  const db=new Float32Array(CW*CH),nb=new Float32Array(CW*CH*3);
  for(let py=0;py<CH;py++)for(let px=0;px<CW;px++){const s=samplePx(px,py),i=py*CW+px;
    db[i]=s?1:0; // binary mask — reliable silhouette Sobel
    if(s){nb[i*3]=s.N[0];nb[i*3+1]=s.N[1];nb[i*3+2]=s.N[2];}
  }
  return{db,nb};
}
function sobelD(db,px,py){const g=(x,y)=>db[clamp(y,0,CH-1)*CW+clamp(x,0,CW-1)];const gx=-g(px-1,py-1)+g(px+1,py-1)-2*g(px-1,py)+2*g(px+1,py)-g(px-1,py+1)+g(px+1,py+1);const gy=-g(px-1,py-1)-2*g(px,py-1)-g(px+1,py-1)+g(px-1,py+1)+2*g(px,py+1)+g(px+1,py+1);return Math.sqrt(gx*gx+gy*gy);}
function normEdge(nb,px,py){const g=(x,y)=>{const i=(clamp(y,0,CH-1)*CW+clamp(x,0,CW-1))*3;return[nb[i],nb[i+1],nb[i+2]];};const c=g(px,py);let mx=0;for(const n of[g(px-1,py),g(px+1,py),g(px,py-1),g(px,py+1)]){const d=1-clamp(dot(c,n),-1,1);if(d>mx)mx=d;}return mx;}
// Build an edge mask (binary: 1 = edge), then isOutline does dilation by olt radius
let edgeMask=null;
function buildEdgeMask(db,nb){
  edgeMask=new Uint8Array(CW*CH);
  const tSens=1.1-S.oltsens;
  for(let py=0;py<CH;py++) for(let px=0;px<CW;px++){
    const i=py*CW+px;
    const isEdge=(S.outlineMode==='depth'||S.outlineMode==='both')&&sobelD(db,px,py)>0.35*tSens;
    const isCrs=(S.outlineMode==='normal'||S.outlineMode==='both')&&normEdge(nb,px,py)>S.normedge*1.2;
    edgeMask[i]=(isEdge||isCrs)?1:0;
  }
}
function isOutline(px,py){
  if(S.outlineMode==='none'||!edgeMask)return false;
  const rad=Math.max(1,Math.round(S.olt*0.8));
  for(let dy=-rad;dy<=rad;dy++) for(let dx=-rad;dx<=rad;dx++){
    if(dx*dx+dy*dy>rad*rad)continue;
    const nx=clamp(px+dx,0,CW-1),ny=clamp(py+dy,0,CH-1);
    if(edgeMask[ny*CW+nx])return true;
  }
  return false;
}
function olColor(col){if(S.outlineCol==='ink')return[12,10,16];if(S.outlineCol==='colored')return[col[0]*.3|0,col[1]*.3|0,col[2]*.4|0];return[col[0]*.15|0,col[1]*.15|0,col[2]*.15|0];}

// ── Face shadow ────────────────────────────────────────
function faceShadow(N,az){const a=az*Math.PI/180;const raw=clamp(N[0]*Math.cos(a)+N[2]*Math.sin(a),0,1);return raw*(1-S.facemap)+Math.floor(raw*3+0.3)/3*S.facemap;}

// ── Shaders ────────────────────────────────────────────
function shadePBR(N,L,col){
  const V=[0,0,1],H=norm([L[0]+V[0],L[1]+V[1],L[2]+V[2]]);
  const NdL=clamp(dot(N,L),0,1),NdV=clamp(dot(N,V),0,1),NdH=clamp(dot(N,H),0,1);
  const a=S.rough*S.rough,k=(S.rough+1)**2/8;
  const D=(a*a)/(Math.PI*(NdH*NdH*(a*a-1)+1)**2+1e-6);
  const G=(NdL/(NdL*(1-k)+k+1e-6))*(NdV/(NdV*(1-k)+k+1e-6));
  const F=0.04+0.96*Math.pow(1-clamp(dot(H,V),0,1),5);
  return col.map(c=>clamp(c*(S.amb+(1-F)*NdL/Math.PI*S.dif)+255*F*D*G/(4*NdV*NdL+1e-6)*0.4,0,255));
}
function shadeNintendo(N,L,col){
  const NdL=clamp(dot(N,L),0,1),frac=(NdL*S.bands)%1,ew=Math.max(1-S.hard,0.003);
  return col.map(c=>clamp(c*(S.amb+(Math.floor(NdL*S.bands)/S.bands+clamp(frac/ew,0,1)/S.bands)*S.dif),0,255));
}
function shadeGenshin(N,L,col,py){
  const ew=Math.max(1-S.hard,0.001);
  const isFace=false; // face map only applies to character faces, not geometry demos
  const lit=isFace?clamp(dot(N,L)/ew,0,1)*(1-S.facemap)+faceShadow(N,S.az)*S.facemap:clamp(dot(N,L)/ew,0,1);
  const sc=S.shcol,fB=S.amb*0.4;
  const sR=col[0]*0.18+sc*55+(1-sc)*18,sG=col[1]*0.18+sc*42+(1-sc)*48,sB=col[2]*0.25+sc*105+(1-sc)*82;
  let r=sR*(1-lit)+col[0]*lit+fB*col[0],g=sG*(1-lit)+col[1]*lit+fB*col[1],b=sB*(1-lit)+col[2]*lit+fB*col[2];
  const V=[0,0,1],NdV=clamp(dot(N,V),0,1),L2D=norm([L[0],0,L[2]]);
  const rim=Math.pow(1-NdV,3.2)*clamp(dot(N,[-L2D[0],0,-L2D[2]]),0,1)*S.rim,rc=S.rimcol;
  r=clamp(r+rim*(rc*230+(1-rc)*80),0,255);g=clamp(g+rim*(rc*185+(1-rc)*145),0,255);b=clamp(b+rim*255,0,255);
  const H=norm([L[0]+V[0],L[1]+V[1],L[2]+V[2]]);
  if(clamp(dot(N,H),0,1)>(1-S.spec)&&lit>0.5){r=clamp(r+215,0,255);g=clamp(g+228,0,255);b=clamp(b+255,0,255);}
  return[clamp(r,0,255)|0,clamp(g,0,255)|0,clamp(b,0,255)|0];
}
function shadowOverride(N,L,col,py){
  const sm=S.shadowMode;
  if(sm==='gradient'){const v=S.amb+clamp(dot(N,L),0,1)*S.dif;return col.map(c=>clamp(c*v,0,255)|0);}
  if(sm==='hard'||sm==='facemap'){
    const isFace=false;
    const ew=Math.max(1-S.hard,0.001);
    const lit=isFace?clamp(dot(N,L)/ew,0,1)*(1-S.facemap)+faceShadow(N,S.az)*S.facemap:clamp(dot(N,L)/ew,0,1);
    const sc=S.shcol,fB=S.amb*0.4;
    const sR=col[0]*0.18+sc*55+(1-sc)*18,sG=col[1]*0.18+sc*42+(1-sc)*48,sB=col[2]*0.25+sc*105+(1-sc)*82;
    return[clamp(sR*(1-lit)+col[0]*lit+fB*col[0],0,255)|0,clamp(sG*(1-lit)+col[1]*lit+fB*col[1],0,255)|0,clamp(sB*(1-lit)+col[2]*lit+fB*col[2],0,255)|0];
  }
  return null;
}

// ── Render ─────────────────────────────────────────────
function drawCanvas(key,shadeNative){
  const{ctx,col}=cvs[key],{ctx:octx}=offscreens[key],L=getL();
  ctx.clearRect(0,0,CW,CH);
  if(S.sceneBg==='white'){
    const offX=-L[0]*RS*0.55,ellW=RS*(S.shape==='diamond'?0.72:0.75),ellH=ellW*0.20;
    ctx.save();ctx.globalAlpha=0.16;ctx.fillStyle='#1a1420';ctx.beginPath();ctx.ellipse(CX+offX,GROUND_Y,ellW,ellH,0,0,Math.PI*2);ctx.fill();ctx.restore();
  }
  octx.clearRect(0,0,CW,CH);
  const img=octx.createImageData(CW,CH),d=img.data;
  const needOutlines=S.tab==='outlines'&&S.outlineMode!=='none';
  if(needOutlines){const bufs=buildBufs();buildEdgeMask(bufs.db,bufs.nb);}else{edgeMask=null;}
  for(let py=0;py<CH;py++){
    for(let px=0;px<CW;px++){
      const s=samplePx(px,py);if(!s)continue;
      const idx=(py*CW+px)*4;
      if(needOutlines&&isOutline(px,py)){const oc=olColor(col);d[idx]=oc[0];d[idx+1]=oc[1];d[idx+2]=oc[2];d[idx+3]=255;continue;}
      const rgb=S.tab==='shadows'?(shadowOverride(s.N,L,col,py)||shadeNative(s.N,L,col,py)):shadeNative(s.N,L,col,py);
      d[idx]=rgb[0];d[idx+1]=rgb[1];d[idx+2]=rgb[2];d[idx+3]=255;
    }
  }
  octx.putImageData(img,0,0);
  ctx.drawImage(offscreens[key].canvas,0,0);
}
function drawAll(){
  const L=getL();
  document.getElementById('ldir').textContent=`L=(${L[0].toFixed(2)},${L[1].toFixed(2)},${L[2].toFixed(2)})`;
  drawCanvas('pbr',(N,L,col)=>shadePBR(N,L,col));
  drawCanvas('nintendo',(N,L,col)=>shadeNintendo(N,L,col));
  drawCanvas('genshin',(N,L,col,py)=>shadeGenshin(N,L,col,py));
}

// ── Drag to rotate (on viewer) ─────────────────────────
const viewerEl=document.getElementById('viewer');
let dragPrev=null;
viewerEl.addEventListener('mousedown',e=>{dragPrev={x:e.clientX,y:e.clientY};viewerEl.classList.add('dragging');e.preventDefault();});
window.addEventListener('mousemove',e=>{if(!dragPrev)return;rotY-=(e.clientX-dragPrev.x)*0.012;rotX-=(e.clientY-dragPrev.y)*0.012;rotX=clamp(rotX,-Math.PI/2,Math.PI/2);dragPrev={x:e.clientX,y:e.clientY};updateRot();drawAll();});
window.addEventListener('mouseup',()=>{dragPrev=null;viewerEl.classList.remove('dragging');});
viewerEl.addEventListener('touchstart',e=>{const t=e.touches[0];dragPrev={x:t.clientX,y:t.clientY};},{passive:true});
window.addEventListener('touchmove',e=>{if(!dragPrev)return;const t=e.touches[0];rotY-=(t.clientX-dragPrev.x)*0.012;rotX-=(t.clientY-dragPrev.y)*0.012;rotX=clamp(rotX,-Math.PI/2,Math.PI/2);dragPrev={x:t.clientX,y:t.clientY};updateRot();drawAll();},{passive:true});
window.addEventListener('touchend',()=>{dragPrev=null;});

// ── IntersectionObserver: section → S.tab ─────────────
const story=document.getElementById('story');
const secIndicator=document.getElementById('viewer-section');
const observer=new IntersectionObserver(entries=>{
  entries.forEach(entry=>{
    if(entry.isIntersecting&&entry.intersectionRatio>=0.5){
      const tab=entry.target.dataset.tab;
      S.tab=tab;
      if(secIndicator)secIndicator.textContent=tab;
      document.querySelectorAll('.sec-dot').forEach(d=>{d.classList.toggle('active',d.dataset.target==='sec-'+tab);});
      drawAll();
    }
  });
},{root:story,threshold:0.5});
document.querySelectorAll('.story-sec').forEach(sec=>observer.observe(sec));

// Section dot clicks
document.querySelectorAll('.sec-dot').forEach(dot=>{
  dot.addEventListener('click',()=>{
    const t=document.getElementById(dot.dataset.target);
    if(t)t.scrollIntoView({behavior:'smooth'});
  });
});

// ── Mode toggle ────────────────────────────────────────


// ── Shape + scene ──────────────────────────────────────
function wireSeg(id,key,cb){
  document.getElementById(id).querySelectorAll('button').forEach(btn=>{
    btn.addEventListener('click',()=>{
      document.getElementById(id).querySelectorAll('button').forEach(b=>b.classList.remove('on'));
      btn.classList.add('on');S[key]=btn.dataset.val;if(cb)cb();drawAll();
    });
  });
}
wireSeg('shape-seg','shape');
wireSeg('bg-seg','sceneBg',()=>{document.documentElement.classList.toggle('dark',S.sceneBg==='black');});

// ── Chips ──────────────────────────────────────────────
document.querySelectorAll('[data-smode]').forEach(btn=>{btn.addEventListener('click',()=>{document.querySelectorAll('[data-smode]').forEach(b=>b.classList.remove('on'));btn.classList.add('on');S.shadowMode=btn.dataset.smode;drawAll();});});
document.querySelectorAll('[data-omode]').forEach(btn=>{btn.addEventListener('click',()=>{document.querySelectorAll('[data-omode]').forEach(b=>b.classList.remove('on'));btn.classList.add('on');S.outlineMode=btn.dataset.omode;drawAll();});});
document.querySelectorAll('[data-ocol]').forEach(btn=>{btn.addEventListener('click',()=>{document.querySelectorAll('[data-ocol]').forEach(b=>b.classList.remove('on'));btn.classList.add('on');S.outlineCol=btn.dataset.ocol;drawAll();});});

// ── Sliders ────────────────────────────────────────────
function wire(id,key,fmt){
  const el=document.getElementById(id);if(!el)return;
  const vel=document.getElementById('v-'+id.replace('sl-',''));
  el.addEventListener('input',()=>{S[key]=parseFloat(el.value);if(vel)vel.textContent=fmt(el.value);drawAll();});
}
const fDeg=v=>Math.round(v)+'°',fF2=v=>parseFloat(v).toFixed(2),fInt=v=>String(Math.round(v)),fF1=v=>parseFloat(v).toFixed(1);
wire('sl-az','az',fDeg);wire('sl-el','el',fDeg);wire('sl-amb','amb',fF2);wire('sl-dif','dif',fF2);
wire('sl-hard','hard',fF2);wire('sl-shcol','shcol',fF2);wire('sl-facemap','facemap',fF2);
wire('sl-bands','bands',fInt);wire('sl-rough','rough',fF2);
wire('sl-rim','rim',fF2);wire('sl-rimcol','rimcol',fF2);wire('sl-spec','spec',fF2);
wire('sl-olt','olt',fF1);wire('sl-oltsens','oltsens',fF2);wire('sl-normedge','normedge',fF2);

// Mirror azimuth between lighting and shadow sections
const azSh=document.getElementById('sl-az-sh'),azShV=document.getElementById('v-az-sh');
if(azSh)azSh.addEventListener('input',()=>{S.az=parseFloat(azSh.value);if(azShV)azShV.textContent=fDeg(azSh.value);const m=document.getElementById('sl-az'),mv=document.getElementById('v-az');if(m)m.value=azSh.value;if(mv)mv.textContent=fDeg(azSh.value);drawAll();});
// Mirror shcol between shadow and shading sections
const sc2=document.getElementById('sl-shcol2'),sc2v=document.getElementById('v-shcol2');
if(sc2)sc2.addEventListener('input',()=>{S.shcol=parseFloat(sc2.value);if(sc2v)sc2v.textContent=fF2(sc2.value);const m=document.getElementById('sl-shcol'),mv=document.getElementById('v-shcol');if(m)m.value=sc2.value;if(mv)mv.textContent=fF2(sc2.value);drawAll();});

// ── Resize ─────────────────────────────────────────────
window.addEventListener('resize',()=>{
  updSZ();
  SPHERES.forEach(cfg=>{
    const{canvas}=cvs[cfg.key];canvas.width=CW;canvas.height=CH;canvas.style.width=cssW()+'px';canvas.style.height=cssH()+'px';
    const oc=offscreens[cfg.key].canvas;oc.width=CW;oc.height=CH;
  });
  drawAll();
});

// ── Comparison panel drag ──────────────────────────────────
function initCmp(id){
  const el=document.getElementById(id); if(!el)return;
  const left=el.querySelector('.cmp-left');
  const right=el.querySelector('.cmp-right');
  const divider=el.querySelector('.cmp-divider');
  let dragging=false;
  function setPos(x){
    const r=el.getBoundingClientRect();
    const pct=Math.max(5,Math.min(95,((x-r.left)/r.width)*100));
    left.style.clipPath=`inset(0 ${100-pct}% 0 0)`;
    right.style.clipPath=`inset(0 0 0 ${pct}%)`;
    divider.style.left=pct+'%';
  }
  el.addEventListener('mousedown',e=>{dragging=true;setPos(e.clientX);e.preventDefault();});
  window.addEventListener('mousemove',e=>{if(dragging)setPos(e.clientX);});
  window.addEventListener('mouseup',()=>{dragging=false;});
  el.addEventListener('touchstart',e=>{dragging=true;setPos(e.touches[0].clientX);},{passive:true});
  window.addEventListener('touchmove',e=>{if(dragging)setPos(e.touches[0].clientX);},{passive:true});
  window.addEventListener('touchend',()=>{dragging=false;});
}
['cmp-lighting','cmp-shadows','cmp-shading','cmp-outlines'].forEach(initCmp);

// ── Intro screens ──────────────────────────────────────────
const introA    = document.getElementById('intro-a');
const introC    = document.getElementById('intro-c');
const introQ    = document.getElementById('intro-q');
const enterHint = document.getElementById('enter-hint');
const introInner= document.getElementById('intro-inner');
const introEnter= document.getElementById('intro-enter');

// Stagger intro A: headline first, hint after
setTimeout(()=>{ introQ.classList.add('show'); }, 120);
setTimeout(()=>{ enterHint.classList.add('show'); }, 600);

function goToC() {
  introA.classList.add('hidden');
  setTimeout(()=>{
    introA.classList.add('gone');
    introC.classList.remove('gone');
    requestAnimationFrame(()=> requestAnimationFrame(()=>{
      introInner.classList.add('show');
    }));
  }, 700);
}

function enterTool() {
  introC.classList.add('hidden');
  setTimeout(()=>{ introC.classList.add('gone'); }, 700);
}

introA.addEventListener('click', goToC);
introEnter.addEventListener('click', e=>{ e.stopPropagation(); enterTool(); });

buildDisplay();
drawAll();

  // Cursor direction based on scroll position
  function updateStoryCursor() {
    var s = story;
    var atBottom = s.scrollTop + s.clientHeight >= s.scrollHeight - 10;
    var atTop = s.scrollTop <= 10;
    if (atBottom && !atTop) {
      s.classList.add('at-bottom');
    } else {
      s.classList.remove('at-bottom');
    }
  }
  story.addEventListener('scroll', updateStoryCursor);
  updateStoryCursor();