#define _GNU_SOURCE
#include <errno.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>

/* Loaded ONLY in the supervisor's relay worker. Mark before connect/DNS so
 * those transport sockets use the underlay, regardless of UID. Applications,
 * including sudo descendants and diagnostics, never inherit this library.
 * This is routing policy, not an isolation boundary against administrators. */
int socket(int domain, int type, int protocol) {
  int fd = (int)syscall(SYS_socket, domain, type, protocol);
  if (fd >= 0 && (domain == AF_INET || domain == AF_INET6)) {
    unsigned int mark = 0x4f54;
    if (setsockopt(fd, SOL_SOCKET, SO_MARK, &mark, sizeof(mark)) < 0) {
      int error = errno;
      close(fd);
      errno = error;
      return -1;
    }
  }
  return fd;
}
