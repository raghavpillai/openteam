let renderVersion=0,lastHeight=0,lastWidth=0,mathTokens=[],activeLease="",layoutReady=false,lastReady=false;
marked.use({extensions:[
  {name:'mathDisplay',level:'block',start:src=>src.indexOf('$$'),tokenizer(src){const m=/^\$\$([\s\S]+?)\$\$(?:\n|$)/.exec(src);if(m)return {type:'mathDisplay',raw:m[0],text:m[1]}},renderer(token){const index=mathTokens.push({text:token.text,display:true})-1;return '<div class="math-placeholder math-index-'+index+'"></div>'}},
  {name:'mathInline',level:'inline',start(src){const match=/\$|\\[([]/.exec(src);return match?.index},tokenizer(src){const m=/^\$([^\s$](?:[^$\n]*?[^\s$])?)\$(?!\d)|^\\\(([\s\S]+?)\\\)|^\\\[([\s\S]+?)\\\]/.exec(src);if(m)return {type:'mathInline',raw:m[0],text:m[1]??m[2]??m[3],display:!!m[3]}},renderer(token){const index=mathTokens.push({text:token.text,display:token.display})-1;return '<span class="math-placeholder math-index-'+index+'"></span>'}}
]});
function reportHeight(){const bounds=document.getElementById('message').getBoundingClientRect(),h=Math.ceil(bounds.height),width=bounds.width;if(h!==lastHeight||width!==lastWidth||layoutReady!==lastReady){lastHeight=h;lastWidth=width;lastReady=layoutReady;window.webkit?.messageHandlers?.height?.postMessage({height:h,width,lease:activeLease,ready:layoutReady})}}
// Phone-width tables: short columns (dates, amounts, statuses) stay on one line,
// prose columns wrap only between words, and a wide table scrolls in its own strip.
function layoutTable(table){
  const scroll=document.createElement('div');scroll.className='table-scroll';table.replaceWith(scroll);scroll.append(table);
  const rows=Array.from(table.rows),columns=Math.max(0,...rows.map(row=>row.cells.length));
  for(let column=0;column<columns;column++){
    const cells=rows.map(row=>row.cells[column]).filter(Boolean),longest=Math.max(0,...cells.map(cell=>cell.textContent.trim().length));
    for(const cell of cells)cell.classList.add(longest<=20?'cell-nowrap':'cell-wrap');
  }
  scroll.addEventListener('scroll',()=>updateTableEdges(scroll),{passive:true});
}
// Fade whichever edge hides columns, so a clipped table reads as scrollable.
function updateTableEdges(scroll){const hidden=scroll.scrollWidth-scroll.clientWidth;scroll.classList.toggle('more-left',scroll.scrollLeft>1);scroll.classList.toggle('more-right',scroll.scrollLeft<hidden-1)}
// Prose columns read best at their full minimum width, but narrow when that alone
// would make the table scroll. A table that scrolls anyway keeps readable prose.
function fitTable(scroll){scroll.classList.remove('compact');if(scroll.scrollWidth>scroll.clientWidth+1){scroll.classList.add('compact');if(scroll.scrollWidth>scroll.clientWidth+1)scroll.classList.remove('compact')}updateTableEdges(scroll)}
new ResizeObserver(()=>{for(const scroll of document.getElementById('message').querySelectorAll('.table-scroll'))fitTable(scroll);reportHeight()}).observe(document.getElementById('message'));
// Native code opens link actions on a long press, so it needs the link under the
// finger; the pressed link is shaded meanwhile. Lifting the finger after a long
// press (the bubble's 0.45 s gesture) must not also follow the link.
let touchStarted=0,touchOrigin=null,pressedLink=null;
function linkChannel(body){window.webkit?.messageHandlers?.link?.postMessage(body)}
function releaseLink(){if(!pressedLink)return;pressedLink.classList.remove('pressed');pressedLink=null;linkChannel({pressed:null})}
document.addEventListener?.('touchstart',event=>{
  touchStarted=Date.now();releaseLink();
  const touch=event.touches[0],link=event.target.closest?.('a[href]');
  touchOrigin=touch?{x:touch.clientX,y:touch.clientY}:null;
  if(link&&event.touches.length===1){pressedLink=link;link.classList.add('pressed');linkChannel({pressed:link.href})}
},{passive:true,capture:true});
document.addEventListener?.('touchmove',event=>{const touch=event.touches[0];if(pressedLink&&touchOrigin&&touch&&Math.hypot(touch.clientX-touchOrigin.x,touch.clientY-touchOrigin.y)>10)releaseLink()},{passive:true,capture:true});
document.addEventListener?.('touchend',()=>setTimeout(releaseLink,0),{passive:true,capture:true});
document.addEventListener?.('touchcancel',releaseLink,{passive:true,capture:true});
document.addEventListener?.('click',event=>{if(event.target.closest?.('a')&&Date.now()-touchStarted>=450)event.preventDefault()},true);
// A site icon before each web link. The page loads no network images, so native
// code supplies icons as data URLs. A pulsing skeleton holds the same space until
// then, and a globe replaces it when the site has no icon.
const faviconCache=new Map(),faviconBlank='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',faviconFallback="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238e8e93' stroke-width='1.6'%3E%3Ccircle cx='12' cy='12' r='9'/%3E%3Cpath d='M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z'/%3E%3C/svg%3E";
function decorateLinks(root){
  const missing=new Set();
  for(const link of root.querySelectorAll('a[href]')){
    let url;try{url=new URL(link.href)}catch{continue}
    if(url.protocol!=='https:'&&url.protocol!=='http:')continue;
    const host=url.hostname.toLowerCase(),icon=document.createElement('img');
    icon.alt='';icon.dataset.host=host;showFavicon(icon,faviconCache.has(host)?faviconCache.get(host):undefined);link.prepend(icon);
    if(!faviconCache.has(host))missing.add(host);
  }
  if(missing.size)linkChannel({favicons:[...missing]});
}
// undefined: still loading; null: the site has no icon.
function showFavicon(icon,src){icon.className='favicon'+(src===undefined?' loading':src===null?' missing':'');icon.src=src===undefined?faviconBlank:src??faviconFallback}
window.setFavicon=function(host,src){faviconCache.set(host,src);for(const icon of document.querySelectorAll('img.favicon'))if(icon.dataset.host===host)showFavicon(icon,src)};
window.renderMessage=async function(source,dark,fontSize,colors,lease,delay=0){
  activeLease=lease;lastHeight=-1;lastWidth=-1;layoutReady=false;
  const version=++renderVersion,root=document.getElementById('message');
  if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
  if(version!==renderVersion)return;
  for(const [role,value] of Object.entries(colors))document.body.style.setProperty('--'+role,value);
  document.body.style.color=colors.text;document.body.style.fontSize=fontSize+'px';
  // Never trust model-produced HTML or links. Network requests are also disabled by CSP.
  mathTokens=[];
  root.innerHTML=DOMPurify.sanitize(marked.parse(source,{gfm:true,breaks:true}),{FORBID_TAGS:['style','iframe','form','input','img','video','audio','object','embed'],FORBID_ATTR:['style','src','srcset'],ALLOW_DATA_ATTR:false});
  decorateLinks(root);
  for(const table of root.querySelectorAll('table'))layoutTable(table);
  for(const node of root.querySelectorAll('.math-placeholder')){const index=Number(Array.from(node.classList).find(c=>c.startsWith('math-index-'))?.slice(11)),token=mathTokens[index];if(token)katex.render(token.text,node,{displayMode:token.display,throwOnError:false,trust:false,strict:'warn',maxExpand:1000})}

  if(root.querySelector("code.language-mermaid")) mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'base',themeVariables:{darkMode:dark,background:'transparent',primaryColor:colors.code,primaryTextColor:colors.text,primaryBorderColor:colors.muted,secondaryColor:colors.code,tertiaryColor:colors.code,lineColor:colors.muted,textColor:colors.text},maxTextSize:50000,htmlLabels:false,flowchart:{htmlLabels:false},suppressErrorRendering:true});
  let index=0;
  for(const node of Array.from(root.querySelectorAll('code.language-mermaid'))){
    const text=node.textContent,host=node.parentElement;
    try{const {svg}=await mermaid.render('diagram-'+version+'-'+index++,text);if(version!==renderVersion)return;const div=document.createElement('div');div.innerHTML=DOMPurify.sanitize(svg,{USE_PROFILES:{svg:true,svgFilters:true},FORBID_TAGS:['foreignObject'],FORBID_ATTR:['href','xlink:href','onload']});host.replaceWith(div)}
    catch{if(version!==renderVersion)return;host.classList.add('diagram-error');host.textContent='Diagram could not be rendered.\n'+text}
  }
  // Font metrics (especially math) must settle before native history is revealed.
  await document.fonts.ready;
  if(version===renderVersion){for(const scroll of root.querySelectorAll('.table-scroll'))fitTable(scroll);layoutReady=true;reportHeight()}
};
