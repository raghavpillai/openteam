import { spawn } from 'node:child_process';
import { nodeBinary } from '../node-runtime';

/** Isolate user-supplied regex execution so a pathological pattern cannot stall the tool host. */
export async function findPageLines(lines: string[], args: Record<string, unknown>): Promise<{count: number; truncated: boolean; lines: string[]}> {
  const query = args.text ?? args.regex;
  if ((args.text !== undefined) === (args.regex !== undefined) || typeof query !== 'string' || !query.length || query.length > 500)
    throw new Error('Supply exactly one nonempty text or regex query (at most 500 characters).');
  const limit = args.maxResults ?? 20;
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 100) throw new Error('maxResults must be 1–100.');
  let source = query, flags = '';
  if (args.regex !== undefined) {
    if (query.startsWith('/')) {
      const end = query.lastIndexOf('/');
      if (end <= 0) throw new Error('Invalid /pattern/flags regex.');
      source = query.slice(1, end); flags = query.slice(end + 1);
    }
    try { new RegExp(source, flags); } catch { throw new Error('Invalid JavaScript regex.'); }
  }
  if (!lines.length) return {count: 0, truncated: false, lines: []};
  return new Promise((resolve, reject) => {
    const worker = spawn(nodeBinary(), ['-e', `
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => input += chunk);
      process.stdin.on('end', () => {
      const d = JSON.parse(input);
      const re = d.regex ? new RegExp(d.source, d.flags) : null;
      let count = 0; const selected = new Set();
      d.lines.forEach((line, i) => {
        if (re) re.lastIndex = 0;
        if (re ? re.test(line) : line.toLowerCase().includes(d.source.toLowerCase())) {
          count++;
          if (count <= d.limit) for (let j = Math.max(0, i - 2); j <= Math.min(d.lines.length - 1, i + 2); j++) selected.add(j);
        }
      });
      let length = 0, cut = false;
      const output = [...selected].sort((a,b)=>a-b).flatMap(i => {
        const line = (i + 1) + ': ' + d.lines[i];
        if (length + line.length > 40000) { cut = true; return []; }
        length += line.length; return [line];
      });
      process.stdout.write(JSON.stringify({count, truncated: count > d.limit || cut, lines: output}));
      });
    `], {stdio: ['pipe', 'pipe', 'pipe']});
    const timer = setTimeout(() => { worker.kill('SIGKILL'); reject(new Error('Regex search exceeded its time limit; simplify the pattern.')); }, 1000);
    let output = '';
    worker.stdout.setEncoding('utf8');
    worker.stdout.on('data', chunk => { output += chunk; });
    worker.stderr.resume();
    worker.stdin.on('error', error => { clearTimeout(timer); worker.kill('SIGKILL'); reject(error); });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error('Search worker stopped.')); return; }
      try { resolve(JSON.parse(output)); } catch { reject(new Error('Invalid search worker output.')); }
    });
    worker.stdin.end(JSON.stringify({lines, regex: args.regex !== undefined, source, flags, limit}));
  });
}
