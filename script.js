'use strict';

// ── State ───────────────────────────────────────────────
var S = {
  az:45, el:40, amb:0.25, dif:0.85,
  hard:0.35, shcol:0.30, softness:0.2,
  omode:'depth', olt:2.0,
  bands:2, rough:0.4, rim:0.75, rimcol:0.2, spec:0.14,
  shape:'sphere', bg:'white', tab:'lighting'
};
var rotX=-0.2, rotY=0.4;
var dragging=false, dragLast={x:0,y:0};

const KEYS   = ['pbr','nintendo','genshin'];
const LABELS = {pbr:'PBR', nintendo:'Genshin', genshin:'Nintendo'};
const SUBS   = {pbr:'realistic', nintendo:'drawn', genshin:'simplified'};
const COLORS = {pbr:'#1a6fd4', nintendo:'#d4437a', genshin:'#1a9e58'};
const SIZE   = 190;
const DPR    = Math.min(window.devicePixelRatio, 2);

const scenes={}, cameras={}, meshes={}, outlineMeshes={}, uniforms={};
const renderers={};
var sharedMats=null;

function getLight(){
  const az=S.az*Math.PI/180, el=S.el*Math.PI/180;
  return new THREE.Vector3(
    Math.cos(el)*Math.sin(az), Math.sin(el), Math.cos(el)*Math.cos(az)
  ).normalize();
}

// ── GLSL ─────────────────────────────────────────────────
const VERT = `
varying vec3 vNormal;
varying vec3 vViewPos;
void main(){
  vec4 mv=modelViewMatrix*vec4(position,1.0);
  vViewPos=-mv.xyz;
  vNormal=normalize(normalMatrix*normal);
  gl_Position=projectionMatrix*mv;
}`;

const VERT_OUTLINE = `
uniform float uWidth;
void main(){
  vec3 n=normalize(normalMatrix*normal);
  vec4 mv=modelViewMatrix*vec4(position,1.0);
  mv.xyz+=n*uWidth;
  gl_Position=projectionMatrix*mv;
}`;

const FRAG_OUTLINE=`
uniform vec3 uColor;
void main(){ gl_FragColor=vec4(uColor,1.0); }`;

const FRAG_PBR=`
uniform vec3 uLight;
uniform float uAmb,uDif,uRough;
varying vec3 vNormal,vViewPos;
void main(){
  vec3 base=vec3(0.68,0.72,0.88);
  vec3 N=normalize(vNormal),L=normalize(uLight),V=normalize(vViewPos),H=normalize(L+V);
  float diff=max(dot(N,L),0.0)*uDif;
  float gloss=max(1.0-uRough*uRough,0.01);
  float spec=pow(max(dot(N,H),0.0),gloss*64.0)*0.5*(1.0-uRough);
  gl_FragColor=vec4(clamp(base*(uAmb+diff)+spec,0.0,1.0),1.0);
}`;

const FRAG_NINTENDO=`
uniform vec3 uLight;
uniform float uAmb,uDif,uHard,uSoftness,uShcol,uRim,uRimcol,uBands;
varying vec3 vNormal,vViewPos;
void main(){
  vec3 base=vec3(0.96,0.52,0.72);
  vec3 N=normalize(vNormal),L=normalize(uLight),V=normalize(vViewPos);
  float diff=max(dot(N,L),0.0)*uDif;
  // Shadow boundary uses raw diff — makes softness and edge sharpness clearly visible
  float soft=max(uSoftness*0.3,0.005);
  float shadow=smoothstep(uHard-soft,uHard+soft,diff);
  // Banding applied separately to diffuse response
  float stepped=floor(diff*uBands)/uBands;
  vec3 shadowTint=mix(vec3(0.55,0.58,0.88),vec3(1.0),uShcol);
  vec3 lit=base*(uAmb+stepped*(1.0-uAmb));
  vec3 shd=base*shadowTint*max(uAmb,0.45);
  vec3 col=mix(shd,lit,shadow);
  float spec=pow(max(dot(reflect(-L,N),V),0.0),24.0)*0.5*diff;
  col+=vec3(spec);
  float rim=smoothstep(0.38,0.68,1.0-max(dot(N,V),0.0))*uRim*0.85;
  col+=mix(vec3(1.0),vec3(1.0,0.80,0.50),uRimcol)*rim;
  gl_FragColor=vec4(clamp(col,0.0,1.0),1.0);
}`;

