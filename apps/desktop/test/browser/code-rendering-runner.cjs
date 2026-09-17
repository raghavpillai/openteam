const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.setPath('userData', path.join(process.env.CODE_TEST_OUTPUT, 'profile'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1050, height: 760, webPreferences: { backgroundThrottling: false } });
  const wc = win.webContents;
  try {
    await win.loadURL(process.env.CODE_TEST_URL);
    const reports = await wc.executeJavaScript(`(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve,ms));
      const assert = (value, message) => { if(!value) throw Error(message); };
      const settle = async selector => { for(let i=0;i<300;i++){ const el=document.querySelector(selector);if(el)return el;await wait(20); } throw Error('Render timed out: '+selector); };
      let copied; Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>{copied=value}}});
      const reports=[];
      for(const [name,source,language] of [
        ['multiline', 'const answer: number = 42; // fixture\\n'.repeat(5000), 'typescript'],
        ['single line', 'const v = 12; '.repeat(14000), 'javascript'],
        ['unicode CRLF', 'const emoji = "🎉漢字";\\r\\n'.repeat(1100), 'typescript'],
        ['styled tokens', '**bold** and *italic*\\n'.repeat(1000), 'markdown'],
        ['unknown language', 'plain text\\n'.repeat(2000), 'fixture-unknown'],
        ['over source limit', 'large source\\n'.repeat(24000), 'typescript'],
      ]) {
        window.renderCode(source,language);
        const code=await settle('[data-large-code][data-highlighted=true]');
        const expected=source.replace(/\\r\\n/g,'\\n').replace(/\\n+$/,'');
        assert(code.textContent===expected, name+': full source changed');
        const range=document.createRange();range.selectNodeContents(code);getSelection().removeAllRanges();getSelection().addRange(range);
        assert(getSelection().toString()===expected,name+': selection truncated');
        const box=code.closest('[data-streamdown="code-block-body"]');
        box.scrollTop=box.scrollHeight;box.scrollLeft=box.scrollWidth;await wait(100);
        assert(getSelection().toString()===expected,name+': scrolling destroyed selection');getSelection().removeAllRanges();
        code.closest('[data-streamdown="code-block"]').querySelector('button').click();await wait(20);
        assert(copied===source.replace(/\\r\\n/g,'\\n')+'\\n',name+': copy changed');
        const ranges=[...CSS.highlights.values()].reduce((n,h)=>n+h.size,0);
        assert(ranges>0&&ranges<2000,name+': unbounded ranges '+ranges);
        for(const theme of ['light','dark']) {
          document.documentElement.dataset.theme=theme;await wait(20);
          const name=[...CSS.highlights.keys()][0];
          assert(getComputedStyle(code,'::highlight('+name+')').color!=='', 'Highlight style missing');
          if(language==='markdown') {
            const fonts=[...code.querySelectorAll('.bot-code-font')];
            assert(fonts.some(el=>getComputedStyle(el).fontWeight===(theme==='dark'?'700':'400')),'Theme font weight changed');
            if(theme==='dark') assert(fonts.some(el=>getComputedStyle(el).fontStyle==='italic'),'Dark italic tokens lost font styling');
          }
        }
        reports.push({name,characters:expected.length,ranges,codeElements:code.querySelectorAll('*').length});
        window.renderCode(null);await wait(30);assert(CSS.highlights.size===0,name+': leaked highlights');
      }
      document.documentElement.style.setProperty('--fixture-width','320px');
      window.renderCode('['+'1,'.repeat(9000)+'2]', 'json');
      const resizedCode=await settle('[data-large-code][data-highlighted=true]');
      const resizedBox=resizedCode.closest('[data-streamdown="code-block-body"]');
      resizedBox.scrollLeft=1000;await wait(100);
      const lastHighlightedOffset=()=>Math.max(...[...CSS.highlights.values()].flatMap(h=>[...h].map(r=>r.endOffset)));
      const narrowEnd=lastHighlightedOffset();
      const originalScroll=resizedBox.scrollLeft;
      document.documentElement.style.setProperty('--fixture-width','1000px');await wait(150);
      const wideEnd=lastHighlightedOffset();
      assert(resizedBox.scrollLeft===originalScroll,'Width resize changed the horizontal reading position');
      assert(wideEnd>narrowEnd+40,'Widening a long code line left newly visible tokens unhighlighted: '+JSON.stringify({narrowEnd,wideEnd,scroll:resizedBox.scrollLeft,width:resizedBox.clientWidth,scrollWidth:resizedBox.scrollWidth,ranges:[...CSS.highlights.values()].map(h=>[h.size,[...h].slice(0,2).map(r=>[r.startOffset,r.endOffset])]),textLength:resizedCode.textContent.length,codeBox:resizedCode.getBoundingClientRect().toJSON()}));
      reports.push({name:'long code line repaints newly visible tokens after resize',narrowEnd,wideEnd});
      window.renderCode(null);await wait(20);document.documentElement.style.removeProperty('--fixture-width');
      for(let i=0;i<30;i++) {
        window.renderCode(('const value = '+i+';\\n').repeat(1200));await settle('[data-highlighted=true]');
        window.renderCode(null);await wait(20);assert(CSS.highlights.size===0,'Soak leaked highlights');
      }
      const stats=window.getCodeHighlighterCacheStats();assert(stats.tokenCost<=8*1024*1024,'Token cache exceeded bound');
      reports.push({name:'30 mount/unmount cycles',stats});
      window.clearCodeHighlighterCaches();
      const OriginalWorker=window.Worker;window.Worker=class { constructor(){throw Error('Synthetic worker failure');} };
      window.renderCode('const fallback = true;\\n'.repeat(1000));await settle('[data-highlighted=true]');
      assert(document.querySelector('[data-large-code]').textContent.includes('const fallback = true;'),'Worker failure hid content');
      window.Worker=OriginalWorker;window.renderCode(null);await wait(20);assert(CSS.highlights.size===0,'Fallback leaked highlights');
      reports.push({name:'worker failure keeps full content readable'});
      const fence=String.fromCharCode(96).repeat(3);
      window.renderMarkdown('# Mixed content\\n\\n日本語 and **bold** with '+String.fromCharCode(96)+'inline'+String.fromCharCode(96)+' and [settings](openteam://app/v1/settings?id=theme).\\n\\n| A | B |\\n|---|---|\\n| one | two |\\n\\n$$\\nx^2 + y^2\\n$$\\n\\n'+fence+'mermaid\\ngraph TD; A-->B\\n'+fence+'\\n\\n'+fence+'typescript\\nconst short = 42;\\n'+fence);
      await settle('[data-streamdown="mermaid"] svg');await settle('.katex');await settle('[data-streamdown="code-block"]');
      assert(document.querySelector('[data-streamdown="inline-code"]').textContent==='inline','Inline code changed');
      assert(document.querySelectorAll('[data-streamdown="table-cell"]').length===2,'Table cells disappeared');
      assert(document.body.textContent.includes('日本語'),'CJK content disappeared');
      let deepLink;const follow=e=>{deepLink=e.detail.url};window.addEventListener('openteam:deep-link',follow);
      document.querySelector('button[aria-label="Open settings"]').click();
      window.removeEventListener('openteam:deep-link',follow);
      assert(deepLink==='openteam://app/v1/settings?id=theme','Application link changed');
      assert(document.querySelector('[data-streamdown="mermaid-block-actions"]').querySelectorAll('button').length>=2,'Mermaid controls disappeared');
      reports.push({name:'mixed code, inline code, tables, CJK, math, Mermaid controls and app links'});
      window.renderCode('const findMe = 42;\\n'.repeat(1500));await settle('[data-highlighted=true]');
      return reports;
    })()`);
    const found = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Native find timed out')), 5000);
      const listener = (_event, result) => { if(result.finalUpdate) { clearTimeout(timer);wc.removeListener('found-in-page',listener);resolve(result); } };
      wc.on('found-in-page', listener);
    });
    wc.findInPage('findMe');
    const result = await found;
    if(result.matches!==1500)throw Error('Native find did not search all lines: '+result.matches);
    reports.push({name:'native find across all code lines', matches:result.matches});
    await wc.capturePage().then(image => fs.writeFileSync(path.join(process.env.CODE_TEST_OUTPUT,'screen.png'),image.toPNG()));
    fs.writeFileSync(path.join(process.env.CODE_TEST_OUTPUT,'results.json'),JSON.stringify({reports},null,2));
    app.exit(0);
  } catch(error) {
    fs.writeFileSync(path.join(process.env.CODE_TEST_OUTPUT,'results.json'),JSON.stringify({error:String(error),stack:error.stack}));app.exit(1);
  }
});
