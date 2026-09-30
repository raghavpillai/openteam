import {expect, test} from 'bun:test';
import {isRetryableAssistantError, retryAssistantCall} from '@earendil-works/pi-ai/compat';
import type {AssistantMessage} from '@earendil-works/pi-ai';
const capacity = 'The model is currently at capacity due to high demand. Please try again in a few minutes, or use a higher service tier for priority processing.';
const failure = (errorMessage: string) => ({stopReason: 'error', errorMessage}) as AssistantMessage;
const policy = {enabled: true, maxRetries: 3, baseDelayMs: 1};
test('capacity errors enter the existing bounded retry loop and can recover', async () => {
 expect(isRetryableAssistantError(failure(capacity))).toBe(true);
 let calls=0;
 const success={stopReason:'stop'} as AssistantMessage;
 expect(await retryAssistantCall(async()=>++calls<3?failure(capacity):success, policy, undefined)).toBe(success);
 expect(calls).toBe(3);
});
test('persistent capacity errors exhaust retries without unlimited continuation', async () => {
 let calls=0;
 const result=await retryAssistantCall(async()=>{calls++;return failure(capacity)},policy,undefined);
 expect(result.stopReason).toBe('error');
 expect(calls).toBe(4);
});
test('billing, quota, authentication, approval decisions and cancellation remain terminal', async () => {
 for(const message of ['insufficient_quota: at capacity', 'billing limit: at capacity', 'Invalid API key', 'Unauthorized', 'Auto Review blocked this action']) {
  let calls=0; const result=await retryAssistantCall(async()=>{calls++;return failure(message)},policy,undefined);
  expect(result.errorMessage).toBe(message);expect(calls).toBe(1);
 }
 const controller=new AbortController();let calls=0;
 const result=await retryAssistantCall(async()=>{calls++;return failure(capacity)},policy,controller.signal,{onRetryScheduled:()=>controller.abort()});
 expect(result.stopReason).toBe('aborted');expect(calls).toBe(1);
});
