import { ApiError, type ChannelMessageContextDirection } from "@openteam/contracts";

export interface MessageContextExtents {
  before: number;
  after: number;
}

const requestedExtent = (value: string | null): number => Number(value ?? 50);

/**
 * Preserve the original centered `before`/`after` contract while allowing an
 * edge message to be used as an explicit one-sided pagination anchor.
 * SnapshotService remains responsible for clamping each extent to its cap.
 */
export const messageContextExtents = (searchParams: URLSearchParams): MessageContextExtents => {
  const direction = searchParams.get("direction");
  if (direction === null) {
    return {
      before: requestedExtent(searchParams.get("before")),
      after: requestedExtent(searchParams.get("after")),
    };
  }
  if (direction !== "before" && direction !== "after") {
    throw new ApiError(
      400,
      "invalid_context_direction",
      "Context direction must be before or after"
    );
  }
  if (searchParams.has("before") || searchParams.has("after")) {
    throw new ApiError(
      400,
      "ambiguous_context_request",
      "Directional context requests use limit instead of before or after"
    );
  }

  const limit = requestedExtent(searchParams.get("limit"));
  return directionalMessageContextExtents(direction, limit);
};

const directionalMessageContextExtents = (
  direction: ChannelMessageContextDirection,
  limit: number
): MessageContextExtents =>
  direction === "before" ? { before: limit, after: 0 } : { before: 0, after: limit };
