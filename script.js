'use strict';

// ── State ───────────────────────────────────────────────
var S = {
  az:45, el:40, amb:0.25, dif:0.85,
  shadowMode:'native', hard:0.6, shcol:0.45, azSh:45, softness:0.1,
  omode:'depth', ocol:'ink', olt:2.0, oltsens:0.5, normedge:0.3,
  bands:2, rough:0.4, rim:0.75, rimcol:0.2, spec:0.14, shcol2:0.45, facemap:0.65,
  shape:'sphere', bg:'white', tab:'lighting'
};
var rotX=1.35, rotY=0.4;
var dragging=false, dragLast={x:0,y:0};

const KEYS   = ['pbr','nintendo','genshin'];
const LABELS = {pbr:'PBR', nintendo:'Nintendo', genshin:'Genshin'};
const SUBS   = {pbr:'realistic', nintendo:'simplified', genshin:'drawn'};
const COLORS = {pbr:'#1a6fd4', nintendo:'#1a9e58', genshin:'#d4437a'};
const SIZE   = 150;
const DPR    = Math.min(window.devicePixelRatio, 2);

const scenes={}, cameras={}, meshes={}, outlineMeshes={}, uniforms={};
const renderers={};  // renderers[key] = array of renderers
var objGeometry=null, sharedMats=null, outlineMat=null;

function getBgColor(){ return S.bg==='white' ? '#f7f6f3' : '#0d0c12'; }
function getLight(){
  const az=S.az*Math.PI/180, el=S.el*Math.PI/180;
  return new THREE.Vector3(
    Math.cos(el)*Math.sin(az), Math.sin(el), Math.cos(el)*Math.cos(az)
  ).normalize();
}

// ── GLSL ─────────────────────────────────────────────────
const VERT = `
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vViewPos;
void main(){
  vUv=uv;
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
uniform sampler2D uTex;
uniform vec3 uLight;
uniform float uAmb,uDif,uRough;
uniform bool uUseTex;
varying vec2 vUv; varying vec3 vNormal,vViewPos;
void main(){
  vec3 base=uUseTex?texture2D(uTex,vUv).rgb:vec3(0.68,0.72,0.88);
  vec3 N=normalize(vNormal),L=normalize(uLight),V=normalize(vViewPos),H=normalize(L+V);
  float diff=max(dot(N,L),0.0)*uDif;
  float gloss=max(1.0-uRough*uRough,0.01);
  float spec=pow(max(dot(N,H),0.0),gloss*64.0)*0.5*(1.0-uRough);
  gl_FragColor=vec4(clamp(base*(uAmb+diff)+spec,0.0,1.0),1.0);
}`;

const FRAG_NINTENDO=`
uniform sampler2D uTex;
uniform vec3 uLight;
uniform float uAmb,uDif,uBands,uRim,uSpec;
uniform bool uUseTex;
varying vec2 vUv; varying vec3 vNormal,vViewPos;
void main(){
  vec3 base=uUseTex?texture2D(uTex,vUv).rgb:vec3(0.35,0.78,0.42);
  vec3 N=normalize(vNormal),L=normalize(uLight),V=normalize(vViewPos);
  float diff=max(dot(N,L),0.0)*uDif;
  float stepped=floor(diff*uBands)/uBands;
  float spec=step(1.0-uSpec,pow(max(dot(reflect(-L,N),V),0.0),32.0));
  float rim=step(0.58,1.0-max(dot(N,V),0.0))*uRim*0.55;
  vec3 col=base*(uAmb+stepped)+vec3(spec*0.95)+vec3(rim);
  gl_FragColor=vec4(clamp(col,0.0,1.0),1.0);
}`;

const FRAG_GENSHIN=`
uniform sampler2D uTex;
uniform vec3 uLight;
uniform float uAmb,uDif,uHard,uSoftness,uShcol,uRim,uRimcol;
uniform bool uUseTex;
varying vec2 vUv; varying vec3 vNormal,vViewPos;
void main(){
  vec3 base=uUseTex?texture2D(uTex,vUv).rgb:vec3(0.90,0.42,0.60);
  vec3 N=normalize(vNormal),L=normalize(uLight),V=normalize(vViewPos);
  float diff=max(dot(N,L),0.0)*uDif;
  float soft=max(uSoftness*0.2,0.008);
  float shadow=smoothstep(uHard-soft,uHard+soft,diff);
  vec3 tint=mix(vec3(0.50,0.55,0.80),vec3(1.0),uShcol);
  vec3 col=mix(base*tint*max(uAmb,0.35),base,shadow);
  float rim=smoothstep(0.40,0.70,1.0-max(dot(N,V),0.0))*uRim*0.8;
  col+=mix(vec3(1.0),vec3(1.0,0.80,0.50),uRimcol)*rim;
  gl_FragColor=vec4(clamp(col,0.0,1.0),1.0);
}`;

