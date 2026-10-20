#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

static void die(const char *message) { perror(message); exit(126); }
int main(int argc, char **argv) {
  if (argc < 3 || geteuid() != 0) { fputs("usage: desktop-exec cgroup command [args...] (supervisor only)\n", stderr); return 126; }
  int group = open(argv[1], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (group < 0) die("desktop cgroup");
  int fd = openat(group, "cgroup.procs", O_WRONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0 || write(fd, "0\n", 2) != 2) die("join desktop cgroup");
  close(fd); close(group);
  // Enter before setpriv/exec: every descendant, including sudo commands and
  // daemonized apps, inherits the budget. Administrators can explicitly change
  // cgroup controls; these limits are resource defaults, not a security boundary.
  unsetenv("OPENTEAM_DESKTOP_ID");
  execvp(argv[2], argv + 2);
  die("desktop command");
}
