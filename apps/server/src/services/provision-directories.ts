import { ApiError } from "@openteam/contracts";
import type { ComputerFetch } from "./service-utils";

export async function provisionDirectories(computerFetch: ComputerFetch, paths: string[]) {
  const response = await computerFetch("/v1/directories", {
    method: "PUT",
    body: JSON.stringify({ paths }),
  });
  if (!response.ok) throw new ApiError(503, "computer_unavailable", await response.text());
}
