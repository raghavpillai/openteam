// Exercise the real Node-API bridge and request lifecycle without prompting for
// permission or reading the developer's location. Only the OS service is faked.
#import <CoreLocation/CoreLocation.h>
#import <Foundation/Foundation.h>

@interface OTTestLocationManager : NSObject
@property(nonatomic, weak) id<CLLocationManagerDelegate> delegate;
@property(nonatomic) CLLocationAccuracy desiredAccuracy;
@property(nonatomic) CLAuthorizationStatus authorizationStatus;
- (void)startUpdatingLocation;
- (void)stopUpdatingLocation;
@end

@implementation OTTestLocationManager
- (instancetype)init {
  if ((self = [super init])) {
    self.authorizationStatus = strcmp(getenv("OPENTEAM_LOCATION_TEST_MODE") ?: "", "denied") == 0
      ? kCLAuthorizationStatusDenied : kCLAuthorizationStatusNotDetermined;
  }
  return self;
}
- (void)stopUpdatingLocation { self.delegate = nil; }
- (void)startUpdatingLocation {
  NSString *mode = @(getenv("OPENTEAM_LOCATION_TEST_MODE") ?: "success");
  dispatch_async(dispatch_get_main_queue(), ^{
    if ([mode isEqualToString:@"timeout"]) return;
    if ([mode isEqualToString:@"deny-prompt"]) {
      self.authorizationStatus = kCLAuthorizationStatusDenied;
      [self.delegate locationManagerDidChangeAuthorization:(id)self];
      return;
    }
    if ([mode isEqualToString:@"unavailable"]) {
      [self.delegate locationManager:(id)self didFailWithError:[NSError errorWithDomain:kCLErrorDomain code:kCLErrorNetwork userInfo:nil]];
      return;
    }
    // A transient failure must not finish the request before a valid fix arrives.
    [self.delegate locationManager:(id)self didFailWithError:[NSError errorWithDomain:kCLErrorDomain code:kCLErrorLocationUnknown userInfo:nil]];
    CLLocation *location = [[CLLocation alloc] initWithCoordinate:CLLocationCoordinate2DMake(12.5, -45.5)
      altitude:0 horizontalAccuracy:25 verticalAccuracy:0
      timestamp:[NSDate dateWithTimeIntervalSinceNow:[mode isEqualToString:@"stale"] ? -600 : 0]];
    [self.delegate locationManager:(id)self didUpdateLocations:@[location]];
  });
}
@end

#define CLLocationManager OTTestLocationManager
#include "../../native/location.m"