const FRAG_GENSHIN=`
uniform vec3 uLight;
uniform float uAmb,uDif,uBands,uRim,uSpec;
varying vec3 vNormal,vViewPos;
void main(){
  vec3 base=vec3(0.35,0.78,0.42);
  vec3 N=normalize(vNormal),L=normalize(uLight),V=normalize(vViewPos);
  float diff=max(dot(N,L),0.0)*uDif;
  float stepped=floor(diff*uBands)/uBands;
  float spec=step(1.0-uSpec,pow(max(dot(reflect(-L,N),V),0.0),32.0));
  float rim=step(0.58,1.0-max(dot(N,V),0.0))*uRim*0.55;
  vec3 col=base*(uAmb+stepped)+vec3(spec*0.95)+vec3(rim);
  gl_FragColor=vec4(clamp(col,0.0,1.0),1.0);
}`;

// ── Init scenes ─────────────────────────────────────────
function initScenes(){
  KEYS.forEach(key=>{
    scenes[key]=new THREE.Scene();
    cameras[key]=new THREE.PerspectiveCamera(35,1,0.01,100);
    cameras[key].position.set(0,0,3.5);
    renderers[key]=[];
  });
}

// ── Outline material ─────────────────────────────────────
function makeOutlineMat(){
  return new THREE.ShaderMaterial({
    vertexShader:VERT_OUTLINE, fragmentShader:FRAG_OUTLINE,
    uniforms:{uWidth:{value:0.04},uColor:{value:new THREE.Color(0x1a1916)}},
    side:THREE.BackSide
  });
}

// ── Build slot ───────────────────────────────────────────
function buildSlot(slot){
  const row=document.createElement('div');
  row.className='sphere-row';
  row.style.cssText='display:flex;align-items:flex-end;gap:1.5rem;justify-content:center;margin-bottom:.75rem;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;';
  KEYS.forEach(key=>{
    const col=document.createElement('div');
    col.style.cssText='display:flex;flex-direction:column;align-items:center;gap:.3rem;cursor:grab;';
    const canvas=document.createElement('canvas');
    canvas.width=SIZE*DPR; canvas.height=SIZE*DPR;
    canvas.style.width=SIZE+'px'; canvas.style.height=SIZE+'px';
    canvas.style.borderRadius='8px';
    canvas.style.display='block';
    canvas.style.touchAction='none';
    const renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:true});
    renderer.setPixelRatio(DPR); renderer.setSize(SIZE,SIZE);
    renderer.setClearColor(0x000000,0);
    renderers[key].push(renderer);
    const label=document.createElement('div');
    label.className='sph-label'; label.style.color=COLORS[key]; label.textContent=LABELS[key];
    const sub=document.createElement('div');
    sub.className='sph-sub'; sub.textContent=SUBS[key];
    col.appendChild(canvas); col.appendChild(label); col.appendChild(sub);
    row.appendChild(col);
  });

  // Bind drag to the whole row (catches label clicks too) AND each canvas
  function startDrag(e){
    dragging=true;
    const src=e.touches?e.touches[0]:e;
    dragLast={x:src.clientX,y:src.clientY};
    row.style.cursor='grabbing';
    lastInteraction=Date.now();
    if(e.cancelable) e.preventDefault();
  }
  row.addEventListener('mousedown',startDrag);
  row.addEventListener('touchstart',startDrag,{passive:false});

  slot.insertBefore(row,slot.firstChild);
}
function buildAllSlots(){
  document.querySelectorAll('.display-slot').forEach(slot=>buildSlot(slot));
}

