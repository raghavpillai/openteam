let renderVersion=0,lastHeight=0,mathTokens=[],activeLease="";
marked.use({extensions:[
  {name:'mathDisplay',level:'block',start:src=>src.indexOf('$$'),tokenizer(src){const m=/^\$\$([\s\S]+?)\$\$(?:\n|$)/.exec(src);if(m)return {type:'mathDisplay',raw:m[0],text:m[1]}},renderer(token){const index=mathTokens.push({text:token.text,display:true})-1;return '<div class="math-placeholder math-index-'+index+'"></div>'}},
  {name:'mathInline',level:'inline',start(src){const match=/\$|\\[([]/.exec(src);return match?.index},tokenizer(src){const m=/^\$([^\s$](?:[^$\n]*?[^\s$])?)\$(?!\d)|^\\\(([\s\S]+?)\\\)|^\\\[([\s\S]+?)\\\]/.exec(src);if(m)return {type:'mathInline',raw:m[0],text:m[1]??m[2]??m[3],display:!!m[3]}},renderer(token){const index=mathTokens.push({text:token.text,display:token.display})-1;return '<span class="math-placeholder math-index-'+index+'"></span>'}}
]});
function reportHeight(){const h=Math.ceil(document.getElementById('message').getBoundingClientRect().height);if(h!==lastHeight){lastHeight=h;window.webkit?.messageHandlers?.height?.postMessage({height:h,lease:activeLease})}}
new ResizeObserver(reportHeight).observe(document.getElementById('message'));
window.renderMessage=async function(source,dark,fontSize,colors,lease){
  activeLease=lease;lastHeight=-1;
  const version=++renderVersion,root=document.getElementById('message');
  for(const [role,value] of Object.entries(colors))document.body.style.setProperty('--'+role,value);
  document.body.style.color=colors.text;document.body.style.fontSize=fontSize+'px';
  // Never trust model-produced HTML or links. Network requests are also disabled by CSP.
  mathTokens=[];
  root.innerHTML=DOMPurify.sanitize(marked.parse(source,{gfm:true,breaks:true}),{FORBID_TAGS:['style','iframe','form','input','img','video','audio','object','embed'],FORBID_ATTR:['style','src','srcset'],ALLOW_DATA_ATTR:false});
  for(const node of root.querySelectorAll('.math-placeholder')){const index=Number(Array.from(node.classList).find(c=>c.startsWith('math-index-'))?.slice(11)),token=mathTokens[index];if(token)katex.render(token.text,node,{displayMode:token.display,throwOnError:false,trust:false,strict:'warn',maxExpand:1000})}

  if(root.querySelector("code.language-mermaid")) mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'base',themeVariables:{darkMode:dark,background:'transparent',primaryColor:colors.code,primaryTextColor:colors.text,primaryBorderColor:colors.muted,secondaryColor:colors.code,tertiaryColor:colors.code,lineColor:colors.muted,textColor:colors.text},maxTextSize:50000,htmlLabels:false,flowchart:{htmlLabels:false},suppressErrorRendering:true});
  let index=0;
  for(const node of Array.from(root.querySelectorAll('code.language-mermaid'))){
    const text=node.textContent,host=node.parentElement;
    try{const {svg}=await mermaid.render('diagram-'+version+'-'+index++,text);if(version!==renderVersion)return;const div=document.createElement('div');div.innerHTML=DOMPurify.sanitize(svg,{USE_PROFILES:{svg:true,svgFilters:true},FORBID_TAGS:['foreignObject'],FORBID_ATTR:['href','xlink:href','onload']});host.replaceWith(div)}
    catch{if(version!==renderVersion)return;host.classList.add('diagram-error');host.textContent='Diagram could not be rendered.\n'+text}
  }
  if(version===renderVersion){reportHeight();document.fonts.ready.then(reportHeight)}
};
