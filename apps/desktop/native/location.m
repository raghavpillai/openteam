#import <CoreLocation/CoreLocation.h>
#import <Foundation/Foundation.h>
#include <node_api.h>

// Node-API keeps this module independent of Electron's Node/V8 ABI. Run Core
// Location in the app process so macOS attributes permission to OpenTeam.
@class OTLocationRequest;
typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  dispatch_semaphore_t completed;
  double timeout;
  int code;
  double latitude, longitude, accuracy, timestamp;
  OTLocationRequest *request;
} LocationWork;

@interface OTLocationRequest : NSObject <CLLocationManagerDelegate>
@property(nonatomic, strong) CLLocationManager *manager;
@property(nonatomic, strong) NSTimer *timer;
@property(nonatomic, assign) LocationWork *work;
@property(nonatomic, assign) BOOL finished;
- (void)start;
- (void)finish:(int)code;
@end

@implementation OTLocationRequest
- (void)start {
  self.manager = [CLLocationManager new];
  self.manager.delegate = self;
  self.manager.desiredAccuracy = kCLLocationAccuracyHundredMeters;
  // The timer retains this request until success, denial, or timeout. Every
  // terminal path stops updates and breaks the retain cycle.
  self.timer = [NSTimer scheduledTimerWithTimeInterval:self.work->timeout
      repeats:NO block:^(NSTimer *timer) { [self finish:3]; }];
  CLAuthorizationStatus status = self.manager.authorizationStatus;
  if (status == kCLAuthorizationStatusDenied || status == kCLAuthorizationStatusRestricted) {
    [self finish:1];
    return;
  }
  if (status == kCLAuthorizationStatusNotDetermined) [self.manager requestWhenInUseAuthorization];
  [self.manager startUpdatingLocation];
}

- (void)finish:(int)code {
  if (self.finished) return;
  self.finished = YES;
  [self.manager stopUpdatingLocation];
  self.manager.delegate = nil;
  [self.timer invalidate];
  self.timer = nil;
  self.work->code = code;
  dispatch_semaphore_signal(self.work->completed);
}

- (void)locationManagerDidChangeAuthorization:(CLLocationManager *)manager {
  if (manager.authorizationStatus == kCLAuthorizationStatusDenied ||
      manager.authorizationStatus == kCLAuthorizationStatusRestricted) [self finish:1];
}

- (void)locationManager:(CLLocationManager *)manager didUpdateLocations:(NSArray<CLLocation *> *)locations {
  if (self.finished) return;
  CLLocation *location = locations.lastObject;
  if (!location || location.horizontalAccuracy < 0 ||
      !CLLocationCoordinate2DIsValid(location.coordinate) ||
      fabs(location.timestamp.timeIntervalSinceNow) > 300) return;
  self.work->latitude = location.coordinate.latitude;
  self.work->longitude = location.coordinate.longitude;
  self.work->accuracy = location.horizontalAccuracy;
  self.work->timestamp = location.timestamp.timeIntervalSince1970 * 1000;
  [self finish:0];
}

- (void)locationManager:(CLLocationManager *)manager didFailWithError:(NSError *)error {
  // LocationUnknown is transient (e.g. Wi-Fi is still being located); let the
  // service retry until the deadline instead of failing the toggle immediately.
  if ([error.domain isEqualToString:kCLErrorDomain] && error.code == kCLErrorLocationUnknown) return;
  [self finish:([error.domain isEqualToString:kCLErrorDomain] && error.code == kCLErrorDenied) ? 1 : 2];
}
@end

static void Execute(napi_env env, void *data) {
  LocationWork *work = data;
  @autoreleasepool {
    dispatch_async(dispatch_get_main_queue(), ^{
      OTLocationRequest *request = [OTLocationRequest new];
      work->request = request;
      request.work = work;
      [request start];
    });
    dispatch_semaphore_wait(work->completed, DISPATCH_TIME_FOREVER);
  }
}

static void Number(napi_env env, napi_value object, const char *name, double number) {
  napi_value value;
  napi_create_double(env, number, &value);
  napi_set_named_property(env, object, name, value);
}

static void Complete(napi_env env, napi_status status, void *data) {
  LocationWork *work = data;
  napi_value result;
  napi_create_object(env, &result);
  Number(env, result, "code", status == napi_ok ? work->code : 2);
  if (status == napi_ok && work->code == 0) {
    Number(env, result, "latitude", work->latitude);
    Number(env, result, "longitude", work->longitude);
    Number(env, result, "accuracy", work->accuracy);
    Number(env, result, "timestamp", work->timestamp);
  }
  napi_resolve_deferred(env, work->deferred, result);
  napi_delete_async_work(env, work->work);
  work->completed = nil;
  work->request = nil;
  free(work);
}

static napi_value ReadPosition(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argument;
  napi_get_cb_info(env, info, &argc, &argument, NULL, NULL);
  double timeout = 20000;
  if (argc) napi_get_value_double(env, argument, &timeout);
  if (!isfinite(timeout) || timeout < 1 || timeout > 60000) timeout = 20000;
  LocationWork *work = calloc(1, sizeof(LocationWork));
  work->timeout = timeout / 1000;
  work->completed = dispatch_semaphore_create(0);
  napi_value promise, name;
  napi_create_promise(env, &work->deferred, &promise);
  napi_create_string_utf8(env, "OpenTeamLocation", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(env, NULL, name, Execute, Complete, work, &work->work);
  napi_queue_async_work(env, work->work);
  return promise;
}

NAPI_MODULE_INIT() {
  napi_value read;
  napi_create_function(env, "readPosition", NAPI_AUTO_LENGTH, ReadPosition, NULL, &read);
  napi_set_named_property(env, exports, "readPosition", read);
  return exports;
}
