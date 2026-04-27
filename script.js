'use strict';

// ── State ───────────────────────────────────────────────
var S = {
  az:45, el:40, amb:0.25, dif:0.85,
  shadowMode:'native', hard:0.92, shcol:0.45, azSh:45,
  omode:'depth', ocol:'ink', olt:2.0, oltsens:0.5, normedge:0.3,
  bands:2, rough:0.4, rim:0.75, rimcol:0.2, spec:0.14, shcol2:0.45, facemap:0.65,
  shape:'sphere', bg:'white', tab:'lighting'
};
var rotX = -0.2, rotY = 0.4;

// ── Three.js setup ──────────────────────────────────────
const KEYS = ['pbr', 'nintendo', 'genshin'];
const LABELS = { pbr:'PBR', nintendo:'Nintendo', genshin:'Genshin' };
const SUBS   = { pbr:'realistic', nintendo:'simplified', genshin:'drawn' };
const COLORS = { pbr:'#1a6fd4', nintendo:'#1a9e58', genshin:'#d4437a' };
const SIZE = 160;
const DPR  = Math.min(window.devicePixelRatio, 2);

const renderers={}, scenes={}, cameras={}, meshes={}, uniforms={};

function getLight() {
  const az = S.az * Math.PI/180;
  const el = S.el * Math.PI/180;
  return new THREE.Vector3(
    Math.cos(el)*Math.sin(az),
    Math.sin(el),
    Math.cos(el)*Math.cos(az)
  ).normalize();
}

function getBgColor() { return S.bg==='white' ? 0xffffff : 0x0d0c12; }

// ── GLSL Shaders ────────────────────────────────────────
const VERT = `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewPos;
  void main(){
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position,1.0);
    vViewPos = -mv.xyz;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG_PBR = `
  uniform sampler2D uTex;
  uniform vec3 uLight;
  uniform float uAmb;
  uniform float uDif;
  uniform float uRough;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewPos;
  void main(){
    vec4 tc = texture2D(uTex, vUv);
    if(tc.a < 0.1) discard;
    vec3 N = normalize(vNormal);
    vec3 L = normalize(uLight);
    vec3 V = normalize(vViewPos);
    vec3 H = normalize(L+V);
    float diff = max(dot(N,L),0.0)*uDif;
    float gloss = max(1.0-uRough*uRough, 0.01);
    float spec = pow(max(dot(N,H),0.0), gloss*64.0)*0.4*(1.0-uRough);
    vec3 col = tc.rgb*(uAmb+diff)+vec3(spec);
    gl_FragColor = vec4(clamp(col,0.0,1.0), tc.a);
  }
`;

const FRAG_NINTENDO = `
  uniform sampler2D uTex;
  uniform vec3 uLight;
  uniform float uAmb;
  uniform float uDif;
  uniform float uBands;
  uniform float uRim;
  uniform float uSpec;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewPos;
  void main(){
    vec4 tc = texture2D(uTex, vUv);
    if(tc.a < 0.1) discard;
    vec3 N = normalize(vNormal);
    vec3 L = normalize(uLight);
    vec3 V = normalize(vViewPos);
    float diff = max(dot(N,L),0.0)*uDif;
    float stepped = floor(diff*uBands)/uBands;
    float spec = step(1.0-uSpec, pow(max(dot(reflect(-L,N),V),0.0),32.0));
    float rim = pow(1.0-max(dot(N,V),0.0),3.0)*uRim;
    rim = step(0.4, rim)*uRim;
    vec3 col = tc.rgb*(uAmb+stepped)+vec3(spec*0.8)+vec3(rim*0.5);
    gl_FragColor = vec4(clamp(col,0.0,1.0), tc.a);
  }
`;

const FRAG_GENSHIN = `
  uniform sampler2D uTex;
  uniform vec3 uLight;
  uniform float uAmb;
  uniform float uHard;
  uniform float uShcol;
  uniform float uRim;
  uniform float uRimcol;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewPos;
  void main(){
    vec4 tc = texture2D(uTex, vUv);
    if(tc.a < 0.1) discard;
    vec3 N = normalize(vNormal);
    vec3 L = normalize(uLight);
    vec3 V = normalize(vViewPos);
    float diff = max(dot(N,L),0.0);
    float shadow = smoothstep(uHard-0.03, uHard+0.03, diff);
    vec3 shadowTint = mix(vec3(0.65,0.7,0.85), vec3(1.0), uShcol);
    vec3 lit = tc.rgb;
    vec3 shd = tc.rgb*shadowTint;
    vec3 col = mix(shd, lit, shadow);
    col = col*(uAmb + shadow*(1.0-uAmb));
    float rim = pow(1.0-max(dot(N,V),0.0),4.0);
    rim = smoothstep(0.5,0.7,rim)*uRim*0.6;
    vec3 rimCol = mix(vec3(1.0), vec3(1.0,0.85,0.6), uRimcol);
    col += rimCol*rim;
    gl_FragColor = vec4(clamp(col,0.0,1.0), tc.a);
  }
