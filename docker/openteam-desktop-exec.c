#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <unistd.h>

static void die(const char *message) { perror(message); exit(126); }
static unsigned int identity(const char *value) {
  char *end; errno = 0;
  unsigned long n = strtoul(value, &end, 10);
  if (errno || *end || !n || n > 2147483647UL) { fputs("Invalid runner identity\n", stderr); exit(126); }
  return (unsigned int)n;
}
int main(int argc, char **argv) {
  if (argc < 5 || geteuid() != 0) { fputs("usage: desktop-exec cgroup uid gid command [args...] (supervisor only)\n", stderr); return 126; }
  unsigned int uid = identity(argv[2]), gid = identity(argv[3]);
  int group = open(argv[1], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (group < 0) die("desktop cgroup");
  int fd = openat(group, "cgroup.procs", O_WRONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0 || write(fd, "0\n", 2) != 2) die("join desktop cgroup");
  close(fd); close(group);
  // Enter before exec/fork: every descendant (including daemonized apps) inherits
  // the limit. No PID polling race and no setuid executable or agent write access.
  if (setgroups(0, NULL) || setgid(gid) || setuid(uid)) die("runner identity");
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) die("no_new_privs");
  unsetenv("OPENTEAM_DESKTOP_ID");
  execvp(argv[4], argv + 4);
  die("desktop command");
}
