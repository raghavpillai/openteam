import { Effect, Either } from "effect";
import type { AppService } from "../app-service";
import type { parseAuthMode } from "../auth-mode";

export const run = async <A>(effect: Effect.Effect<A, Error>): Promise<A> => {
  const result = await Effect.runPromise(Effect.either(effect));
  if (Either.isLeft(result)) throw result.left;
  return result.right;
};

export interface RouteContext {
  app: AppService;
  request: Request;
  url: URL;
  path: string;
  authMode: ReturnType<typeof parseAuthMode>;
  authenticatedSessionId: string | null;
}
