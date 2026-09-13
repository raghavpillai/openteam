import { unzipSync, strFromU8 } from 'fflate';
import { read, utils } from 'xlsx';
import { convert } from 'html-to-text';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';

const maxExpanded = 128 * 1024 * 1024;
const decode = (text: string) => convert(text, { wordwrap: false });
const xmlText = (xml: string, prefix: 'w' | 'a' | 'text') => {
  const parts: string[] = [];
  const re = prefix === 'text' ? /<text:(?:p|h)\b[^>]*>([\s\S]*?)<\/text:(?:p|h)>/g : new RegExp(`<${prefix}:t\\b[^>]*>([\\s\\S]*?)<\\/${prefix}:t>|<${prefix}:tab\\b[^>]*\\/>|<\\/${prefix}:p>|<\\/${prefix}:tr>`, 'g');
  for (const match of xml.matchAll(re)) parts.push(match[1] !== undefined ? decode(match[1].replace(/<text:s(?:\s[^>]*)?\/>/g, ' ').replace(/<text:tab\s*\/>/g, '\t')) + (prefix === 'text' ? '\n' : '') : match[0].includes(':tab') ? '\t' : '\n');
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
};
function archive(bytes: Uint8Array): Record<string, Uint8Array> {
  let total = 0, count = 0;
  return unzipSync(bytes, { filter: file => {
    total += file.originalSize; count++;
    if (total > maxExpanded || count > 10_000 || file.originalSize > 32 * 1024 * 1024) throw new Error('Document archive exceeds extraction limits');
    return /\.(?:xml|rels)$/.test(file.name);
  } });
}
async function processText(command: string[], cwd: string, timeout = 25_000) {
  let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  try { child = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' } }); }
  catch { throw new Error(`Document extraction requires ${command[0]}, included in the current OpenTeam computer image. Update the computer from the app.`); }
  const timer = setTimeout(() => child.kill(), timeout);
  try {
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (status !== 0) throw new Error(`Document extraction failed: ${stderr.slice(0, 500) || command[0]}`);
    if (Buffer.byteLength(stdout) > maxExpanded) throw new Error('Extracted text exceeds 128 MB');
    return stdout;
  } finally { clearTimeout(timer); }
}
export async function extractContent(bytes: Uint8Array, mimeType: string): Promise<{ text: string; supported: boolean; method: string }> {
  if (mimeType.startsWith('text/') || /application\/(?:json|xml|csv|rtf)/.test(mimeType)) {
    const text = new TextDecoder().decode(bytes);
    return { text: /html/.test(mimeType) ? decode(text) : text, supported: true, method: 'text' };
  }
  if (/spreadsheet|excel|opendocument.spreadsheet/.test(mimeType)) {
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) archive(bytes); // preflight compressed input before the workbook parser
    const workbook = read(bytes, { type: 'array', cellDates: true });
    return { text: workbook.SheetNames.map(name => `# ${name}\n${utils.sheet_to_csv(workbook.Sheets[name]!)}\n`).join('\n'), supported: true, method: 'workbook' };
  }
  if (/wordprocessingml|presentationml|opendocument|x-vnd.oasis/.test(mimeType)) {
    const zip = archive(bytes);
    if (zip['word/document.xml']) {
      const names = Object.keys(zip).filter(n => /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(n));
      return { text: names.sort((a,b) => a === 'word/document.xml' ? -1 : b === 'word/document.xml' ? 1 : a.localeCompare(b)).map(n => xmlText(strFromU8(zip[n]!), 'w')).join('\n\n'), supported: true, method: 'docx' };
    }
    const relationships = (part: string) => {
      const name = `${posix.dirname(part)}/_rels/${posix.basename(part)}.rels`;
      const values = new Map<string, { target: string; type: string }>();
      for (const match of strFromU8(zip[name] ?? new Uint8Array()).matchAll(/<Relationship\b([^>]+)\/?\s*>/g)) {
        const attributes = Object.fromEntries([...match[1]!.matchAll(/([\w:]+)\s*=\s*["']([^"']*)["']/g)].map(a => [a[1], decode(a[2]!)]));
        if (attributes.TargetMode === 'External' || !attributes.Id || !attributes.Target) continue;
        const target = attributes.Target.startsWith('/') ? attributes.Target.slice(1) : posix.join(posix.dirname(part), attributes.Target);
        values.set(attributes.Id, { target: posix.normalize(target), type: attributes.Type ?? '' });
      }
      return values;
    };
    let slides = Object.keys(zip).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a,b) => Number(a.match(/slide(\d+)\.xml/)![1]) - Number(b.match(/slide(\d+)\.xml/)![1]));
    if (zip['ppt/presentation.xml']) {
      const rels = relationships('ppt/presentation.xml');
      const ordered = [...strFromU8(zip['ppt/presentation.xml']).matchAll(/<p:sldId\b[^>]*\br:id=["']([^"']+)["']/g)].map(m => rels.get(m[1]!)?.target);
      if (ordered.length && ordered.every((n): n is string => Boolean(n?.startsWith('ppt/slides/') && zip[n]))) slides = ordered;
    }
    if (slides.length) return { text: slides.map((n, position) => {
      const index = n.match(/slide(\d+)\.xml/)![1];
      const rels = relationships(n);
      const notesTarget = [...rels.values()].find(r => r.type.endsWith('/notesSlide'))?.target;
      const notes = notesTarget?.startsWith('ppt/notesSlides/') ? zip[notesTarget] : !rels.size ? zip[`ppt/notesSlides/notesSlide${index}.xml`] : undefined;
      return `# Slide ${position + 1}\n${xmlText(strFromU8(zip[n]!), 'a')}${notes ? `\nNotes:\n${xmlText(strFromU8(notes), 'a')}` : ''}`;
    }).join('\n\n'), supported: true, method: 'pptx' };
    if (zip['content.xml']) return { text: xmlText(strFromU8(zip['content.xml']), 'text'), supported: true, method: 'opendocument' };
    throw new Error('The document archive does not contain recognized content');
  }
  if (mimeType === 'application/pdf' || mimeType === 'application/msword' || /^image\/(png|jpe?g)$/.test(mimeType)) {
    const directory = await mkdtemp(join(tmpdir(), 'openteam-drive-extract-'));
    try {
      const deadline = Date.now() + 45_000;
      const run = (command: string[]) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('Document extraction timed out; use a smaller document.');
        return processText(command, directory, Math.min(25_000, remaining));
      };
      const input = join(directory, mimeType === 'application/pdf' ? 'input.pdf' : mimeType === 'application/msword' ? 'input.doc' : 'input.image');
      await writeFile(input, bytes, { mode: 0o600 });
      if (mimeType === 'application/msword') return { text: await run(['antiword', input]), supported: true, method: 'doc' };
      if (mimeType.startsWith('image/')) return { text: await run(['tesseract', input, 'stdout', '-l', 'eng']), supported: true, method: 'ocr' };
      const text = await run(['pdftotext', '-layout', input, '-']);
      if (text.trim()) return { text, supported: true, method: 'pdf' };
      const info = await run(['pdfinfo', input]);
      const total = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
      if (!Number.isSafeInteger(total) || total < 1 || total > 25) throw new Error('Scanned PDFs require a known page count of at most 25; use a smaller document or a text-searchable PDF. No partial extraction was returned.');
      await run(['pdftoppm', '-png', '-scale-to', '1600', '-f', '1', '-l', String(total), input, join(directory, 'page')]);
      const images = (await readdir(directory)).filter(n => /^page-\d+\.png$/.test(n)).sort((a,b) => a.localeCompare(b, undefined, { numeric: true }));
      const pages: string[] = [];
      if (images.length !== total) throw new Error('PDF rendering did not return every page');
      for (const file of images) pages.push(await run(['tesseract', join(directory, file), 'stdout', '-l', 'eng']));
      return { text: pages.join('\n\n'), supported: true, method: 'pdf-ocr' };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  return { text: '', supported: false, method: 'unsupported' };
}
