const samples = {still:{mode:'still',time:0},idle:{mode:'idle',time:2.3},thinking:{mode:'thinking',time:1.3},dark:{mode:'thinking',time:1.3}};
for (const cell of document.querySelectorAll('#gallery>div')) {
 const svg=cell.querySelector('svg'),label=cell.querySelector('span'),shape=label.textContent;
 const pair=document.createElement('div');pair.className='robot-pair';
 for(const [name,content] of [['Desktop',svg],['Swift',Object.assign(document.createElement('img'),{src:`crops/still-${shape}.png`,alt:`Actual Swift ${shape}`})]]){const f=document.createElement('figure'),caption=document.createElement('figcaption');caption.textContent=name;f.append(content,caption);pair.append(f)}
 label.className='robot-name';cell.replaceChildren(pair,label);cell.dataset.shape=shape;
}
function sample(name){const {mode,time}=samples[name];document.body.classList.toggle('dark',name==='dark');for(const cell of document.querySelectorAll('#gallery>div')){const svg=cell.querySelector('svg');svg.dataset.avatarMode=mode;getComputedStyle(svg).opacity;for(const a of svg.getAnimations({subtree:true})){a.pause();a.currentTime=time*1000}cell.querySelector('img').src=`crops/${name}-${cell.dataset.shape}.png`;}for(const b of document.querySelectorAll('[data-sample]'))b.classList.toggle('selected',b.dataset.sample===name);}
for(const b of document.querySelectorAll('[data-sample]'))b.onclick=()=>sample(b.dataset.sample);
Promise.all(['robot-tests.json','mobile-tests.json','behavior-tests.json'].map(p=>fetch(p).then(r=>r.json()))).then(rows=>{const pass=rows.reduce((sum,r)=>sum+r.passedTests,16);const fail=rows.reduce((sum,r)=>sum+r.failedTests,0);document.querySelector('#test-count').textContent=fail?`${pass} / ${fail} failed`:`${pass} passed`;});
