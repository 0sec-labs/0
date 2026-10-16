/** Compiled locally during explicit runtime setup; no downloaded helper or shell. */
export const SMOLVM_DARWIN_SUPERVISOR_SOURCE = String.raw`
#include <sys/types.h>
#include <sys/event.h>
#include <sys/time.h>
#include <sys/sysctl.h>
#include <sys/wait.h>
#include <sys/proc.h>
#include <sys/file.h>
#include <sys/proc_info.h>
#include <libproc.h>
#include <signal.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <termios.h>

#define MAX_OWNED 4096
struct identity { pid_t pid; uint64_t sec, usec; int exited, notified; };
static struct identity owned[MAX_OWNED];
static int count, ambiguous, inspection_pending, queue_fd;
static volatile sig_atomic_t cancelled;
static const char *token, *family_token, *supervisor_name;
static char owner_root[PROC_PIDPATHINFO_MAXSIZE], native_binary[PROC_PIDPATHINFO_MAXSIZE];
static size_t owner_root_length;
static struct termios original_terminal;
static int terminal_saved;
static void interrupt(int sig) { (void)sig; cancelled = 1; }
static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec / 1e9; }
static int info(pid_t pid, struct proc_bsdinfo *p) {
  memset(p, 0, sizeof(*p));
  int n = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, p, sizeof(*p));
  if (n == sizeof(*p)) return 1;
  if (!n && (errno == ESRCH || errno == ENOENT)) return 0;
  /* A disappearance between the two system calls is not an inspection error. */
  if (kill(pid, 0) < 0 && errno == ESRCH) return 0;
  return -1;
}
static int same(struct identity *id) {
  if (id->exited) return 0;
  struct proc_bsdinfo p;
  int n = info(id->pid, &p);
  if (n < 0) { ambiguous = 1; return -1; }
  if (!n || p.pbi_start_tvsec != id->sec || p.pbi_start_tvusec != id->usec || p.pbi_status == SZOMB) return 0;
  return 1;
}
/* Read exact inherited ownership capability via kernel argv/environment bytes,
 * never ps text, guest output, registry PID, or a process-name substring. */
static int carries_token(pid_t pid) {
  int mib[] = { CTL_KERN, KERN_PROCARGS2, pid };
  size_t size = 0;
  if (sysctl(mib, 3, NULL, &size, NULL, 0)) {
    struct proc_bsdinfo p; if (info(pid, &p) == 1 && p.pbi_status != SZOMB) inspection_pending = 1;
    return 0;
  }
  char *buf = malloc(size);
  if (!buf) { ambiguous = 1; return 0; }
  if (sysctl(mib, 3, buf, &size, NULL, 0) || size < sizeof(int)) {
    struct proc_bsdinfo p; if (info(pid, &p) == 1 && p.pbi_status != SZOMB) inspection_pending = 1;
    free(buf); return 0;
  }
  int argc; memcpy(&argc, buf, sizeof(argc));
  char *p = buf + sizeof(argc), *end = buf + size;
  while (p < end && *p) p++;
  while (p < end && !*p) p++;
  for (int i = 0; i < argc && p < end; i++) {
    while (p < end && *p) p++;
    if (p < end) p++;
  }
  int matched = 0;
  const char *prefix = "ZERO_SMOLVM_RUN_TOKEN=";
  size_t plen = strlen(prefix), tlen = strlen(token);
  while (p < end) {
    size_t len = strnlen(p, (size_t)(end - p));
    if (len == plen + tlen && !memcmp(p, prefix, plen) && !memcmp(p + plen, token, tlen)) { matched = 1; break; }
    const char *family_prefix = "ZERO_SMOLVM_WORKBENCH_RUN=";
    size_t family_length = strlen(family_prefix);
    if (family_token && len == family_length + 64 && !memcmp(p, family_prefix, family_length) && !memcmp(p + family_length, family_token, 64)) {
      matched = 1;
      break;
    }
    if (len == (size_t)(end - p)) break;
    p += len + 1;
  }
  free(buf); return matched;
}
static int add(pid_t pid, int inherited) {
  for (int i = 0; i < count; i++) if (owned[i].pid == pid && same(&owned[i]) == 1) return 1;
  struct proc_bsdinfo p;
  int n = info(pid, &p);
  if (n < 0) { ambiguous = 1; return 0; }
  if (!n || p.pbi_status == SZOMB) return 0;
  if (p.pbi_uid != getuid() || (!inherited && !carries_token(pid))) return 0;
  if (count == MAX_OWNED) { ambiguous = 1; return 0; }
  struct identity id = { pid, p.pbi_start_tvsec, p.pbi_start_tvusec, 0, 0 };
  struct kevent ev;
  EV_SET(&ev, pid, EVFILT_PROC, EV_ADD | EV_ENABLE | EV_CLEAR, NOTE_EXIT | NOTE_FORK | NOTE_EXEC, 0, NULL);
  if (kevent(queue_fd, &ev, 1, NULL, 0, NULL)) {
    if (same(&id) == 1) ambiguous = 1;
  }
  owned[count++] = id;
  return 1;
}
/* Do not read unrelated operator argv/environment. Kernel vnode paths first
 * restrict discovery to this unmounted private run tree. Pinned CLI and VMM
 * qualification confirms that both retain this cwd, including sibling roots. */
static int private_run_cwd(pid_t pid) {
  struct proc_vnodepathinfo paths;
  if (proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &paths, sizeof(paths)) != sizeof(paths)) {
    char path[PROC_PIDPATHINFO_MAXSIZE];
    if (proc_pidpath(pid, path, sizeof(path)) > 0) {
      const char *name = strrchr(path, '/'); name = name ? name + 1 : path;
      if (!strcmp(path, native_binary) || !strcmp(name, supervisor_name)) inspection_pending = 1;
    }
    return 0;
  }
  return !strncmp(paths.pvi_cdir.vip_path, owner_root, owner_root_length)
    && (paths.pvi_cdir.vip_path[owner_root_length] == '/' || paths.pvi_cdir.vip_path[owner_root_length] == 0);
}
static void census(void) {
  // Exec transitions can temporarily hide kernel argv/vnode data. Defer proof,
  // rather than killing a known child or declaring unknown resources absent.
  inspection_pending = 0;
  int bytes = proc_listpids(PROC_ALL_PIDS, 0, NULL, 0);
  if (bytes <= 0) { ambiguous = 1; return; }
  int capacity = bytes + 4096;
  pid_t *pids = calloc(1, (size_t)capacity);
  if (!pids) { ambiguous = 1; return; }
  bytes = proc_listpids(PROC_ALL_PIDS, 0, pids, capacity);
  if (bytes <= 0) ambiguous = 1;
  if (bytes == capacity) inspection_pending = 1;
  for (int i = 0; i < bytes / (int)sizeof(pid_t); i++) {
    if (pids[i] <= 0 || pids[i] == getpid()) continue;
    struct proc_bsdinfo p;
    if (info(pids[i], &p) != 1 || p.pbi_uid != getuid() || p.pbi_status == SZOMB) continue;
    int known = 0;
    for (int j = 0; j < count; j++) if (owned[j].pid == pids[i] && !owned[j].exited
      && owned[j].sec == p.pbi_start_tvsec && owned[j].usec == p.pbi_start_tvusec) { known = 1; break; }
    if (!known && private_run_cwd(pids[i])) add(pids[i], 0);
  }
  free(pids);
}
static int living(void) {
  int live = 0;
  for (int i = 0; i < count; i++) if (same(&owned[i]) != 0) live++;
  return live;
}
static void terminate_owned(void) {
  /* Identity must still agree at the signal boundary; never signal a group. */
  for (int i = count - 1; i >= 0; i--) if (same(&owned[i]) == 1) {
    char path[PROC_PIDPATHINFO_MAXSIZE];
    if (proc_pidpath(owned[i].pid, path, sizeof(path)) <= 0) {
      if (same(&owned[i]) == 1) ambiguous = 1;
      continue;
    }
    const char *name = strrchr(path, '/'); name = name ? name + 1 : path;
    /* Controllers receive a cancellable signal and remain in the census until
     * their proof is published. Never SIGKILL a helper that could still fork. */
    int sig = !strcmp(name, supervisor_name) ? SIGTERM : SIGKILL;
    if (sig == SIGTERM) { if (owned[i].notified) continue; owned[i].notified = 1; }
    if (kill(owned[i].pid, sig) && errno != ESRCH) ambiguous = 1;
  }
}
static void write_result(const char *path, int code, int failed, const char *reason) {
  if (terminal_saved) {
    /* A dead controller may let the shell reclaim the foreground group. */
    signal(SIGTTOU, SIG_IGN);
    if (tcsetattr(STDIN_FILENO, TCSANOW, &original_terminal) && errno != ENOTTY && errno != EIO && errno != EBADF) {
      failed = 1; reason = "terminal-restore-failed";
    }
  }
  char json[512];
  int n = snprintf(json, sizeof(json), "{\"schemaVersion\":1,\"exitCode\":%d,\"cleanupFailed\":%s,\"cancelled\":%s,\"reason\":\"%s\"}\n", code, failed ? "true" : "false", cancelled ? "true" : "false", reason);
  char temporary[PROC_PIDPATHINFO_MAXSIZE];
  int length = snprintf(temporary, sizeof(temporary), "%s.%d.tmp", path, getpid());
  if (n < 0 || (size_t)n >= sizeof(json) || length < 0 || (size_t)length >= sizeof(temporary)) return;
  int fd = open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (fd < 0) return;
  if (write(fd, json, n) != n || fsync(fd)) { close(fd); unlink(temporary); return; }
  if (close(fd) || renamex_np(temporary, path, RENAME_EXCL)) { unlink(temporary); return; }
  /* fd4 is protocol-only, independent of inherited terminal stdio. */
  (void)write(4, json, n);
}
static int control_line(char *line, size_t capacity, int interruptible) {
  size_t length = 0;
  while (length + 1 < capacity) {
    ssize_t n = read(3, line + length, 1);
    if (n < 0 && errno == EINTR) { if (interruptible && cancelled) return -1; continue; }
    if (n <= 0) return (int)n;
    if (line[length++] == '\n') { line[length] = 0; return 1; }
  }
  return -1;
}
int main(int argc, char **argv) {
  if (argc < 5 || strcmp(argv[3], "--")) return 125;
  pid_t parent = (pid_t)strtol(argv[1], NULL, 10);
  token = getenv("ZERO_SMOLVM_RUN_TOKEN");
  if (parent <= 1 || getppid() != parent || !token || strlen(token) != 64) return 125;
  family_token = getenv("ZERO_SMOLVM_SUPERVISE_FAMILY") ? getenv("ZERO_SMOLVM_WORKBENCH_RUN") : NULL;
  if (family_token && strlen(family_token) != 64) return 125;
  supervisor_name = strrchr(argv[0], '/'); supervisor_name = supervisor_name ? supervisor_name + 1 : argv[0];
  if (!getcwd(owner_root, sizeof(owner_root))) return 125;
  owner_root_length = strlen(owner_root);
  if (snprintf(native_binary, sizeof(native_binary), "%s-bin", argv[4]) >= (int)sizeof(native_binary)) return 125;
  struct proc_bsdinfo parent_info;
  if (info(parent, &parent_info) != 1 || parent_info.pbi_uid != getuid()) return 125;
  signal(SIGINT, interrupt); signal(SIGTERM, interrupt); signal(SIGHUP, interrupt); signal(SIGPIPE, SIG_IGN);
  terminal_saved = isatty(STDIN_FILENO) && tcgetattr(STDIN_FILENO, &original_terminal) == 0;
  queue_fd = kqueue();
  if (queue_fd < 0) return 125;
  fcntl(queue_fd, F_SETFD, FD_CLOEXEC);
  struct kevent initial[2];
  EV_SET(&initial[0], parent, EVFILT_PROC, EV_ADD | EV_ENABLE, NOTE_EXIT, 0, (void *)1);
  EV_SET(&initial[1], 3, EVFILT_READ, EV_ADD | EV_ENABLE | EV_CLEAR, 0, 0, (void *)2);
  if (kevent(queue_fd, initial, 2, NULL, 0, NULL)) return 125;
  struct proc_bsdinfo check;
  if (info(parent, &check) != 1 || check.pbi_start_tvsec != parent_info.pbi_start_tvsec || check.pbi_start_tvusec != parent_info.pbi_start_tvusec || getppid() != parent) return 125;
  const char *lock_path = getenv("ZERO_SMOLVM_ADMISSION_LOCK");
  int admission_fd = -1;
  if (lock_path) {
    admission_fd = open(lock_path, O_RDWR | O_CREAT | O_NOFOLLOW, 0600);
    if (admission_fd < 0 || flock(admission_fd, LOCK_EX | LOCK_NB)) {
      write_result(argv[2], -1, 0, "admission-busy"); return 0;
    }
    fcntl(admission_fd, F_SETFD, FD_CLOEXEC);
    if (write(4, "READY\n", 6) != 6) return 125;
    char command[16] = {0};
    int received = control_line(command, sizeof(command), 1);
    if (received != 1 || strcmp(command, "launch\n") || cancelled || getppid() != parent) {
      cancelled = 1; write_result(argv[2], -1, 0, "cancelled-before-launch"); return 0;
    }
  }
  int gate[2]; if (pipe(gate)) return 125;
  pid_t child = fork();
  if (child < 0) return 125;
  if (!child) {
    close(gate[1]); close(queue_fd); close(3); close(4);
    if (admission_fd >= 0) close(admission_fd);
    char go; if (read(gate[0], &go, 1) != 1 || cancelled) _exit(125);
    close(gate[0]);
    signal(SIGINT, SIG_DFL); signal(SIGTERM, SIG_DFL); signal(SIGHUP, SIG_DFL); signal(SIGPIPE, SIG_DFL);
    execv(argv[4], &argv[4]); _exit(127);
  }
  close(gate[0]);
  if (!add(child, 1) || ambiguous) cancelled = 1;
  if (!cancelled && write(gate[1], "x", 1) != 1) cancelled = 1;
  close(gate[1]);
  int reaped = 0, status = 0, code = -1, quiet = 0;
  double cleanup_deadline = 0;
  const char *reason = "complete";
  for (;;) {
    struct kevent events[128]; struct timespec tick = {0, 50000000};
    int n = kevent(queue_fd, NULL, 0, events, 128, &tick);
    if (n < 0 && errno != EINTR) { ambiguous = 1; cancelled = 1; }
    for (int i = 0; i < n; i++) {
      struct kevent *ev = &events[i];
      if (ev->flags & EV_ERROR) { ambiguous = 1; cancelled = 1; continue; }
      if (ev->udata == (void *)1) { cancelled = 1; reason = "parent-exited"; continue; }
      if (ev->udata == (void *)2) {
        char command[32]; (void)read(3, command, sizeof(command));
        cancelled = 1; reason = "cancelled"; continue;
      }
      /* Darwin removed NOTE_TRACK/NOTE_CHILD in 10.5. NOTE_FORK/EXEC wake a
       * complete libproc census instead. Every pinned upstream launch inherits
       * the private token, including reparented VMM and cleanup helpers. */
      if (ev->fflags & NOTE_EXIT) {
        for (int j = 0; j < count; j++) if (owned[j].pid == (pid_t)ev->ident) owned[j].exited = 1;
      }
    }
    if (!reaped) {
      pid_t waited = waitpid(child, &status, WNOHANG);
      if (waited == child) { reaped = 1; code = WIFEXITED(status) ? WEXITSTATUS(status) : -1; }
      else if (waited < 0 && errno != EINTR) { ambiguous = 1; reaped = 1; }
    }
    census();
    if (cancelled || reaped || ambiguous) {
      if (!cleanup_deadline) cleanup_deadline = now() + 15;
      terminate_owned();
      if (reaped && !living() && !inspection_pending && n == 0) quiet++; else quiet = 0;
      if (quiet >= 3 || now() >= cleanup_deadline) break;
    }
  }
  int failed = ambiguous || inspection_pending || !reaped || living();
  if (failed) reason = inspection_pending ? "process-inspection-unconfirmed" : "teardown-unconfirmed";
  write_result(argv[2], code, failed, reason);
  if (admission_fd >= 0) {
    /* Keep the kernel admission lock until the live controller has removed
     * its lease/state. EOF covers abrupt controller death without PID guesses. */
    char acknowledgement[32];
    while (control_line(acknowledgement, sizeof(acknowledgement), 0) > 0 && strcmp(acknowledgement, "release\n")) {}
    close(admission_fd);
  }
  close(queue_fd);
  return failed ? 125 : 0;
}
`;
