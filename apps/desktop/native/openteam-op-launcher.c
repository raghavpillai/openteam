// Private provisioning launcher. It never accepts vault item reads or a shell command.
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <sandbox.h>
#include <ctype.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

extern char **environ;
static int fail(const char *message) { fprintf(stderr, "openteam-op-launcher: %s\n", message); return 1; }
static int identifier(const char *value) {
  size_t n = strlen(value);
  if (!n || n > 256) return 0;
  for (size_t i = 0; i < n; i++) if (!isalnum((unsigned char)value[i]) && !strchr("_.-", value[i])) return 0;
  return 1;
}
static int label(const char *value) {
  size_t n = strlen(value);
  if (!n || n > 256 || value[0] == '-') return 0;
  for (size_t i = 0; i < n; i++) if ((unsigned char)value[i] < 32 || value[i] == 127) return 0;
  return 1;
}
static int allowed(int count, char **args) {
  if (count == 1) return strcmp(args[0], "--version") == 0;
  if (count == 3 && !strcmp(args[0], "account") && !strcmp(args[1], "list")) return !strcmp(args[2], "--format=json");
  if (count == 5 && !strcmp(args[0], "vault") && !strcmp(args[1], "list"))
    return !strcmp(args[2], "--account") && identifier(args[3]) && !strcmp(args[4], "--format=json");
  if (count == 6 && !strcmp(args[0], "vault") && !strcmp(args[1], "create"))
    return label(args[2]) && !strcmp(args[3], "--account") && identifier(args[4]) && !strcmp(args[5], "--format=json");
  if (count == 10 && !strcmp(args[0], "service-account") && !strcmp(args[1], "create") && label(args[2]) &&
      !strcmp(args[3], "--account") && identifier(args[4]) && !strcmp(args[5], "--vault") &&
      !strcmp(args[7], "--expires-in") && !strcmp(args[9], "--raw")) {
    const char *colon = strchr(args[6], ':');
    if (!colon || strcmp(colon, ":read_items") || colon - args[6] > 256) return 0;
    char vault[257]; memcpy(vault, args[6], colon - args[6]); vault[colon - args[6]] = 0;
    if (!identifier(vault) || !isdigit((unsigned char)args[8][0])) return 0;
    char *end = NULL; unsigned long seconds = strtoul(args[8], &end, 10);
    return end && !strcmp(end, "s") && seconds >= 60 && seconds <= 365UL * 86400;
  }
  return 0;
}
static int trusted(const char *path) {
  CFURLRef url = CFURLCreateFromFileSystemRepresentation(NULL, (const UInt8 *)path, strlen(path), false);
  SecStaticCodeRef code = NULL; SecRequirementRef requirement = NULL;
  OSStatus status = url ? SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code) : -1;
  if (status == errSecSuccess) status = SecRequirementCreateWithString(
    CFSTR("identifier \"com.1password.op\" and anchor apple generic and certificate leaf[subject.OU] = \"2BUA8C4S2C\""),
    kSecCSDefaultFlags, &requirement);
  if (status == errSecSuccess) status = SecStaticCodeCheckValidity(code, kSecCSStrictValidate, requirement);
  if (requirement) CFRelease(requirement); if (code) CFRelease(code); if (url) CFRelease(url);
  return status == errSecSuccess;
}
static int quote_path(const char *path, char *output, size_t capacity) {
  size_t n = 0;
  for (; *path; path++) {
    if ((unsigned char)*path < 32 || (unsigned char)*path == 127 || n + 3 >= capacity) return 0;
    if (*path == '\\' || *path == '"') output[n++] = '\\';
    output[n++] = *path;
  }
  output[n] = 0; return 1;
}
int main(int argc, char **argv) {
  if (argc < 4 || !allowed(argc - 3, argv + 3)) return fail("unsupported invocation");
  char data[PATH_MAX], cli[PATH_MAX];
  if (!realpath(argv[1], data) || !strcmp(data, "/") || !realpath(argv[2], cli) || !trusted(cli)) return fail("untrusted executable or data directory");
  // The provider may talk to 1Password, but cannot inspect OpenTeam's session/token store.
  char quoted_data[2 * PATH_MAX], quoted_cli[2 * PATH_MAX], profile[5 * PATH_MAX];
  if (!quote_path(data, quoted_data, sizeof(quoted_data)) || !quote_path(cli, quoted_cli, sizeof(quoted_cli))) return fail("invalid data path");
  snprintf(profile, sizeof(profile), "(version 1)(allow default)(deny file-read* file-write* (subpath \"%s\"))(allow file-read* (literal \"%s\"))", quoted_data, quoted_cli);
  char *error = NULL;
  if (sandbox_init(profile, 0, &error)) {
    if (error) sandbox_free_error(error);
    return fail("could not restrict app data access");
  }
  for (int i = 0; environ[i];) {
    if (!strncmp(environ[i], "OP_", 3) || !strncmp(environ[i], "DYLD_", 5)) {
      char *key = strdup(environ[i]); if (!key) return fail("environment unavailable");
      char *equals = strchr(key, '='); if (equals) *equals = 0;
      unsetenv(key); free(key);
    } else i++;
  }
  setenv("OP_CACHE", "false", 1); setenv("OP_BIOMETRIC_UNLOCK_ENABLED", "true", 1); setenv("OP_LOAD_DESKTOP_APP_SETTINGS", "false", 1);
  argv[2] = cli;
  execv(cli, argv + 2);
  return fail("could not start 1Password");
}
