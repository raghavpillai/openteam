#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/capability.h>
#include <linux/magic.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/sysinfo.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <unistd.h>

static void die(const char *message) { perror(message); exit(1); }
static void write_limit(const char *path, unsigned long long value) {
  FILE *f = fopen(path, "w");
  if (!f) die(path);
  if (fprintf(f, "%llu\n", value) < 0 || fclose(f)) die(path);
}

static int contains_init(const char *path) {
  FILE *f = fopen(path, "r");
  if (!f) return 0;
  long pid; int found = 0;
  while (fscanf(f, "%ld", &pid) == 1) if (pid == 1) found = 1;
  fclose(f); return found;
}

static unsigned long long init_starttime(void) {
  FILE *f = fopen("/proc/1/stat", "r");
  char line[4096];
  if (!f || !fgets(line, sizeof line, f)) die("computer start time");
  fclose(f);
  // comm (field 2) may contain spaces or parentheses. Start after its final ')'.
  char *field = strrchr(line, ')');
  if (field && field[1] == ' ') {
    field += 2;
    for (int number = 3; number < 22 && field; number++) {
      field = strchr(field, ' ');
      if (field) field++;
    }
    if (field) {
      char *end;
      unsigned long long value = strtoull(field, &end, 10);
      if (value && end != field && (*end == ' ' || *end == '\n')) return value;
    }
  }
  fputs("Invalid computer start time\n", stderr); exit(1);
}

int main(void) {
  // This helper shares ONLY the computer's PID namespace. No host PID namespace,
  // Docker socket, host mounts, credentials, network or persistent privilege.
  if (getpid() == 1) { fputs("Expected the computer PID namespace\n", stderr); return 1; }
  int fd = open("/proc/1/ns/mnt", O_RDONLY | O_CLOEXEC);
  struct stat namespace;
  if (fd < 0 || fstat(fd, &namespace) || setns(fd, CLONE_NEWNS)) die("computer mount namespace");
  close(fd);
  unsigned long long starttime = init_starttime();
  struct statfs fs;
  if (statfs("/sys/fs/cgroup", &fs) || fs.f_type != CGROUP2_SUPER_MAGIC ||
      (!contains_init("/sys/fs/cgroup/cgroup.procs") && !contains_init("/sys/fs/cgroup/supervisor/cgroup.procs"))) {
    fputs("Refusing cgroup mount that is not rooted at this computer\n", stderr); return 1;
  }
  if (mount(NULL, "/sys/fs/cgroup", NULL, MS_REMOUNT | MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL)) die("writable private cgroup mount");
  // Bound the whole computer, including shared Bun and every desktop. Docker's
  // configured limit remains an upper bound; smaller hosts reserve at least 25%.
  struct sysinfo info;
  if (sysinfo(&info)) die("sysinfo");
  unsigned long long budget = ((unsigned long long)info.totalram * info.mem_unit / 4 * 3) / (1024 * 1024) * (1024 * 1024);
  FILE *f = fopen("/sys/fs/cgroup/memory.max", "r");
  char limit[64];
  if (!f || !fgets(limit, sizeof limit, f)) die("memory.max");
  fclose(f);
  if (strncmp(limit, "max", 3) == 0) { fputs("A finite Docker memory limit is required\n", stderr); return 1; }
  unsigned long long configured = strtoull(limit, NULL, 10);
  if (!configured || budget < 64 * 1024 * 1024) { fputs("Invalid memory budget\n", stderr); return 1; }
  if (configured < budget) budget = configured;
  write_limit("/sys/fs/cgroup/memory.max", budget);
  write_limit("/sys/fs/cgroup/memory.swap.max", 0);
  fprintf(stdout, "Computer memory ceiling: %llu bytes; swap disabled\n", budget);
  fflush(stdout);
  // Drop all effective/permitted/inheritable capabilities before waiting.
  // no_new_privs prevents recovering bounding-set capabilities by exec as root.
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) die("no_new_privs");
  struct __user_cap_header_struct header = { _LINUX_CAPABILITY_VERSION_3, 0 };
  struct __user_cap_data_struct data[2] = {{0}, {0}};
  if (syscall(SYS_capset, &header, data)) die("drop capabilities");
  // Publish readiness only after both limits and privilege dropping succeed.
  // /tmp survives a normal Docker restart. Bind the marker to the mount
  // namespace we entered and PID 1's start time. Namespace inodes can be reused
  // immediately after shutdown; neither identity alone proves a fresh boot.
  char ready[] = "/tmp/openteam-memory-ready-XXXXXX";
  int ready_fd = mkstemp(ready);
  if (ready_fd < 0) die("memory readiness");
  if (dprintf(ready_fd, "%llu %llu %llu\n", budget, (unsigned long long)namespace.st_ino, starttime) < 0 || close(ready_fd) || rename(ready, "/tmp/openteam-memory-ready")) die("memory readiness");
  // The kernel kills namespace members when the computer's PID 1 exits.
  // Compose restarts this helper into the restarted computer's new namespace.
  for (;;) pause();
}
