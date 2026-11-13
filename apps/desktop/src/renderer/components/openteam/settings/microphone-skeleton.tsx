import { SkeletonControl, SkeletonStatus } from "./ui";

/** "● Allowed  [System settings]" while the permission check runs. */
export function MicrophoneAccessSkeleton() {
  return (
    <div aria-hidden="true" className="flex items-center gap-3">
      <SkeletonStatus width={46} />
      <SkeletonControl width={104} />
    </div>
  );
}
