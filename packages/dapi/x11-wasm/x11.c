/* X11 (Dash block hash) for WebAssembly: the sphlib chain from Dash Core's HashX11 (src/hash_x11.h), freestanding, no imports.
 * blake512 -> bmw512 -> groestl512 -> skein512 -> jh512 -> keccak512 -> luffa512 -> cubehash512 -> shavite512 -> simd512 -> echo512,
 * result = first 32 bytes of the last 64-byte digest (uint512::trim256()). See build.sh for provenance. */
#include <stdint.h>
#include <stddef.h>
#include "sph_blake.h"
#include "sph_bmw.h"
#include "sph_groestl.h"
#include "sph_skein.h"
#include "sph_jh.h"
#include "sph_keccak.h"
#include "sph_luffa.h"
#include "sph_cubehash.h"
#include "sph_shavite.h"
#include "sph_simd.h"
#include "sph_echo.h"

#define EXPORT __attribute__((visibility("default")))

/* One stage: hash `len` bytes from `in` into 64 bytes at `out`. Same call order as HashX11: init, update, close. */
#define STAGE(name) \
  static void run_##name(const void *in, size_t len, void *out) { \
    sph_##name##512_context c; \
    sph_##name##512_init(&c); sph_##name##512(&c, in, len); sph_##name##512_close(&c, out); \
  }
STAGE(blake) STAGE(bmw) STAGE(groestl) STAGE(skein) STAGE(jh) STAGE(keccak) STAGE(luffa) STAGE(cubehash) STAGE(shavite) STAGE(simd) STAGE(echo)

typedef void (*stage_fn)(const void *, size_t, void *);
static const stage_fn STAGES[11] = {run_blake, run_bmw, run_groestl, run_skein, run_jh, run_keccak, run_luffa, run_cubehash, run_shavite, run_simd, run_echo};

/* Single algorithm for tests: stage 0..10 in X11 order. Returns 0 on success, -1 for a bad stage. out64 gets 64 bytes. */
EXPORT int32_t x11_stage(uint32_t stage, const uint8_t *in, uint32_t len, uint8_t *out64) {
  if (stage > 10) return -1;
  STAGES[stage](in, len, out64);
  return 0;
}

EXPORT void x11_hash(const uint8_t *in, uint32_t len, uint8_t *out32) {
  uint8_t h[2][64] __attribute__((aligned(8)));
  STAGES[0](in, len, h[0]);
  int cur = 0;
  for (int i = 1; i < 10; i++) { STAGES[i](h[cur], 64, h[cur ^ 1]); cur ^= 1; }
  STAGES[10](h[cur], 64, h[cur ^ 1]);
  const uint8_t *r = h[cur ^ 1];
  for (int i = 0; i < 32; i++) out32[i] = r[i];
}

/* n consecutive 80-byte headers -> n * 32 bytes. */
EXPORT void x11_batch(const uint8_t *headers, uint32_t n, uint8_t *out) {
  for (uint32_t i = 0; i < n; i++) x11_hash(headers + (size_t)i * 80, 80, out + (size_t)i * 32);
}

/* Scratch region for JS: returns a 16-byte-aligned pointer just past the static data and stack (__heap_base), growing linear
 * memory so that `bytes` are addressable; 0 if the host refuses. There is one region: a later call invalidates the earlier
 * contents, and memory.buffer must be re-read after any call (growth detaches it). */
extern unsigned char __heap_base;
EXPORT uint8_t *x11_buf(uint32_t bytes) {
  uintptr_t base = ((uintptr_t)&__heap_base + 15u) & ~(uintptr_t)15u;
  uint64_t need = (uint64_t)base + bytes;
  uint64_t have = (uint64_t)__builtin_wasm_memory_size(0) * 65536u;
  if (need > have) {
    size_t pages = (size_t)((need - have + 65535u) / 65536u);
    if (__builtin_wasm_memory_grow(0, pages) == (size_t)-1) return 0;
  }
  return (uint8_t *)base;
}
