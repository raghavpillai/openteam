// Opt-in simulator-only profiling library. Never linked into the shipping app.
// Inject into an isolated release app with SIMCTL_CHILD_DYLD_INSERT_LIBRARIES.
#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <QuartzCore/QuartzCore.h>
#import <mach/mach.h>
#import <sys/resource.h>

static CFTimeInterval OpenTeamProbeLoadedAt;
static double OpenTeamFirstContentMs = -1;

@interface OpenTeamFrameProbe : NSObject {
  CADisplayLink *_displayLink;
  double _frames[36000];
  NSUInteger _count;
  CFTimeInterval _previous;
  CFTimeInterval _started;
  struct rusage _usage;
  NSString *_label;
  BOOL _running;
}
- (void)start;
- (void)tick:(CADisplayLink *)link;
- (void)finish;
@end

@implementation OpenTeamFrameProbe
- (void)start {
  if (_running) return;
  _running = YES;
  _label = NSProcessInfo.processInfo.environment[@"OPENTEAM_FRAME_PROBE_LABEL"] ?: @"capture";
  _started = CACurrentMediaTime();
  getrusage(RUSAGE_SELF, &_usage);
  _displayLink = [CADisplayLink displayLinkWithTarget:self selector:@selector(tick:)];
  [_displayLink addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
  double seconds = [NSProcessInfo.processInfo.environment[@"OPENTEAM_FRAME_PROBE_SECONDS"] doubleValue];
  seconds = seconds > 0 ? MIN(seconds, 180) : 60;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(seconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{ [self finish]; });
}
- (void)tick:(CADisplayLink *)link {
  if (UIApplication.sharedApplication.applicationState != UIApplicationStateActive) { _previous = 0; return; }
  if (_previous > 0 && _count < 36000) _frames[_count++] = (link.timestamp - _previous) * 1000;
  _previous = link.timestamp;
}
- (void)finish {
  [_displayLink invalidate];
  _displayLink = nil;
  struct rusage usage;
  getrusage(RUSAGE_SELF, &usage);
  task_vm_info_data_t memory;
  mach_msg_type_number_t size = TASK_VM_INFO_COUNT;
  kern_return_t result = task_info(mach_task_self(), TASK_VM_INFO, (task_info_t)&memory, &size);
  NSMutableArray *frames = [NSMutableArray arrayWithCapacity:_count];
  for (NSUInteger index = 0; index < _count; index++) [frames addObject:@(_frames[index])];
  double userSeconds = usage.ru_utime.tv_sec - _usage.ru_utime.tv_sec + (usage.ru_utime.tv_usec - _usage.ru_utime.tv_usec) / 1000000.0;
  double systemSeconds = usage.ru_stime.tv_sec - _usage.ru_stime.tv_sec + (usage.ru_stime.tv_usec - _usage.ru_stime.tv_usec) / 1000000.0;
  NSDictionary *capture = @{
    @"label": _label, @"pid": @(NSProcessInfo.processInfo.processIdentifier),
    @"measurementClass": @"release iOS Simulator CADisplayLink main-run-loop cadence; not physical-device FPS",
    @"durationSeconds": @(CACurrentMediaTime() - _started), @"frameDeltasMs": frames,
    @"cpuUserSeconds": @(userSeconds), @"cpuSystemSeconds": @(systemSeconds),
    @"firstReactContentAfterProbeLoadMs": OpenTeamFirstContentMs >= 0 ? @(OpenTeamFirstContentMs) : NSNull.null,
    @"physicalFootprintBytes": result == KERN_SUCCESS ? @(memory.phys_footprint) : @0,
    @"residentBytes": result == KERN_SUCCESS ? @(memory.resident_size) : @0,
    @"capturedAt": [[NSISO8601DateFormatter new] stringFromDate:NSDate.date]
  };
  NSData *data = [NSJSONSerialization dataWithJSONObject:capture options:0 error:nil];
  NSString *name = [NSString stringWithFormat:@"openteam-frame-probe-%@.json", _label];
  NSString *path = [[NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES) firstObject] stringByAppendingPathComponent:name];
  [data writeToFile:path atomically:YES];
  NSLog(@"OPENTEAM_FRAME_PROBE_SAVED %@", path);
}
@end

__attribute__((constructor)) static void OpenTeamInstallFrameProbe(void) {
  @autoreleasepool {
    if (!getenv("OPENTEAM_FRAME_PROBE_LABEL")) return;
    OpenTeamProbeLoadedAt = CACurrentMediaTime();
    static OpenTeamFrameProbe *probe;
    dispatch_async(dispatch_get_main_queue(), ^{
      [NSNotificationCenter.defaultCenter addObserverForName:@"RCTContentDidAppearNotification" object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
        if (OpenTeamFirstContentMs < 0) OpenTeamFirstContentMs = (CACurrentMediaTime() - OpenTeamProbeLoadedAt) * 1000;
      }];
      probe = [OpenTeamFrameProbe new];
      double delay = [NSProcessInfo.processInfo.environment[@"OPENTEAM_FRAME_PROBE_DELAY"] doubleValue];
      delay = delay > 0 ? delay : 5;
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{ [probe start]; });
    });
  }
}