// ── Global move/up handlers ───────────────────────────────
window.addEventListener('mousemove',e=>{
  if(!dragging) return;
  rotY+=(e.clientX-dragLast.x)*0.007;
  rotX+=(e.clientY-dragLast.y)*0.007;
  dragLast={x:e.clientX,y:e.clientY};
  updateRot(); drawAll();
});
window.addEventListener('mouseup',()=>{
  if(dragging){ dragging=false; document.querySelectorAll('.sphere-row').forEach(r=>r.style.cursor='grab'); }
});
window.addEventListener('touchmove',e=>{
  if(!dragging) return;
  const t=e.touches[0];
  rotY+=(t.clientX-dragLast.x)*0.007;
  rotX+=(t.clientY-dragLast.y)*0.007;
  dragLast={x:t.clientX,y:t.clientY};
  updateRot(); drawAll();
},{passive:true});
window.addEventListener('touchend',()=>{dragging=false;});

// ── Rebuild meshes ───────────────────────────────────────
function rebuildMeshes(geo){
  if(!geo||!sharedMats) return;
  KEYS.forEach(key=>{
    if(meshes[key]) scenes[key].remove(meshes[key]);
    if(outlineMeshes[key]) scenes[key].remove(outlineMeshes[key]);
    meshes[key]=new THREE.Mesh(geo,sharedMats[key]);
    scenes[key].add(meshes[key]);
    outlineMeshes[key]=new THREE.Mesh(geo,makeOutlineMat());
    scenes[key].add(outlineMeshes[key]);
  });
  updateRot(); updateOutline(); drawAll();
}

// ── Load assets ──────────────────────────────────────────
function loadAssets(){
  uniforms.pbr={uLight:{value:new THREE.Vector3(0.5,0.7,1.0)},uAmb:{value:S.amb},uDif:{value:S.dif},uRough:{value:S.rough}};
  uniforms.nintendo={uLight:{value:new THREE.Vector3(0.5,0.7,1.0)},uAmb:{value:S.amb},uDif:{value:S.dif},uHard:{value:S.hard},uSoftness:{value:S.softness},uShcol:{value:S.shcol},uRim:{value:S.rim},uRimcol:{value:S.rimcol},uBands:{value:S.bands}};
  uniforms.genshin={uLight:{value:new THREE.Vector3(0.5,0.7,1.0)},uAmb:{value:S.amb},uDif:{value:S.dif},uBands:{value:S.bands},uRim:{value:S.rim},uSpec:{value:S.spec}};
  sharedMats={
    pbr:     new THREE.ShaderMaterial({vertexShader:VERT,fragmentShader:FRAG_PBR,    uniforms:uniforms.pbr,    side:THREE.FrontSide}),
    nintendo:new THREE.ShaderMaterial({vertexShader:VERT,fragmentShader:FRAG_NINTENDO,uniforms:uniforms.nintendo,side:THREE.FrontSide}),
    genshin: new THREE.ShaderMaterial({vertexShader:VERT,fragmentShader:FRAG_GENSHIN, uniforms:uniforms.genshin, side:THREE.FrontSide})
  };
  rebuildMeshes(new THREE.SphereGeometry(1,64,64));
}

// ── Update helpers ───────────────────────────────────────
function updateRot(){
  // For torus knot: rotate the mesh so its shape changes are visible
  // For sphere: keep mesh fixed, light rotation handles the visual
  const isKnot = S.shape === 'torusknot';
  KEYS.forEach(key=>{
    if(meshes[key]){
      meshes[key].rotation.x = isKnot ? rotX : 0;
      meshes[key].rotation.y = isKnot ? rotY : 0;
    }
    if(outlineMeshes[key]){
      outlineMeshes[key].rotation.x = isKnot ? rotX : 0;
      outlineMeshes[key].rotation.y = isKnot ? rotY : 0;
    }
  });
}

