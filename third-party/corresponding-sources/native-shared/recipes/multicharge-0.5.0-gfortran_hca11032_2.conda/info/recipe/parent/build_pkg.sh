#!/usr/bin/env bash

set -ex

for pkg in lapack blas; do
  if [ -f $PREFIX/lib/pkgconfig/$pkg.pc ]; then
    mv $PREFIX/lib/pkgconfig/$pkg.pc $SRC_DIR
  fi
done

if [[ "${CONDA_BUILD_CROSS_COMPILATION:-}" != "1" ]]; then
  MESON_ARGS=${MESON_ARGS:---prefix=${PREFIX} --libdir=lib}
else
  cat > pkgconfig.ini <<EOF
[binaries]
pkgconfig = '$BUILD_PREFIX/bin/pkg-config'
EOF
  MESON_ARGS="${MESON_ARGS:---prefix=${PREFIX} --libdir=lib} --cross-file pkgconfig.ini"
fi

meson setup _build \
  ${MESON_ARGS} \
  -Ddefault_library=shared \
  --wrap-mode=nodownload \
  -Dlapack=custom \
  -Dcustom_libraries=lapack,blas

meson compile -C _build
if [[ "${CONDA_BUILD_CROSS_COMPILATION:-}" != "1" ]]; then
  meson test -C _build --no-rebuild --print-errorlogs
fi
meson install -C _build --no-rebuild

for pkg in lapack blas; do
  if [ -f $SRC_DIR/$pkg.pc ]; then
    mv $SRC_DIR/$pkg.pc $PREFIX/lib/pkgconfig
  fi
done
