/** Translate the published MCP query grammar to Drive v3 without rewriting quoted text. */
export function driveQuery(query: string) {
  if (!/\b(?:contains|and|or|not|in)\b|[=!<>]/i.test(query)) return `fullText contains '${query.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
  const tokens = query.match(/'(?:\\.|[^'\\])*'|!=|<=|>=|[()=<>]|\b[a-zA-Z_][\w.]*\b|\S/g) ?? [];
  const result: string[] = [];
  for (let i=0; i<tokens.length; i++) {
    const token = tokens[i]!;
    if (token === 'title') { result.push('name'); continue; }
    if (token === 'parentId' || token === 'owner') {
      const op=tokens[++i], value=tokens[++i];
      if (!['=', '!='].includes(op ?? '') || !value?.startsWith("'")) throw new Error(`${token} expects = or != and a quoted value`);
      result.push(...(op === '!=' ? ['not'] : []), `(${value} in ${token === 'owner' ? 'owners' : 'parents'})`);continue;
    }
    if (token === 'sharedWithMe' && ['=', '!='].includes(tokens[i+1] ?? '')) {
      const op=tokens[++i], value=tokens[++i];
      if (!['true','false'].includes(value ?? '')) throw new Error('sharedWithMe expects true or false');
      result.push(...((op === '=') === (value === 'true') ? [] : ['not']), 'sharedWithMe');continue;
    }
    result.push(token);
  }
  return result.join(' ');
}
