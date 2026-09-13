import { GoogleApi, type Tool } from '../_shared/google';
export function harness(factory: (api: GoogleApi) => Tool[], responses: Array<any> = []) {
  const requests: Array<{ url: URL; init: RequestInit; json: any; bytes: Buffer }> = [];
  const api = new GoogleApi('https://www.googleapis.com', 'fixture-token', async (input, init) => {
    const body = init?.body;
    const bytes = body instanceof ArrayBuffer ? Buffer.from(body) : ArrayBuffer.isView(body) ? Buffer.from(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength) : Buffer.from(typeof body === 'string' ? body : '');
    let json; try { json = JSON.parse(bytes.toString()); } catch {}
    const request = { url: new URL(String(input)), init: init!, json, bytes };
    requests.push(request);
    if (!responses.length) throw new Error(`Unexpected provider request: ${request.url.pathname}`);
    const next = responses.shift();
    const value = typeof next === 'function' ? await next(request) : next;
    return value instanceof Response ? value : Response.json(value);
  });
  const tools = factory(api);
  return { api, requests, tools, call: async (name: string, args: Record<string, any> = {}) => {
    const tool = tools.find(t => t.name === name);
    if (!tool) throw new Error(`Unknown test tool ${name}`);
    return tool.run(args) as Promise<any>;
  } };
}
