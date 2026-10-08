import { isAllowedEnvironmentName } from "@openteam/plugin-sdk/environment";

export function validateProcessSecretName(name: unknown): string {
  if (!isAllowedEnvironmentName(name))
    throw new Error(
      "Use a credential environment name such as CRM_API_TOKEN; process and runtime settings cannot be replaced"
    );
  return name;
}
