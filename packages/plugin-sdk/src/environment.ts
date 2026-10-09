const RESERVED =
  /^(?:OPENTEAM_|CODEX_|LD_|DYLD_|NODE_|BUN_|ELECTRON_|PYTHON|BASH_|ENV$|BASH_ENV$|PATH$|HOME$|SHELL$|USER$|LOGNAME$|PWD$|OLDPWD$|TMPDIR$)/i;

/** A name a secret may take in Bot computer processes; process and runtime settings stay reserved. */
export const isAllowedEnvironmentName = (name: unknown): name is string =>
  typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) && !RESERVED.test(name);
