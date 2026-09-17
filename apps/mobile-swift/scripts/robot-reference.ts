import {ROBOT_AVATAR_ARTWORK,robotAvatarTempo,ROBOT_AVATAR_VIEW_BOX,robotAvatarFaceColor,type RobotAvatarNode} from '../../../packages/design-tokens/src/robot-avatar-artwork';
import {ROBOT_AVATAR_SHAPES,type RobotAvatarShape,type BotAvatarMode} from '../../../packages/contracts/src/robot-avatar';
import {createRobotAvatarMotion} from '../../../packages/design-tokens/src/robot-avatar-motion';
// reference.html loads the unmodified desktop robot-avatar.css beside this script.
const svgNS='http://www.w3.org/2000/svg';
function element(node:RobotAvatarNode,id:string):SVGElement {
 const el=document.createElementNS(svgNS,node.tag);
 for(const [k,v]of Object.entries(node.attributes)){
  if(k==='style'){Object.assign(el.style,v);continue;}
  el.setAttribute(k.replace(/[A-Z]/g,m=>'-'+m.toLowerCase()),String(v));
 }
 el.dataset.nodeId=id;
 node.children?.forEach((n,i)=>el.appendChild(element(n,id+'/'+i)));
 return el;
}
function robot(shape:RobotAvatarShape,size=190) {
 const svg=document.createElementNS(svgNS,'svg');svg.setAttribute('viewBox',ROBOT_AVATAR_VIEW_BOX);
 svg.setAttribute('width',String(size));svg.setAttribute('height',String(size));svg.classList.add('robot-avatar');svg.dataset.avatarMode='still';
 svg.style.cssText=`color:#ff7a1a;--robot-face:${robotAvatarFaceColor('#ff7a1a')};--robot-tempo:${robotAvatarTempo(shape)}s;overflow:visible`;
 const body=document.createElementNS(svgNS,'g');body.classList.add('robot-avatar-body');body.dataset.nodeId='body';
 ROBOT_AVATAR_ARTWORK[shape].forEach((n,i)=>body.appendChild(element(n,String(i))));svg.appendChild(body);
 return svg;
}
let shape:RobotAvatarShape='classic';let svg=robot(shape);document.querySelector('#stage')!.appendChild(svg);
let motion=createRobotAvatarMotion(svg);motion.setMode('idle',false);
let currentMode:BotAvatarMode='idle';
for(const name of ['still','idle','thinking'] as const){const b=document.createElement('button');b.textContent=name;b.onclick=()=>{currentMode=name;motion.setMode(name);document.querySelector('#mode')!.textContent=name};document.querySelector('#modes')!.appendChild(b);}
for(const name of ROBOT_AVATAR_SHAPES){const b=document.createElement('button');b.textContent=name;b.onclick=()=>{motion.dispose();shape=name;svg.replaceWith(svg=robot(shape));motion=createRobotAvatarMotion(svg);motion.setMode(currentMode);document.querySelector('#shape')!.textContent=shape};document.querySelector('#shapes')!.appendChild(b);}
for(const name of ROBOT_AVATAR_SHAPES){const cell=document.createElement('div');cell.appendChild(robot(name,96));const label=document.createElement('span');label.textContent=name;cell.appendChild(label);document.querySelector('#gallery')!.appendChild(cell);}
function poses(svg:SVGSVGElement){return [...svg.querySelectorAll<SVGElement>('.robot-avatar-body,[data-p]')].map(el=>{const c=getComputedStyle(el);const m=new DOMMatrix(c.transform);const b=el.getBBox();return{id:el.dataset.nodeId,matrix:[m.a,m.b,m.c,m.d,m.e,m.f],opacity:Number(c.opacity),origin:c.transformOrigin,bounds:[b.x,b.y,b.width,b.height]}})}
const times=[0,0.05,0.159,0.16,0.21,0.319,0.32,0.55,0.7,1.1,1.2,1.3,1.7,2.1,2.3,3.2,4.6,6.4,7.9,9.4];
document.querySelector('#export')!.addEventListener('click',async()=>{
 const rows:unknown[]=[];const sandbox=document.createElement('div');sandbox.style.cssText='position:absolute;left:-1000px;top:0';document.body.appendChild(sandbox);
 for(const shape of ROBOT_AVATAR_SHAPES){const r=robot(shape);sandbox.appendChild(r);for(const mode of ['still','idle','thinking'] as const){r.dataset.avatarMode=mode;getComputedStyle(r).opacity;const animations=r.getAnimations({subtree:true});animations.forEach(a=>a.pause());
  for(const time of times){animations.forEach(a=>a.currentTime=time*1000);rows.push({shape,mode,time,parts:poses(r),faces:[...r.querySelectorAll<SVGGraphicsElement>('[style*="perspective"]')].map(el=>{const m=el.parentElement!.getCTM()!.inverse().multiply(el.getCTM()!);return{id:el.dataset.nodeId,matrix:[m.a,m.b,m.c,m.d,m.e,m.f]}}),...(mode==='still'&&time===0?{geometry:[...r.querySelectorAll<SVGGraphicsElement>('[data-node-id]')].map(el=>{const c=getComputedStyle(el),b=el.getBBox();const m=el.getCTM();return{id:el.dataset.nodeId,origin:c.transformOrigin,transform:c.transform,bounds:[b.x,b.y,b.width,b.height],ctm:m?[m.a,m.b,m.c,m.d,m.e,m.f,m.m14,m.m24,m.m34,m.m44]:null}})}:{})});}
 }r.remove();}
 sandbox.remove();await fetch('/capture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'poses',rows})});
 document.querySelector('#status')!.textContent=`Saved ${rows.length} reference frames from our desktop CSS.`;
});
