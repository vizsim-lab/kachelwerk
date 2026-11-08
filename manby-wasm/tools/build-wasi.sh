#!/usr/bin/env bash
# Builds manby for wasm32-wasip1. Run it from manby's directory, with the
# patches applied; extra arguments go to `cargo build`.
#
# Usual setup:
#   rustup target add wasm32-wasip1
#   WASI_SDK=/opt/wasi-sdk ./build-wasi.sh
# wasi-sdk (https://github.com/WebAssembly/wasi-sdk/releases) compiles the C
# libraries manby uses (zlib, libdeflate, zstd, SQLite).
#
# Without the rustup target, BUILD_STD=1 builds std from the rust-src
# component, and links pthread stubs for a wasi-libc older than 2024 (such as
# Ubuntu 24.04's wasi-libc package, used with the system clang).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

if [ -n "${WASI_SDK:-}" ]; then
  export CC_wasm32_wasip1="$WASI_SDK/bin/clang"
  export AR_wasm32_wasip1="$WASI_SDK/bin/llvm-ar"
else
  export CC_wasm32_wasip1="${CC_wasm32_wasip1:-clang}"
  export AR_wasm32_wasip1="${AR_wasm32_wasip1:-llvm-ar}"
fi

args=(build --release --target wasm32-wasip1 --bin manby)
if [ "${BUILD_STD:-0}" = 1 ]; then
  stub="$here/libwasi_pthread_stub.a"
  "$CC_wasm32_wasip1" --target=wasm32-wasip1 -O2 -c "$here/pthread_stub.c" -o "$here/pthread_stub.o"
  "$AR_wasm32_wasip1" rcs "$stub" "$here/pthread_stub.o"
  export RUSTC_BOOTSTRAP=1
  export CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS="-C link-arg=$stub"
  args+=(-Zbuild-std=std,panic_abort)
fi

cargo "${args[@]}" "$@"
echo "built target/wasm32-wasip1/release/manby.wasm; strip its debug info with: llvm-strip -o manby.wasm target/wasm32-wasip1/release/manby.wasm"
