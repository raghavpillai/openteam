import { expect, test } from 'bun:test';
import { calendarTools } from '../server';
import { harness } from '../../../test/parity-harness';

test('Calendar changes attendees and attachments without losing others or racing a concurrent edit', async () => {
  const original={id:'e',etag:'v1',summary:'Original',start:{dateTime:'2026-09-14T09:00:00Z'},end:{dateTime:'2026-09-14T10:00:00Z'},attendees:[{email:'keep@example.com',responseStatus:'accepted'},{email:'remove@example.com'}],attachments:[{fileUrl:'keep'},{fileUrl:'remove'}]};
  const h=harness(calendarTools,[original,{}]);
  await h.call('update_event',{eventId:'e',addedAttendees:[{email:'add@example.com',optionalAttendee:true}],removedAttendeeEmails:['remove@example.com'],addedAttachments:[{fileUrl:'add'}],removedAttachmentFileUrls:['remove'],notificationLevel:'NONE'});
  expect(h.requests[1]!.init.headers).toMatchObject({'If-Match':'v1'});
  expect(h.requests[1]!.json.attendees).toEqual([{email:'keep@example.com',responseStatus:'accepted'},{email:'add@example.com',optional:true}]);
  expect(h.requests[1]!.json.attachments).toEqual([{fileUrl:'keep'},{fileUrl:'add'}]);
  expect(h.requests[1]!.json.summary).toBeUndefined();
  expect(h.requests[1]!.url.searchParams.get('sendUpdates')).toBe('none');
});

test('Calendar reference suggest_time returns structured times and fails closed on missing availability', async () => {
  const h=harness(calendarTools,[{calendars:{'a@example.com':{busy:[]},'b@example.com':{busy:[]}}},{calendars:{'a@example.com':{busy:[]}}}]);
  const args={attendeeEmails:['a@example.com','b@example.com'],startTime:'2026-09-14T00:00:00Z',endTime:'2026-09-15T00:00:00Z',timeZone:'America/New_York',preferences:{startHour:'09:00',endHour:'10:00',excludeWeekends:true,pageSize:2}};
  const result=await h.call('suggest_time',args);
  expect(result.timeSlots[0].start).toEqual({dateTime:'2026-09-14T13:00:00.000Z',timeZone:'America/New_York'});
  expect(h.requests[0]!.json.items).toEqual([{id:'a@example.com'},{id:'b@example.com'}]);
  await expect(h.call('suggest_time',args)).rejects.toThrow('No availability was inferred');
});