// ── OBJ Parser ──────────────────────────────────────────
function parseOBJ(text){
  const pos=[],uvs=[],nrm=[],oP=[],oU=[],oN=[];
  for(const line of text.split(/\r?\n/)){
    const p=line.trim().split(/\s+/);
    if(p[0]==='v')  pos.push(+p[1],+p[2],+p[3]);
    else if(p[0]==='vt') uvs.push(+p[1],+p[2]);
    else if(p[0]==='vn') nrm.push(+p[1],+p[2],+p[3]);
    else if(p[0]==='f'){
      const verts=p.slice(1).map(s=>s.split('/').map(x=>x?parseInt(x)-1:0));
      for(let i=1;i<verts.length-1;i++){
        [verts[0],verts[i],verts[i+1]].forEach(([vi,ti,ni])=>{
          oP.push(pos[vi*3],pos[vi*3+1],pos[vi*3+2]);
          oU.push(uvs[ti*2],uvs[ti*2+1]);
          oN.push(-nrm[ni*3],-nrm[ni*3+1],-nrm[ni*3+2]);
        });
      }
    }
  }
  return {positions:new Float32Array(oP),uvs:new Float32Array(oU),normals:new Float32Array(oN)};
}

// ── Init scenes ─────────────────────────────────────────
function initScenes(){
  KEYS.forEach(key=>{
    const scene=new THREE.Scene();
    scenes[key]=scene;
    const cam=new THREE.PerspectiveCamera(35,1,0.01,100);
    cam.position.set(0,0,3.5);
    cameras[key]=cam;
    renderers[key]=[];
  });
}

// ── Outline material ─────────────────────────────────────
function makeOutlineMat(){
  return new THREE.ShaderMaterial({
    vertexShader:VERT_OUTLINE,
    fragmentShader:FRAG_OUTLINE,
    uniforms:{uWidth:{value:0.04},uColor:{value:new THREE.Color(0x1a1916)}},
    side:THREE.BackSide
  });
}

// ── Build slot ───────────────────────────────────────────
function buildSlot(slot){
  const row=document.createElement('div');
  row.className='sphere-row';
  row.style.cssText='display:flex;align-items:flex-end;gap:1.5rem;justify-content:center;margin-bottom:.75rem;cursor:grab;';

  KEYS.forEach(key=>{
    const col=document.createElement('div');
    col.style.cssText='display:flex;flex-direction:column;align-items:center;gap:.3rem;';

    const canvas=document.createElement('canvas');
    canvas.width=SIZE*DPR; canvas.height=SIZE*DPR;
    canvas.style.width=SIZE+'px'; canvas.style.height=SIZE+'px';
    canvas.style.cssText+=';border-radius:8px;display:block;';

    const renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:true});
    renderer.setPixelRatio(DPR);
    renderer.setSize(SIZE,SIZE);
    renderer.setClearColor(0x000000,0); // transparent
    renderers[key].push(renderer);

    const label=document.createElement('div');
    label.className='sph-label'; label.style.color=COLORS[key]; label.textContent=LABELS[key];
    const sub=document.createElement('div');
    sub.className='sph-sub'; sub.textContent=SUBS[key];

    col.appendChild(canvas); col.appendChild(label); col.appendChild(sub);
    row.appendChild(col);
  });

  slot.insertBefore(row,slot.firstChild);
}

function buildAllSlots(){
  document.querySelectorAll('.display-slot').forEach(slot=>buildSlot(slot));
}

// ── Global drag handler ──────────────────────────────────
window.addEventListener('mousedown',e=>{
  if(e.target.closest('.sphere-row')){
    dragging=true; dragLast={x:e.clientX,y:e.clientY};
    document.querySelectorAll('.sphere-row').forEach(r=>r.style.cursor='grabbing');
    e.preventDefault();
  }
});
window.addEventListener('mousemove',e=>{
  if(!dragging) return;
  const dx=e.clientX-dragLast.x, dy=e.clientY-dragLast.y;
  rotY+=dx*0.007; rotX+=dy*0.007;
  dragLast={x:e.clientX,y:e.clientY};
  updateRot(); drawAll();
});
window.addEventListener('mouseup',()=>{
  dragging=false;
  document.querySelectorAll('.sphere-row').forEach(r=>r.style.cursor='grab');
});
window.addEventListener('touchstart',e=>{
  if(e.target.closest('.sphere-row')){
    dragging=true; const t=e.touches[0]; dragLast={x:t.clientX,y:t.clientY};
  }
},{passive:true});
window.addEventListener('touchmove',e=>{
  if(!dragging) return;
  const t=e.touches[0], dx=t.clientX-dragLast.x, dy=t.clientY-dragLast.y;
  rotY+=dx*0.007; rotX+=dy*0.007;
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
    const m=new THREE.Mesh(geo,sharedMats[key]);
    meshes[key]=m; scenes[key].add(m);
    const om=new THREE.Mesh(geo,makeOutlineMat());
    outlineMeshes[key]=om; scenes[key].add(om);
  });
  updateRot(); updateOutline(); drawAll();
}

