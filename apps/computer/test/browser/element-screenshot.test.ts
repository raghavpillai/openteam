import {expect,test} from 'bun:test';
import {BrowserUseSession,BROWSER_USE_TOOLS} from '../../src/browser/use';

test('screenshot contract exposes element target without changing viewport defaults',()=>{
 const tool=BROWSER_USE_TOOLS.find(t=>t.name==='browser_take_screenshot')!;
 const props=(tool.inputSchema as any).properties;
 expect(props.target.type).toBe('string');expect(props.element.type).toBe('string');
 expect(props.fullPage.type).toBe('boolean');expect(props.viewId.type).toBe('string');
});

test('element screenshot rejects combining target and full page before capturing',async()=>{
 let captures=0;
 const owner={ensurePage:async()=>({}),viewId:()=>undefined,pageState:async()=>{captures++;return {};}};
 await expect((BrowserUseSession.prototype as any).takeScreenshot.call(owner,{target:'main',fullPage:true}))
  .rejects.toThrow('fullPage cannot be used with element screenshots');
 expect(captures).toBe(0);
});
