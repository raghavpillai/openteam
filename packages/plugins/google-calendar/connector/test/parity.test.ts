import { expect, test } from 'bun:test';
import { createToolValidator } from '@openteam/plugin-sdk/json-schema';
import { referenceTools } from '../../../_shared/reference';
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

test('Calendar reference snapshot exposes the current definitions with valid input schemas', () => {
  const tools=calendarTools(), schema=(name:string)=>tools.find(t=>t.name===name)!.inputSchema;
  expect(referenceTools.calendar.map(t=>t.name).sort()).toEqual(['create_event','delete_event','get_event','list_calendars','list_events','respond_to_event','search_events','suggest_time','update_event']);
  expect(schema('create_event').$defs.WorkingLocationProperties.properties.type.enum).toContain('OFFICE_LOCATION');
  expect(schema('update_event').properties.useDefaultReminders.type).toBe('boolean');
  expect(schema('list_events').properties.startTime.description).toContain('Default: now');
  expect(tools.find(t=>t.name==='list_calendars')!.description).toContain('subset of all accessible calendars');
  const create=createToolValidator(schema('create_event'));
  expect(create({summary:'Office',startTime:'2026-11-02T09:00:00',endTime:'2026-11-02T17:00:00',eventType:'WORKING_LOCATION',useDefaultReminders:false,workingLocationProperties:{type:'OFFICE_LOCATION',officeLocation:{buildingId:'ZRH-1',label:'Zurich HQ'}}}).valid).toBe(true);
  expect(create({summary:'Office',startTime:'2026-11-02T09:00:00',endTime:'2026-11-02T17:00:00',workingLocationProperties:{type:'DESK'}}).valid).toBe(false);
});
