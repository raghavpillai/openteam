import { expect, test } from 'bun:test';
import { createJimp } from '@jimp/core';
import png from '@jimp/js-png';
import { repairImageHistory } from '../src/runtime/image-input';
const Jimp = createJimp({ formats: [png] });

test('model history preserves graphical screenshot coordinates but still bounds ordinary images', async () => {
  const bytes = await new Jimp({width:1280,height:800,color:0xffffffff}).getBuffer('image/png');
  for (const toolName of ['Computer', 'browser_snapshot', 'browser_click', 'Read']) {
    const message = { role:'toolResult',toolName,content:[{type:'image',data:bytes.toString('base64'),mimeType:'image/png'}] };
    const [result] = await repairImageHistory([message]);
    const image = await Jimp.read(Buffer.from(result!.content[0]!.data,'base64'));
    expect([image.width,image.height]).toEqual(toolName==='Read'?[1024,640]:[1280,800]);
    expect(message.content[0]!.data).toBe(bytes.toString('base64'));
    expect((await repairImageHistory([message]))[0]).toBe(result);
  }
});

test('large graphical screenshots reduce encoding size without moving coordinates', async () => {
  const image = new Jimp({width:1280,height:800,color:0xffffffff});
  let seed=924;
  for(let i=0;i<image.bitmap.data.length;i+=4) {
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    image.bitmap.data[i]=seed&255; image.bitmap.data[i+1]=(seed>>>8)&255;
    image.bitmap.data[i+2]=(seed>>>16)&255;
  }
  const bytes=await image.getBuffer('image/png');
  expect(bytes.length).toBeGreaterThan(1024*1024);
  const [result]=await repairImageHistory([{role:'toolResult',toolName:'Computer',content:[{type:'image',data:bytes.toString('base64'),mimeType:'image/png'}]}]);
  const part=result!.content[0]!;
  expect(part.type).toBe('image');
  const output=Buffer.from(part.data,'base64');
  expect(output.length).toBeLessThanOrEqual(1024*1024);
  // JPEG SOF dimensions are checked using the same decoder used at the boundary.
  const { createJimp: factory } = await import('@jimp/core');
  const { default: jpeg } = await import('@jimp/js-jpeg');
  const decoded=await factory({formats:[jpeg]}).read(output);
  expect([decoded.width,decoded.height]).toEqual([1280,800]);
});

test('invalid graphical images are still omitted', async()=>{
  const [result]=await repairImageHistory([{role:'toolResult',toolName:'Computer',content:[{type:'image',data:Buffer.from('invalid').toString('base64'),mimeType:'image/png'}]}]);
  expect(result!.content[0]!.type).toBe('text');
});
