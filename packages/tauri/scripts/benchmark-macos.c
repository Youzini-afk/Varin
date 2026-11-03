/* SDK-exposed, read-only libproc APIs. No task_for_pid, sudo, entitlements, process
 * names, command lines or environment data. Built against the installed SDK.
 *
 * ri_phys_footprint is a task ledger footprint, NOT RSS/PSS/private bytes.
 * XNU fill_task_rusage copies task_power_info's Mach absolute CPU time:
 * https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/bsd_kern.c
 * https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/task.c
 * Convert with mach_timebase_info, including on Apple Silicon.
 */
#ifdef __APPLE__
#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <libproc.h>
#include <mach/mach_time.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <sys/resource.h>
#include <unistd.h>

static bool same_identity(const struct proc_bsdinfo *a, const struct proc_bsdinfo *b) {
    return a->pbi_pid == b->pbi_pid && a->pbi_start_tvsec == b->pbi_start_tvsec &&
        a->pbi_start_tvusec == b->pbi_start_tvusec;
}

static int descriptor_count(pid_t pid) {
    errno = 0;
    int needed = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
    if (needed < 0 || (needed == 0 && errno != 0)) return -1;
    if (needed == 0) return 0;
    /* Account for descriptor growth between sizing and reading. A full buffer
     * is retried with more space, never treated as a complete count. */
    for (int attempt = 0; attempt < 4; attempt++) {
        if (needed > INT_MAX / 2 - (int)(32 * sizeof(struct proc_fdinfo))) return -1;
        int capacity = needed + (int)(32 * sizeof(struct proc_fdinfo));
        struct proc_fdinfo *fds = malloc((size_t)capacity);
        if (!fds) return -1;
        errno = 0;
        int used = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, capacity);
        int saved_errno = errno;
        free(fds);
        if (used < 0 || (used == 0 && saved_errno != 0) || used % (int)sizeof(struct proc_fdinfo)) return -1;
        if (used < capacity) return used / (int)sizeof(struct proc_fdinfo);
        needed = capacity * 2;
    }
    return -1;
}

int main(void) {
    mach_timebase_info_data_t timebase;
    if (mach_timebase_info(&timebase) != KERN_SUCCESS || !timebase.denom) {
        fputs("Cannot read Mach timebase\n", stderr); return 1;
    }
    int count = proc_listallpids(NULL, 0);
    if (count <= 0) { fputs("Cannot enumerate process table\n", stderr); return 1; }
    pid_t *pids = NULL;
    int used = 0, capacity = 0;
    bool complete = false;
    for (int attempt = 0; attempt < 4; attempt++) {
        if (count > INT_MAX / (int)sizeof(pid_t) - 128) { free(pids); return 1; }
        capacity = count + 128;
        pid_t *next = realloc(pids, (size_t)capacity * sizeof(pid_t));
        if (!next) { free(pids); return 1; }
        pids = next;
        used = proc_listallpids(pids, capacity * (int)sizeof(pid_t));
        if (used <= 0) { free(pids); fputs("Cannot read process table\n", stderr); return 1; }
        if (used < capacity) { complete = true; break; }
        if (capacity > INT_MAX / 2) { free(pids); return 1; }
        count = capacity * 2;
    }
    if (!complete) { free(pids); fputs("Process table did not stabilize\n", stderr); return 1; }
    struct proc_bsdinfo *snapshot = calloc((size_t)used, sizeof(struct proc_bsdinfo));
    int *identity_errors = calloc((size_t)used, sizeof(int));
    if (!snapshot || !identity_errors) { free(snapshot); free(identity_errors); free(pids); return 1; }
    /* Finish metadata for the full table before verifying any parent. Otherwise
     * a reused parent PID could adopt a child seen later in the same scan. */
    for (int index = 0; index < used; index++) {
        if (pids[index] <= 0 || pids[index] == getpid()) continue;
        errno = 0;
        int bytes = proc_pidinfo(pids[index], PROC_PIDTBSDINFO, 0, &snapshot[index], sizeof(snapshot[index]));
        if (bytes != (int)sizeof(snapshot[index])) identity_errors[index] = errno ? errno : EIO;
    }
    fputs("{\"processes\":[", stdout);
    bool comma = false;
    for (int index = 0; index < used; index++) {
        pid_t pid = pids[index];
        if (pid <= 0 || pid == getpid()) continue; /* Collector is not the measured app. */
        struct proc_bsdinfo before = snapshot[index], after = {0};
        if (identity_errors[index]) {
            if (identity_errors[index] == ESRCH || identity_errors[index] == ENOENT) continue;
            printf("%s{\"pid\":%d,\"startIdentity\":null}", comma ? "," : "", pid); comma = true;
            continue;
        }
        struct rusage_info_v2 usage = {0};
        bool resource_ok = proc_pid_rusage(pid, RUSAGE_INFO_V2, (rusage_info_t *)&usage) == 0;
        int handles = descriptor_count(pid);
        errno = 0;
        int bytes = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, sizeof(after));
        bool identity_ok = bytes == (int)sizeof(after) && same_identity(&before, &after);
        if (!identity_ok) {
            if (bytes != (int)sizeof(after) && (errno == ESRCH || errno == ENOENT)) continue;
            printf("%s{\"pid\":%d,\"parentPid\":%u,\"startIdentity\":null}", comma ? "," : "", pid, before.pbi_ppid); comma = true;
            continue;
        }
        uint64_t start = before.pbi_start_tvsec * UINT64_C(1000000) + before.pbi_start_tvusec;
        printf("%s{\"pid\":%d,\"parentPid\":%u,\"startIdentity\":\"darwin:%" PRIu64 "\",\"startOrder\":\"%" PRIu64 "\",\"state\":\"%s\",\"cpuTimeMs\":",
            comma ? "," : "", pid, before.pbi_ppid, start, start, before.pbi_status == SZOMB ? "zombie" : "running");
        comma = true;
        if (resource_ok && identity_ok) {
            long double cpu_ms = ((long double)usage.ri_user_time + (long double)usage.ri_system_time)
                * (long double)timebase.numer / (long double)timebase.denom / 1000000.0L;
            printf("%.6Lf,\"memoryBytes\":%" PRIu64, cpu_ms, usage.ri_phys_footprint);
        } else fputs("null,\"memoryBytes\":null", stdout);
        fputs(",\"handles\":", stdout);
        if (handles >= 0 && identity_ok) printf("%d", handles); else fputs("null", stdout);
        if (!resource_ok || !identity_ok || handles < 0) fputs(",\"counterError\":\"COUNTERS_OR_IDENTITY_UNAVAILABLE\"", stdout);
        fputs("}", stdout);
    }
    free(snapshot); free(identity_errors); free(pids);
    printf("],\"machTimebase\":{\"numer\":%u,\"denom\":%u}}\n", timebase.numer, timebase.denom);
    return ferror(stdout) ? 1 : 0;
}
#else
#include <stdio.h>
int main(void) { fputs("This counter helper requires macOS and its installed SDK\n", stderr); return 2; }
#endif