function getRotatedLight(){
  // Rotate the base light direction by drag rotation
  const az=S.az*Math.PI/180, el=S.el*Math.PI/180;
  const base=new THREE.Vector3(
    Math.cos(el)*Math.sin(az), Math.sin(el), Math.cos(el)*Math.cos(az)
  );
  // Apply drag rotation to move light around the object
  base.applyEuler(new THREE.Euler(rotX, rotY, 0, 'XYZ'));
  return base.normalize();
}
function updateOutline(){
  KEYS.forEach(key=>{
    if(!outlineMeshes[key]) return;
    outlineMeshes[key].material.uniforms.uWidth.value=S.olt*0.012;
    outlineMeshes[key].material.visible=S.omode!=='none';
  });
}
function updateUniforms(){
  const Lx=getRotatedLight();
  if(uniforms.pbr){uniforms.pbr.uLight.value=Lx;uniforms.pbr.uAmb.value=S.amb;uniforms.pbr.uDif.value=S.dif;uniforms.pbr.uRough.value=S.rough;}
  if(uniforms.nintendo){uniforms.nintendo.uLight.value=Lx;uniforms.nintendo.uAmb.value=S.amb;uniforms.nintendo.uDif.value=S.dif;uniforms.nintendo.uHard.value=S.hard;uniforms.nintendo.uSoftness.value=S.softness;uniforms.nintendo.uShcol.value=S.shcol;uniforms.nintendo.uRim.value=S.rim;uniforms.nintendo.uRimcol.value=S.rimcol;uniforms.nintendo.uBands.value=S.bands;}
  if(uniforms.genshin){uniforms.genshin.uLight.value=Lx;uniforms.genshin.uAmb.value=S.amb;uniforms.genshin.uDif.value=S.dif;uniforms.genshin.uBands.value=S.bands;uniforms.genshin.uRim.value=S.rim;uniforms.genshin.uSpec.value=S.spec;}
}

// ── Draw all ─────────────────────────────────────────────
function drawAll(){
  updateUniforms(); updateOutline();
  KEYS.forEach(key=>{
    (renderers[key]||[]).forEach(r=>r.render(scenes[key],cameras[key]));
  });
}

// ── Slider wiring ────────────────────────────────────────
function wire(id,key,fmt){
  const el=document.getElementById(id);
  const vl=document.getElementById('v-'+id.replace('sl-',''));
  if(!el) return;
  el.addEventListener('input',()=>{S[key]=+el.value;if(vl)vl.textContent=fmt(+el.value);drawAll();});
}
wire('sl-az','az',v=>Math.round(v)+'°');
wire('sl-el','el',v=>Math.round(v)+'°');
wire('sl-amb','amb',v=>v.toFixed(2));
wire('sl-dif','dif',v=>v.toFixed(2));
wire('sl-hard','hard',v=>v.toFixed(2));
wire('sl-softness','softness',v=>v.toFixed(2));
wire('sl-shcol','shcol',v=>v.toFixed(2));
wire('sl-bands','bands',v=>Math.round(v)+'');
wire('sl-rough','rough',v=>v.toFixed(2));
wire('sl-rim','rim',v=>v.toFixed(2));
wire('sl-rimcol','rimcol',v=>v.toFixed(2));
wire('sl-spec','spec',v=>v.toFixed(3));
wire('sl-olt','olt',v=>{updateOutline();return v.toFixed(1);});

// ── Shape toggle ─────────────────────────────────────────
document.getElementById('shape-seg')&&document.getElementById('shape-seg').querySelectorAll('button').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.getElementById('shape-seg').querySelectorAll('button').forEach(b=>b.classList.remove('on'));
    btn.classList.add('on'); S.shape=btn.dataset.val;
    if(!sharedMats) return;
    const isKnot=S.shape==='torusknot';
    KEYS.forEach(key=>cameras[key].position.set(0,0,isKnot?4.5:3.5));
    rebuildMeshes(isKnot
      ? new THREE.TorusKnotGeometry(0.6,0.22,128,32)
      : new THREE.SphereGeometry(1,64,64));
  });
});

