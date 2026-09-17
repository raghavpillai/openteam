import { ROBOT_AVATAR_ARTWORK, robotAvatarTempo, ROBOT_AVATAR_VIEW_BOX, type RobotAvatarNode } from '../../../packages/design-tokens/src/robot-avatar-artwork';
import { ROBOT_AVATAR_SHAPES, ROBOT_AVATAR_LABELS } from '../../../packages/contracts/src/robot-avatar';
import { BOT_AVATAR_COLORS } from '../../../packages/contracts/src/bot-avatar';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root=resolve(import.meta.dir,'../../..');
type Bounds=[number,number,number,number];
function bounds(node:RobotAvatarNode):Bounds {
 const a=node.attributes,n=(k:string)=>Number(a[k]??0);
 switch(node.tag){
 case 'rect': return [n('x'),n('y'),n('x')+n('width'),n('y')+n('height')];
 case 'circle': return [n('cx')-n('r'),n('cy')-n('r'),n('cx')+n('r'),n('cy')+n('r')];
 case 'line': return [Math.min(n('x1'),n('x2')),Math.min(n('y1'),n('y2')),Math.max(n('x1'),n('x2')),Math.max(n('y1'),n('y2'))];
 case 'polygon': { const p=String(a.points).split(/[\s,]+/).map(Number), xs=p.filter((_,i)=>i%2===0),ys=p.filter((_,i)=>i%2===1); return [Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)]; }
 default: {const b=(node.children??[]).map(child=>{
   const box=bounds(child),style=(child.attributes.style??{}) as Record<string,string>;
   if(!style.transform?.includes('perspective'))return box;
   const x=(box[0]+box[2])/2,y=(box[1]+box[3])/2,c=Math.cos(14*Math.PI/180),p=Math.sin(14*Math.PI/180)/300;
   const a=c+x*p,b=y*p,tx=2*c+x*(1+2*p)-a*x,ty=y*2*p-b*x;
   const corners=[[box[0],box[1]],[box[2],box[1]],[box[2],box[3]],[box[0],box[3]]];
   const xs=corners.map(([u])=>a*u!+tx),ys=corners.map(([u,v])=>b*u!+v!+ty);
   return [Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)] as Bounds;
 });return b.length?[Math.min(...b.map(a=>a[0])),Math.min(...b.map(a=>a[1])),Math.max(...b.map(a=>a[2])),Math.max(...b.map(a=>a[3]))]:[50,50,50,50];}
 }
}
function convert(node:RobotAvatarNode,id:string,index:number,shape:string,paint:Record<string,string|number>={fill:'currentColor',stroke:'none',strokeWidth:1,strokeLinecap:'butt',strokeLinejoin:'miter'}):unknown {
 const a=node.attributes,style=(a.style??{}) as Record<string,string>,b=bounds(node);
 const p={...paint};for(const k of Object.keys(p))if(a[k]!==undefined)p[k]=a[k] as string|number;
 const geometry=Object.fromEntries(Object.entries(a).filter(([k])=>['x','y','width','height','rx','ry','cx','cy','r','x1','x2','y1','y2'].includes(k)).map(([k,v])=>[k,Number(v)]));
 let origin=[(b[0]+b[2])/2,(b[1]+b[3])/2];
 if(style.transformOrigin==='50% 90%')origin[1]=b[1]+(b[3]-b[1])*.9;
 if(style.transformOrigin==='50% 0')origin[1]=b[1];
 if(style.transformOrigin==='left center')origin[0]=b[0];

 return {id,tag:node.tag,geometry,points:String(a.points??'').split(/[\s,]+/).filter(Boolean).map(Number),...p,strokeWidth:Number(p.strokeWidth),opacity:Number(a.opacity??1),part:String(a['data-p']??''),limit:Number(a['data-lim']??0),hiddenWhenThinking:a['data-hide']==='1',perspective:style.transform?.includes('perspective')??false,transform:String(a.transform??''),origin,index,children:node.children?.map((c,i)=>convert(c,`${id}/${i}`,i,shape,p))??[]};
}
const sourceFiles=['packages/design-tokens/src/robot-avatar-artwork.ts','packages/design-tokens/src/robot-avatar.css','packages/design-tokens/src/robot-avatar-motion.ts','packages/contracts/src/robot-avatar.ts','packages/contracts/src/bot-avatar.ts'];
const data={viewBox:ROBOT_AVATAR_VIEW_BOX,colors:BOT_AVATAR_COLORS,sources:Object.fromEntries(sourceFiles.map(p=>[p,createHash('sha256').update(readFileSync(resolve(root,p))).digest('hex')])),shapes:Object.fromEntries(ROBOT_AVATAR_SHAPES.map(shape=>[shape,{label:ROBOT_AVATAR_LABELS[shape],tempo:robotAvatarTempo(shape),nodes:ROBOT_AVATAR_ARTWORK[shape].map((n,i)=>convert(n,String(i),i,shape))}]))};
const path=resolve(import.meta.dir,'../Sources/Core/Resources/RobotArtwork.json');
const contents=JSON.stringify(data,null,2)+'\n';
if(process.argv.includes('--check')) {if(readFileSync(path,'utf8')!==contents)throw new Error('RobotArtwork.json is stale; run bun apps/mobile-swift/scripts/export-robot-artwork.ts');}
else writeFileSync(path,contents);
console.log(`${process.argv.includes('--check')?'Verified':'Exported'} ${ROBOT_AVATAR_SHAPES.length} desktop robot designs.`);
