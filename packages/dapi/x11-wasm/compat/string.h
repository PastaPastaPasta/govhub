/* Freestanding stand-in for <string.h>: the sphlib sources only need these three; clang lowers the builtins to wasm
 * memory.copy / memory.fill (-mbulk-memory) or inline loads/stores, so no libc symbol is ever linked. */
#ifndef X11_WASM_STRING_H
#define X11_WASM_STRING_H
#include <stddef.h>
#define memcpy  __builtin_memcpy
#define memmove __builtin_memmove
#define memset  __builtin_memset
#endif
