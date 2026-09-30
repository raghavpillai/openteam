import { expect, test } from 'bun:test';
import { SearchProviderClient } from '../src/search-provider';
const configuration = () => ({provider: 'exa' as const, apiKey: 'synthetic-key'});
const success = () => Response.json({results: [{title: 'Reference', url: 'https://example.com', highlights: ['Recovered result']}]});

test('recovers an Exa capacity rejection without changing the request', async () => {
  const requests: {url: string; body: unknown}[] = [];
  const client = new SearchProviderClient(configuration, async (url, init) => {
    requests.push({url, body: init.body});
    return requests.length === 1 ? Response.json({error: 'capacity'}, {status: 503}) : success();
  });
  const result = await client.search('generic reference');
  expect(result.details.results[0]?.title).toBe('Reference');
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
});

test('persistent Exa capacity failure stops after three attempts and redacts errors', async () => {
  let count = 0;
  const client = new SearchProviderClient(configuration, async () => {
    count++;
    return Response.json({error: 'capacity synthetic-key'}, {status: 503});
  });
  await expect(client.search('reference')).rejects.toThrow('capacity [redacted]');
  expect(count).toBe(3);
}, 10000);

test('does not retry credential, billing, quota or validation failures', async () => {
  for (const status of [400, 401, 402, 403, 429]) {
    let count = 0;
    const client = new SearchProviderClient(configuration, async () => {count++; return Response.json({error: 'rejected'}, {status});});
    await expect(client.search('reference')).rejects.toThrow(`HTTP ${status}`);
    expect(count).toBe(1);
  }
});

test('aborting backoff prevents another request', async () => {
  const controller = new AbortController(); let count = 0;
  const client = new SearchProviderClient(configuration, async () => {
    count++; setTimeout(() => controller.abort(new Error('cancelled by caller')), 20);
    return Response.json({error: 'capacity'}, {status: 503});
  });
  await expect(client.search('reference', controller.signal)).rejects.toThrow('cancelled by caller');
  expect(count).toBe(1);
});

test('does not retry earlier than a Retry-After outside the total request budget', async () => {
  let count = 0;
  const client = new SearchProviderClient(configuration, async () => {
    count++; return Response.json({error: 'capacity'}, {status: 503, headers: {'retry-after': '60'}});
  });
  await expect(client.search('reference')).rejects.toThrow('HTTP 503');
  expect(count).toBe(1);
});

test('does not impose Exa retry semantics on another provider', async () => {
  let count = 0;
  const client = new SearchProviderClient(() => ({provider: 'brave', apiKey: 'synthetic-key'}), async () => {
    count++; return Response.json({error: 'unavailable'}, {status: 503});
  });
  await expect(client.search('reference')).rejects.toThrow('HTTP 503');
  expect(count).toBe(1);
});

test('honors a future HTTP-date Retry-After beyond the request budget', async () => {
  let count = 0;
  const client = new SearchProviderClient(configuration, async () => {
    count++; return Response.json({error: 'capacity'}, {status: 503, headers: {'retry-after': new Date(Date.now() + 60000).toUTCString()}});
  });
  await expect(client.search('reference')).rejects.toThrow('HTTP 503');
  expect(count).toBe(1);
});
