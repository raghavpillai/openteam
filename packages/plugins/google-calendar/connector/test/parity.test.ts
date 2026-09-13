import { expect, test } from 'bun:test';
import { calendarTools } from '../server';
import { availableSlots, instant } from '../time';
import { harness } from '../../../test/parity-harness';

test('Calendar maps rich event inputs, meeting creation, attachments and reference notifications', async () => {
  const h=harness(calendarTools,[{id:'me@example.com'},(r:any)=>Response.json({id:'event',...r.json,conferenceData:{entryPoints:[{entryPointType:'video',uri:'https://meet.google.com/abc-defg-hij'}]}})]);
  const result=await h.call('create_event',{summary:'Planning',startTime:'2026-11-02T09:00:00',endTime:'2026-11-02T10:00:00',timeZone:'America/New_York',addGoogleMeetUrl:true,
    attendees:[{email:'test@example.com',optionalAttendee:true,additionalGuests:1}],attachments:[{fileUrl:'https://drive.google.com/file/d/file/view',title:'Agenda'}],
    overrideReminders:[{method:'popup',minutes:15}],guestPermissions:{guestsCanInviteOthers:false,guestsCanModify:true,guestsCanSeeGuests:false},visibility:'private',availability:'AVAILABILITY_FREE',recurrenceData:['RRULE:FREQ=WEEKLY;COUNT=2']});
  const request=h.requests[1]!;
  expect(request.url.searchParams.get('sendUpdates')).toBe('all');
  expect(request.url.searchParams.get('supportsAttachments')).toBe('true');
  expect(request.url.searchParams.get('conferenceDataVersion')).toBe('1');
  expect(request.json).toMatchObject({start:{dateTime:'2026-11-02T09:00:00-05:00',timeZone:'America/New_York'},attendees:[{email:'test@example.com',optional:true,additionalGuests:1},{email:'me@example.com',responseStatus:'accepted'}],transparency:'transparent',reminders:{useDefault:false,overrides:[{method:'popup',minutes:15}]},guestsCanInviteOthers:false,guestsCanModify:true,guestsCanSeeOtherGuests:false,visibility:'private'});
  expect(request.json.conferenceData.createRequest.requestId).toBeTruthy();
  expect(result.conferenceUrl).toBe('https://meet.google.com/abc-defg-hij');
  expect(result.availability).toBe('AVAILABILITY_FREE');
});

test('Calendar start-only rescheduling preserves duration across time zones', async () => {
  const h=harness(calendarTools,[{id:'e',etag:'v',start:{dateTime:'2026-09-14T09:00:00-04:00'},end:{dateTime:'2026-09-14T10:30:00-04:00'}},{}]);
  await h.call('update_event',{eventId:'e',startTime:'2026-11-02T11:00:00',timeZone:'America/New_York',notificationLevel:'NONE'});
  expect(h.requests[1]!.json).toMatchObject({start:{dateTime:'2026-11-02T11:00:00-05:00'},end:{dateTime:'2026-11-02T12:30:00-05:00'}});
});

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

test('Calendar uses real calendar timezone defaults, all-day dates and working-location fields', async () => {
  const h=harness(calendarTools,[{timeZone:'Asia/Kolkata'},{}]);
  await h.call('create_event',{summary:'Remote',startTime:'2026-09-14T00:00:00',endTime:'2026-09-15T00:00:00',allDay:true,eventType:'WORKING_LOCATION',workingLocationProperties:{type:'CUSTOM_LOCATION',customLocationLabel:'Client office'},notificationLevel:'NONE'});
  expect(h.requests[1]!.json).toMatchObject({start:{date:'2026-09-14'},end:{date:'2026-09-15'},eventType:'workingLocation',workingLocationProperties:{type:'customLocation',customLocation:{label:'Client office'}}});
  expect(() => instant('2026-11-01T01:30:00','America/New_York')).toThrow('ambiguous');
  expect(() => instant('2026-03-08T02:30:00','America/New_York')).toThrow('ambiguous');
});

test('Calendar availability honors weekends and working hours across daylight saving changes', () => {
  const result=availableSlots(Date.parse('2026-03-07T00:00:00Z'),Date.parse('2026-03-10T00:00:00Z'),[{start:Date.parse('2026-03-09T13:00:00Z'),end:Date.parse('2026-03-09T13:30:00Z')}],30,'America/New_York',{startHour:'09:00',endHour:'10:00',excludeWeekends:true,pageSize:4});
  expect(result).toEqual([{start:'2026-03-09T13:30:00.000Z',end:'2026-03-09T14:00:00.000Z'}]);
});