// ── Load assets ──────────────────────────────────────────
function loadAssets(){
  const tex=new THREE.TextureLoader().load('hair_diffuse.png',()=>drawAll());

  uniforms.pbr={uTex:{value:tex},uLight:{value:getLight()},uAmb:{value:S.amb},uDif:{value:S.dif},uRough:{value:S.rough},uUseTex:{value:false}};
  uniforms.nintendo={uTex:{value:tex},uLight:{value:getLight()},uAmb:{value:S.amb},uDif:{value:S.dif},uBands:{value:S.bands},uRim:{value:S.rim},uSpec:{value:S.spec},uUseTex:{value:false}};
  uniforms.genshin={uTex:{value:tex},uLight:{value:getLight()},uAmb:{value:S.amb},uDif:{value:S.dif},uHard:{value:S.hard},uSoftness:{value:S.softness},uShcol:{value:S.shcol},uRim:{value:S.rim},uRimcol:{value:S.rimcol},uUseTex:{value:false}};

  sharedMats={
    pbr:     new THREE.ShaderMaterial({vertexShader:VERT,fragmentShader:FRAG_PBR,    uniforms:uniforms.pbr,    side:THREE.FrontSide}),
    nintendo:new THREE.ShaderMaterial({vertexShader:VERT,fragmentShader:FRAG_NINTENDO,uniforms:uniforms.nintendo,side:THREE.FrontSide}),
    genshin: new THREE.ShaderMaterial({vertexShader:VERT,fragmentShader:FRAG_GENSHIN, uniforms:uniforms.genshin, side:THREE.FrontSide})
  };

  rebuildMeshes(new THREE.SphereGeometry(1,64,64));

  fetch('lumine_hair.obj').then(r=>r.text()).then(text=>{
    const {positions,uvs,normals}=parseOBJ(text);
    const geo=new THREE.BufferGeometry();
    geo.setAttribute('position',new THREE.BufferAttribute(positions,3));
    geo.setAttribute('uv',      new THREE.BufferAttribute(uvs,2));
    geo.setAttribute('normal',  new THREE.BufferAttribute(normals,3));
    geo.computeBoundingBox();
    const c=new THREE.Vector3(); geo.boundingBox.getCenter(c);
    geo.translate(-c.x,-c.y,-c.z);
    geo.computeBoundingSphere();
    const s=1.2/geo.boundingSphere.radius;
    geo.scale(s,s,s);
    objGeometry=geo;
    if(S.shape==='custom'){KEYS.forEach(k=>{if(uniforms[k])uniforms[k].uUseTex.value=true;});rebuildMeshes(objGeometry);}
  }).catch(()=>{});
}

// ── Update helpers ───────────────────────────────────────
function updateRot(){
  KEYS.forEach(key=>{
    if(meshes[key]){meshes[key].rotation.x=rotX;meshes[key].rotation.y=rotY;}
    if(outlineMeshes[key]){outlineMeshes[key].rotation.x=rotX;outlineMeshes[key].rotation.y=rotY;}
  });
}

function updateOutline(){
  KEYS.forEach(key=>{
    if(!outlineMeshes[key]) return;
    const mat=outlineMeshes[key].material;
    mat.uniforms.uWidth.value=S.olt*0.012;
    mat.visible=S.omode!=='none';
  });
}

function updateUniforms(){
  const L=getLight();
  if(uniforms.pbr){uniforms.pbr.uLight.value=L;uniforms.pbr.uAmb.value=S.amb;uniforms.pbr.uDif.value=S.dif;uniforms.pbr.uRough.value=S.rough;}
  if(uniforms.nintendo){uniforms.nintendo.uLight.value=L;uniforms.nintendo.uAmb.value=S.amb;uniforms.nintendo.uDif.value=S.dif;uniforms.nintendo.uBands.value=S.bands;uniforms.nintendo.uRim.value=S.rim;uniforms.nintendo.uSpec.value=S.spec;}
  if(uniforms.genshin){uniforms.genshin.uLight.value=L;uniforms.genshin.uAmb.value=S.amb;uniforms.genshin.uDif.value=S.dif;uniforms.genshin.uHard.value=S.hard;uniforms.genshin.uSoftness.value=S.softness;uniforms.genshin.uShcol.value=S.shcol;uniforms.genshin.uRim.value=S.rim;uniforms.genshin.uRimcol.value=S.rimcol;}
}

