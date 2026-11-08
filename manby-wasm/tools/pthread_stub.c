/*
 * Minimal pthread stubs for single-threaded WASI (wasm32-wasip1).
 *
 * Rust's std references these symbols on wasm32-wasip1. Newer wasi-libc
 * releases ship equivalent stubs; the wasi-libc in Ubuntu 24.04 (2023) does
 * not. pthread_create fails with ENOTSUP, which std reports as
 * io::ErrorKind::Unsupported, so rayon's global pool falls back to running on
 * the current thread.
 */
#include <errno.h>
#include <stddef.h>

int pthread_attr_init(void *attr) { (void)attr; return 0; }
int pthread_attr_destroy(void *attr) { (void)attr; return 0; }
int pthread_attr_setstacksize(void *attr, size_t size) { (void)attr; (void)size; return 0; }

int pthread_create(void *thread, const void *attr, void *(*start)(void *), void *arg) {
    (void)thread; (void)attr; (void)start; (void)arg;
    return ENOTSUP;
}

int pthread_join(unsigned long thread, void **retval) { (void)thread; (void)retval; return ESRCH; }
int pthread_detach(unsigned long thread) { (void)thread; return 0; }
unsigned long pthread_self(void) { return 1; }