// ── Dark mode toggle ─────────────────────────────────────
document.getElementById('bg-seg')&&document.getElementById('bg-seg').querySelectorAll('button').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.getElementById('bg-seg').querySelectorAll('button').forEach(b=>b.classList.remove('on'));
    btn.classList.add('on'); S.bg=btn.dataset.val;
    if(S.bg==='black') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
    drawAll();
  });
});

// ── Shadow mode chips ─────────────────────────────────────
document.querySelectorAll('[data-smode]').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('[data-smode]').forEach(b=>b.classList.remove('on'));
    btn.classList.add('on'); drawAll();
  });
});

// ── Section observer ─────────────────────────────────────
const secIndicator=document.getElementById('viewer-section');
document.querySelectorAll('.story-sec').forEach(sec=>{
  new IntersectionObserver(entries=>{
    entries.forEach(e=>{
      if(e.isIntersecting){S.tab=e.target.dataset.tab;if(secIndicator)secIndicator.textContent=S.tab;}
    });
  },{root:null,rootMargin:'-20% 0px -20% 0px',threshold:0}).observe(sec);
});

// ── Scroll reveal + progress bar ─────────────────────────
const progressBar=document.getElementById('progress-bar');
window.addEventListener('scroll',()=>{
  const pct=window.scrollY/(document.body.scrollHeight-window.innerHeight)*100;
  if(progressBar) progressBar.style.width=Math.min(pct,100)+'%';
});
document.querySelectorAll('.sec-eye,.sec-q,h3,.sec-body,figure,.display-slot').forEach(el=>el.classList.add('reveal'));
setTimeout(()=>{
  const ro=new IntersectionObserver(entries=>{
    entries.forEach(e=>e.target.classList.toggle('visible',e.isIntersecting));
  },{threshold:0,rootMargin:'0px 0px -60px 0px'});
  document.querySelectorAll('.reveal').forEach(el=>ro.observe(el));
},200);

// ── Comparison slider ─────────────────────────────────────
function initCmp(id){
  const el=document.getElementById(id); if(!el) return;
  const left=el.querySelector('.cmp-left');
  const right=el.querySelector('.cmp-right');
  const divider=el.querySelector('.cmp-divider');
  let drag=false;
  function setPos(x){
    const r=el.getBoundingClientRect();
    const pct=Math.max(0,Math.min(1,(x-r.left)/r.width))*100;
    left.style.clipPath=`inset(0 ${100-pct}% 0 0)`;
    right.style.clipPath=`inset(0 0 0 ${pct}%)`;
    divider.style.left=pct+'%';
  }
  el.addEventListener('mousedown',e=>{drag=true;setPos(e.clientX);e.preventDefault();});
  window.addEventListener('mousemove',e=>{if(drag)setPos(e.clientX);});
  window.addEventListener('mouseup',()=>{drag=false;});
  el.addEventListener('touchstart',e=>{drag=true;setPos(e.touches[0].clientX);},{passive:true});
  window.addEventListener('touchmove',e=>{if(drag)setPos(e.touches[0].clientX);},{passive:true});
  window.addEventListener('touchend',()=>{drag=false;});
}

// ── Boot ─────────────────────────────────────────────────
initScenes();
buildAllSlots();
loadAssets();
['cmp-shadows'].forEach(initCmp);

// ── Auto-rotate ──────────────────────────────────────────
let lastInteraction=0;
function autoRotate(){
  if(Date.now()-lastInteraction>2500){
    rotY+=0.003; updateRot(); drawAll();
  }
  requestAnimationFrame(autoRotate);
}
window.addEventListener('mousedown',()=>{lastInteraction=Date.now();},true);
window.addEventListener('touchstart',()=>{lastInteraction=Date.now();},true);
autoRotate();