// ── Draw all ─────────────────────────────────────────────
function drawAll(){
  updateUniforms(); updateOutline();
  KEYS.forEach(key=>{
    (renderers[key]||[]).forEach(r=>{r.render(scenes[key],cameras[key]);});
  });
  const L=getLight();
  const ld=document.getElementById('ldir');
  if(ld) ld.textContent=`L=(${L.x.toFixed(2)},${L.y.toFixed(2)},${L.z.toFixed(2)})`;
}

// ── Sliders ──────────────────────────────────────────────
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
wire('sl-az-sh','azSh',v=>Math.round(v)+'°');
wire('sl-hard','hard',v=>v.toFixed(2));
wire('sl-softness','softness',v=>v.toFixed(2));
wire('sl-shcol','shcol',v=>v.toFixed(2));
wire('sl-bands','bands',v=>Math.round(v)+'');
wire('sl-rough','rough',v=>v.toFixed(2));
wire('sl-rim','rim',v=>v.toFixed(2));
wire('sl-rimcol','rimcol',v=>v.toFixed(2));
wire('sl-spec','spec',v=>v.toFixed(3));
wire('sl-shcol2','shcol2',v=>v.toFixed(2));
wire('sl-facemap','facemap',v=>v.toFixed(2));
wire('sl-olt','olt',v=>{updateOutline();return v.toFixed(1);});
wire('sl-oltsens','oltsens',v=>v.toFixed(2));
wire('sl-normedge','normedge',v=>v.toFixed(2));

// ── Toggles ──────────────────────────────────────────────
function wireSeg(id,key,cb){
  document.getElementById(id)&&document.getElementById(id).querySelectorAll('button').forEach(btn=>{
    btn.addEventListener('click',()=>{
      document.getElementById(id).querySelectorAll('button').forEach(b=>b.classList.remove('on'));
      btn.classList.add('on'); S[key]=btn.dataset.val; if(cb)cb(); drawAll();
    });
  });
}
// ── Scene / dark mode toggle ─────────────────────────────
document.getElementById('bg-seg')&&document.getElementById('bg-seg').querySelectorAll('button').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.getElementById('bg-seg').querySelectorAll('button').forEach(b=>b.classList.remove('on'));
    btn.classList.add('on');
    S.bg=btn.dataset.val;
    document.documentElement.classList.toggle('dark', S.bg==='black');
    drawAll();
  });
});

document.getElementById('shape-seg')&&document.getElementById('shape-seg').querySelectorAll('button').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.getElementById('shape-seg').querySelectorAll('button').forEach(b=>b.classList.remove('on'));
    btn.classList.add('on'); S.shape=btn.dataset.val;
    if(!sharedMats) return;
    const isCustom=S.shape==='custom';
    KEYS.forEach(k=>{if(uniforms[k])uniforms[k].uUseTex.value=isCustom;});
    rebuildMeshes(isCustom&&objGeometry ? objGeometry : new THREE.SphereGeometry(1,64,64));
  });
});

document.querySelectorAll('[data-smode]').forEach(btn=>{btn.addEventListener('click',()=>{document.querySelectorAll('[data-smode]').forEach(b=>b.classList.remove('on'));btn.classList.add('on');S.shadowMode=btn.dataset.smode;drawAll();});});
document.querySelectorAll('[data-omode]').forEach(btn=>{btn.addEventListener('click',()=>{document.querySelectorAll('[data-omode]').forEach(b=>b.classList.remove('on'));btn.classList.add('on');S.omode=btn.dataset.omode;updateOutline();drawAll();});});
document.querySelectorAll('[data-ocol]').forEach(btn=>{btn.addEventListener('click',()=>{document.querySelectorAll('[data-ocol]').forEach(b=>b.classList.remove('on'));btn.classList.add('on');S.ocol=btn.dataset.ocol;drawAll();});});

// ── Section observer ─────────────────────────────────────
const secIndicator=document.getElementById('viewer-section');
document.querySelectorAll('.story-sec').forEach(sec=>{
  new IntersectionObserver(entries=>{
    entries.forEach(e=>{if(e.isIntersecting){S.tab=e.target.dataset.tab;if(secIndicator)secIndicator.textContent=S.tab;}});
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

// ── Boot ─────────────────────────────────────────────────
initScenes();
buildAllSlots();
loadAssets();