test('Calendar reference suggest_time returns structured times and fails closed on missing availability', async () => {
  const h=harness(calendarTools,[{calendars:{'a@example.com':{busy:[]},'b@example.com':{busy:[]}}},{calendars:{'a@example.com':{busy:[]}}}]);
  const args={attendeeEmails:['a@example.com','b@example.com'],startTime:'2026-09-14T00:00:00Z',endTime:'2026-09-15T00:00:00Z',timeZone:'America/New_York',preferences:{startHour:'09:00',endHour:'10:00',excludeWeekends:true,pageSize:2}};
  const result=await h.call('suggest_time',args);
  expect(result.timeSlots[0].start).toEqual({dateTime:'2026-09-14T13:00:00.000Z',timeZone:'America/New_York'});
  expect(h.requests[0]!.json.items).toEqual([{id:'a@example.com'},{id:'b@example.com'}]);
  await expect(h.call('suggest_time',args)).rejects.toThrow('No availability was inferred');
});

test('Calendar RSVP includes comments, preserves other responses and honors explicit notifications', async () => {
  const h=harness(calendarTools,[{etag:'v',attendees:[{self:true,email:'me@example.com'},{email:'other@example.com',responseStatus:'accepted'}]},{}]);
  await h.call('respond_to_event',{eventId:'e',responseStatus:'tentative',responseComment:'May join late',notificationLevel:'NONE'});
  expect(h.requests[1]!.json.attendees[0]).toMatchObject({responseStatus:'tentative',comment:'May join late'});
  expect(h.requests[1]!.json.attendees[1].responseStatus).toBe('accepted');
});

test('Calendar semantic search finds related concepts and removes cancelled events on sync', async () => {
  const h=harness(calendarTools,[{items:[{id:'recruiting',summary:'Recruiting discussion with hiring manager',etag:'1'},{id:'lunch',summary:'Lunch at Italian restaurant',etag:'2'}],nextPageToken:'second'}, {items:[{id:'screen',summary:'Candidate screening call',etag:'3'}],nextSyncToken:'sync1'}, {items:[{id:'recruiting',status:'cancelled'}],nextSyncToken:'sync2'}]);
  const first=await h.call('search_events',{query:'interviewing job candidates'});
  expect(first.searchMode).toBe('localSemantic');
  expect(first.events.map((e:any)=>e.id)).toEqual(['recruiting','screen']);
  expect(first.indexedEvents).toBe(3);
  const second=await h.call('search_events',{query:'interviewing job candidates'});
  expect(h.requests[2]!.url.searchParams.get('syncToken')).toBe('sync1');
  expect(second.events.map((e:any)=>e.id)).toEqual(['screen']);
});

test('Calendar concurrent searches share a complete sync and expired cursors rebuild automatically', async () => {
  const h=harness(calendarTools,[{items:[{id:'hiring',summary:'Candidate screening',etag:'1'}],nextPageToken:'more'},{items:[],nextSyncToken:'expired'},new Response('Gone',{status:410}),{items:[{id:'new',summary:'Interviewing candidates',etag:'2'}],nextSyncToken:'fresh'}]);
  const [first,parallel]=await Promise.all([h.call('search_events',{query:'candidate screening'}),h.call('search_events',{query:'candidate screening'})]);
  expect(first.events.map((e:any)=>e.id)).toEqual(['hiring']);
  expect(parallel.events.map((e:any)=>e.id)).toEqual(['hiring']);
  expect(h.requests.length).toBe(2);
  const rebuilt=await h.call('search_events',{query:'candidate screening'});
  expect(rebuilt.events.map((e:any)=>e.id)).toEqual(['new']);
  expect(h.requests[3]!.url.searchParams.has('syncToken')).toBe(false);
});

test('Calendar list translates type filters and returns complete descending pages', async () => {
  const h=harness(calendarTools,[{items:[{id:'a',start:{dateTime:'2026-09-01T10:00:00Z'}}],nextPageToken:'next'},{items:[{id:'b',start:{dateTime:'2026-09-02T10:00:00Z'}}]}]);
  const result=await h.call('list_events',{orderBy:'startTimeDesc',endTime:'2026-10-01T00:00:00Z',eventType:['BIRTHDAY'],pageSize:1});
  expect(h.requests[0]!.url.searchParams.get('eventTypes')).toBe('birthday');
  expect(result.events[0].id).toBe('b');
  expect(result.nextPageToken).toBeTruthy();
});
