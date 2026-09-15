const RESERVED =
  /^(?:OPENTEAM_|CODEX_|LD_|DYLD_|NODE_|BUN_|ELECTRON_|PYTHON|BASH_|ENV$|BASH_ENV$|PATH$|HOME$|SHELL$|USER$|LOGNAME$|PWD$|OLDPWD$|TMPDIR$)/i;
export function validateProcessSecretName(name: unknown): string {
  if (
    typeof name !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) ||
    RESERVED.test(name)
  )
    throw new Error(
      "Use a credential environment name such as CRM_API_TOKEN; process and runtime settings cannot be replaced"
    );
  return name;
}