`;

// ── OBJ Parser ──────────────────────────────────────────
function parseOBJ(text) {
  const pos=[], uvs=[], nrm=[];
  const outPos=[], outUv=[], outNrm=[];
  const lines = text.split(/\r?\n/);
  for(const line of lines){
    const p = line.trim().split(/\s+/);
    if(p[0]==='v')  pos.push(+p[1],+p[2],+p[3]);
    else if(p[0]==='vt') uvs.push(+p[1],+p[2]);
    else if(p[0]==='vn') nrm.push(+p[1],+p[2],+p[3]);
    else if(p[0]==='f'){
      const verts=p.slice(1).map(s=>{
        const i=s.split('/').map(x=>x?parseInt(x)-1:0);
        return i;
      });
      // triangulate fan
      for(let i=1;i<verts.length-1;i++){
        [verts[0],verts[i],verts[i+1]].forEach(([vi,vti,vni])=>{
          outPos.push(pos[vi*3],pos[vi*3+1],pos[vi*3+2]);
          outUv.push(uvs[vti*2],uvs[vti*2+1]);
          outNrm.push(nrm[vni*3],nrm[vni*3+1],nrm[vni*3+2]);
        });
      }
    }
  }
  return { positions:new Float32Array(outPos), uvs:new Float32Array(outUv), normals:new Float32Array(outNrm) };
}

// ── Build display ────────────────────────────────────────
function buildDisplay() {
  const display = document.getElementById('display');
  display.innerHTML = '';
  KEYS.forEach(key=>{
    const col = document.createElement('div');
    col.className = 'sph-col';

    const canvas = document.createElement('canvas');
    canvas.width = SIZE*DPR; canvas.height = SIZE*DPR;
    canvas.style.width = SIZE+'px'; canvas.style.height = SIZE+'px';
    canvas.id = 'canvas-'+key;

    const label = document.createElement('div');
    label.className = 'sph-label';
    label.style.color = COLORS[key];
    label.textContent = LABELS[key];

    const sub = document.createElement('div');
    sub.className = 'sph-sub';
    sub.textContent = SUBS[key];

    col.appendChild(canvas);
    col.appendChild(label);
    col.appendChild(sub);
    display.appendChild(col);
  });
}

// ── Init Three.js renderers ──────────────────────────────
function initRenderers() {
  KEYS.forEach(key=>{
    const canvas = document.getElementById('canvas-'+key);
    const renderer = new THREE.WebGLRenderer({canvas, antialias:true, alpha:true});
    renderer.setPixelRatio(DPR);
    renderer.setSize(SIZE, SIZE);
    renderer.setClearColor(getBgColor(), 1);
    renderers[key] = renderer;

    const scene = new THREE.Scene();
    scenes[key] = scene;

    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
    camera.position.set(0, 0, 3.5);
    cameras[key] = camera;
  });
}

// ── Load model + texture, setup materials ────────────────
function loadModel() {
  const texLoader = new THREE.TextureLoader();
  const tex = texLoader.load('hair_diffuse.png', ()=>drawAll());

  fetch('lumine_hair.obj')
    .then(r=>r.text())
    .then(text=>{
      const {positions,uvs,normals} = parseOBJ(text);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions,3));
      geo.setAttribute('uv',       new THREE.BufferAttribute(uvs,2));
      geo.setAttribute('normal',   new THREE.BufferAttribute(normals,3));

      // Center and scale
      geo.computeBoundingBox();
      const box = geo.boundingBox;
      const center = new THREE.Vector3();
      box.getCenter(center);
      geo.translate(-center.x,-center.y,-center.z);
      geo.computeBoundingSphere();
      const s = 1.2/geo.boundingSphere.radius;
      geo.scale(s,s,s);

      // Flip UV Y (OBJ convention)
      const uvArr = geo.attributes.uv.array;
      for(let i=1;i<uvArr.length;i+=2) uvArr[i]=1-uvArr[i];
      geo.attributes.uv.needsUpdate=true;

      // PBR material
      uniforms.pbr = {
        uTex:{value:tex}, uLight:{value:getLight()},
        uAmb:{value:S.amb}, uDif:{value:S.dif}, uRough:{value:S.rough}
      };
      const matPBR = new THREE.ShaderMaterial({
        vertexShader:VERT, fragmentShader:FRAG_PBR,
        uniforms:uniforms.pbr, side:THREE.DoubleSide, transparent:true
      });

      // Nintendo material
      uniforms.nintendo = {
        uTex:{value:tex}, uLight:{value:getLight()},
        uAmb:{value:S.amb}, uDif:{value:S.dif},
        uBands:{value:S.bands}, uRim:{value:S.rim}, uSpec:{value:S.spec}
      };
      const matNintendo = new THREE.ShaderMaterial({
        vertexShader:VERT, fragmentShader:FRAG_NINTENDO,
        uniforms:uniforms.nintendo, side:THREE.DoubleSide, transparent:true
      });

      // Genshin material
      uniforms.genshin = {
        uTex:{value:tex}, uLight:{value:getLight()},
        uAmb:{value:S.amb}, uHard:{value:S.hard},
        uShcol:{value:S.shcol}, uRim:{value:S.rim}, uRimcol:{value:S.rimcol}
      };
      const matGenshin = new THREE.ShaderMaterial({
        vertexShader:VERT, fragmentShader:FRAG_GENSHIN,
        uniforms:uniforms.genshin, side:THREE.DoubleSide, transparent:true
      });

      const mats = {pbr:matPBR, nintendo:matNintendo, genshin:matGenshin};

      KEYS.forEach(key=>{
        const mesh = new THREE.Mesh(geo, mats[key]);
        meshes[key] = mesh;
        scenes[key].add(mesh);
        const ambient = new THREE.AmbientLight(0xffffff, 0.1);
        scenes[key].add(ambient);
      });

      updateRot();
      drawAll();
    });
}

// ── Update rotation ──────────────────────────────────────
function updateRot() {
  KEYS.forEach(key=>{
    if(!meshes[key]) return;
    meshes[key].rotation.x = rotX;
    meshes[key].rotation.y = rotY;
  });
}

// ── Update uniforms from state ───────────────────────────
function updateUniforms() {
  const L = getLight();
  if(uniforms.pbr){
    uniforms.pbr.uLight.value = L;
    uniforms.pbr.uAmb.value = S.amb;
    uniforms.pbr.uDif.value = S.dif;
    uniforms.pbr.uRough.value = S.rough;
  }
  if(uniforms.nintendo){
    uniforms.nintendo.uLight.value = L;
    uniforms.nintendo.uAmb.value = S.amb;
    uniforms.nintendo.uDif.value = S.dif;
    uniforms.nintendo.uBands.value = S.bands;
    uniforms.nintendo.uRim.value = S.rim;
    uniforms.nintendo.uSpec.value = S.spec;
  }
  if(uniforms.genshin){
    uniforms.genshin.uLight.value = L;
    uniforms.genshin.uAmb.value = S.amb;
    uniforms.genshin.uHard.value = S.hard;
    uniforms.genshin.uShcol.value = S.shcol;
    uniforms.genshin.uRim.value = S.rim;
    uniforms.genshin.uRimcol.value = S.rimcol;
  }
}

// ── Draw all ─────────────────────────────────────────────
function drawAll() {
  updateUniforms();
  const bg = getBgColor();
  KEYS.forEach(key=>{
    if(!renderers[key]) return;
    renderers[key].setClearColor(bg,1);
    renderers[key].render(scenes[key], cameras[key]);
  });
  if(typeof syncMirrors==='function') syncMirrors();
  const L = getLight();
  const ldir = document.getElementById('ldir');
  if(ldir) ldir.textContent=`L=(${L.x.toFixed(2)},${L.y.toFixed(2)},${L.z.toFixed(2)})`;
}

// ── Mirror canvases ──────────────────────────────────────
const SPHERE_KEYS = KEYS;
document.querySelectorAll('.display-slot').forEach(slot=>{
  const row=document.createElement('div');
  row.style.cssText='display:flex;align-items:flex-end;gap:.85rem;justify-content:center;cursor:grab;user-select:none;margin-bottom:.5rem;';
  KEYS.forEach(key=>{
    const c=document.createElement('canvas');
    c.dataset.mirror=key;
    c.width=SIZE*DPR; c.height=SIZE*DPR;
    c.style.width=SIZE+'px'; c.style.height=SIZE+'px';
    row.appendChild(c);
  });
  slot.insertBefore(row,slot.firstChild);

  let dp=null;
  row.addEventListener('mousedown',e=>{dp={x:e.clientX,y:e.clientY};row.style.cursor='grabbing';e.preventDefault();});
  window.addEventListener('mousemove',e=>{if(!dp)return;rotY-=(e.clientX-dp.x)*0.012;rotX-=(e.clientY-dp.y)*0.012;rotX=Math.max(-Math.PI/2,Math.min(Math.PI/2,rotX));dp={x:e.clientX,y:e.clientY};updateRot();drawAll();});
  window.addEventListener('mouseup',()=>{if(dp){dp=null;row.style.cursor='grab';}});
  row.addEventListener('touchstart',e=>{const t=e.touches[0];dp={x:t.clientX,y:t.clientY};},{passive:true});
  window.addEventListener('touchmove',e=>{if(!dp)return;const t=e.touches[0];rotY-=(t.clientX-dp.x)*0.012;rotX-=(t.clientY-dp.y)*0.012;rotX=Math.max(-Math.PI/2,Math.min(Math.PI/2,rotX));dp={x:t.clientX,y:t.clientY};updateRot();drawAll();},{passive:true});
  window.addEventListener('touchend',()=>{dp=null;});
});

function syncMirrors(){
  KEYS.forEach(key=>{
    const src=document.getElementById('canvas-'+key);
    if(!src) return;
    document.querySelectorAll(`canvas[data-mirror="${key}"]`).forEach(m=>{
      if(m.width!==src.width||m.height!==src.height){m.width=src.width;m.height=src.height;m.style.width=src.style.width;m.style.height=src.style.height;}
      m.getContext('2d').drawImage(src,0,0);
    });
  });
}

// ── Slider wiring ────────────────────────────────────────
function wire(id, key, fmt){
  const el=document.getElementById(id);
  const vl=document.getElementById('v-'+id.replace('sl-',''));
  if(!el) return;
  el.addEventListener('input',()=>{
    S[key]=+el.value;
    if(vl) vl.textContent=fmt(+el.value);
    drawAll();
  });
}
const fDeg=v=>Math.round(v)+'°';
const fF2=v=>v.toFixed(2);
const fF1=v=>v.toFixed(1);
const fInt=v=>Math.round(v)+'';

wire('sl-az','az',fDeg);
wire('sl-el','el',fDeg);
wire('sl-amb','amb',fF2);
wire('sl-dif','dif',fF2);
wire('sl-az-sh','azSh',fDeg);
wire('sl-hard','hard',fF2);
wire('sl-shcol','shcol',fF2);
wire('sl-bands','bands',fInt);
wire('sl-rough','rough',fF2);
wire('sl-rim','rim',fF2);
wire('sl-rimcol','rimcol',fF2);
wire('sl-spec','spec',v=>v.toFixed(3));
wire('sl-shcol2','shcol2',fF2);
wire('sl-facemap','facemap',fF2);
wire('sl-olt','olt',fF1);
wire('sl-oltsens','oltsens',fF2);
wire('sl-normedge','normedge',fF2);

// ── Shape + scene toggles ────────────────────────────────
function wireSeg(id,key,cb){
  const seg=document.getElementById(id);
  if(!seg) return;
  seg.querySelectorAll('button').forEach(btn=>{
    btn.addEventListener('click',()=>{
      seg.querySelectorAll('button').forEach(b=>b.classList.remove('on'));
      btn.classList.add('on');
      S[key]=btn.dataset.val;
      if(cb) cb();
      drawAll();
    });
  });
}
wireSeg('shape-seg','shape');
wireSeg('bg-seg','bg');

// ── Chip wiring ──────────────────────────────────────────
document.querySelectorAll('[data-smode]').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('[data-smode]').forEach(b=>b.classList.remove('on'));
    btn.classList.add('on'); S.shadowMode=btn.dataset.smode; drawAll();
  });
});
document.querySelectorAll('[data-omode]').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('[data-omode]').forEach(b=>b.classList.remove('on'));
    btn.classList.add('on'); S.omode=btn.dataset.omode; drawAll();
  });
});
document.querySelectorAll('[data-ocol]').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('[data-ocol]').forEach(b=>b.classList.remove('on'));
    btn.classList.add('on'); S.ocol=btn.dataset.ocol; drawAll();
  });
});

// ── Section observer ─────────────────────────────────────
const secIndicator=document.getElementById('viewer-section');
const observer=new IntersectionObserver(entries=>{
  entries.forEach(entry=>{
    if(entry.isIntersecting){
      S.tab=entry.target.dataset.tab;
      if(secIndicator) secIndicator.textContent=S.tab;
      drawAll();
    }
  });
},{root:null,rootMargin:'-20% 0px -20% 0px',threshold:0});
document.querySelectorAll('.story-sec').forEach(sec=>observer.observe(sec));

// ── Auto-rotate ──────────────────────────────────────────
let autoRotating=true, lastDrag=0;
function autoRotate(){
  if(autoRotating&&Date.now()-lastDrag>2000){rotY+=0.003;updateRot();drawAll();}
  requestAnimationFrame(autoRotate);
}
document.querySelectorAll('[data-mirror]').forEach(m=>{
  m.parentElement.addEventListener('mousedown',()=>{lastDrag=Date.now();autoRotating=false;});
});
window.addEventListener('mouseup',()=>{autoRotating=true;lastDrag=Date.now();});

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
buildDisplay();
initRenderers();
loadModel();
autoRotate();