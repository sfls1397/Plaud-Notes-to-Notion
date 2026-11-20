#!/usr/bin/env bash
set -euo pipefail
lint_home="${REPO_LINT_HOME:-$HOME/.local/share/repo-lint/plaud-notes-to-notion}"
mkdir -p "$lint_home"
if [[ "${1:-}" != '--lock-held' ]]; then
  if command -v lockf >/dev/null 2>&1; then
    exec lockf -k -t 300 "$lint_home/install.lock" bash "${BASH_SOURCE[0]}" --lock-held
  elif command -v flock >/dev/null 2>&1; then
    exec flock -x -w 300 "$lint_home/install.lock" bash "${BASH_SOURCE[0]}" --lock-held
  else
    echo 'Lint installation needs lockf (macOS) or flock (Linux)' >&2
    exit 1
  fi
fi
shift
version=0.17.3
case "$(uname -s)/$(uname -m)" in
  Darwin/arm64|Darwin/aarch64) target=aarch64-apple-darwin; checksum=118f7121aa838785672bf612487f755a89108bb5f44e0f3df96c5967a72614f9 ;;
  Darwin/x86_64) target=x86_64-apple-darwin; checksum=17f95b1bee24d70de62ffe5beec7f71bb541c7e3d147a1c3d84f7cd6525f6fdf ;;
  Linux/aarch64|Linux/arm64) target=aarch64-unknown-linux-gnu; checksum=3f4639152c0e42bb5938e6c23d53d527a38f3133e000102934518f90529fa299 ;;
  Linux/x86_64) target=x86_64-unknown-linux-gnu; checksum=2b0890f5a55900af741f133918c2656919bbf18c2ab7741b4ca8403a90e647a9 ;;
  *) echo 'Unsupported Ruff platform' >&2; exit 1 ;;
esac
shfmt_version=3.14.1
case "$(uname -s)/$(uname -m)" in
  Darwin/arm64|Darwin/aarch64) shfmt_target=darwin_arm64; shfmt_checksum=b7c872db63553ccffc7253aba3ed7d4885a27d83f1ba567b1138c6315a5847e5 ;;
  Darwin/x86_64) shfmt_target=darwin_amd64; shfmt_checksum=d33eee0da0f92835b3562e9767a05cee7e4eaeef47daa03bfd09da17b4b590a6 ;;
  Linux/aarch64|Linux/arm64) shfmt_target=linux_arm64; shfmt_checksum=5f2db09dae91fca848f7adbdd014632e921a383863a2ad7e0450ad3aba0c6489 ;;
  Linux/x86_64) shfmt_target=linux_amd64; shfmt_checksum=76e77641faa025814b77f153b29796b8e6fa2fca03e0c76a691608b86c7ea7bf ;;
  *) echo 'Unsupported shfmt platform' >&2; exit 1 ;;
esac
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
temporary=$(mktemp -d "$lint_home/.install-XXXXXX")
trap 'rm -rf "${temporary:?}"' EXIT

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}

ruff_dir="$lint_home/ruff-$version"
if [[ ! -x "$ruff_dir/ruff" ]] || [[ "$("$ruff_dir/ruff" --version | awk '{print $2}')" != "$version" ]]; then
  curl -fsSL "https://github.com/astral-sh/ruff/releases/download/$version/ruff-$target.tar.gz" -o "$temporary/ruff.tar.gz"
  test "$(sha256 "$temporary/ruff.tar.gz")" = "$checksum" || { echo 'Ruff checksum mismatch' >&2; exit 1; }
  tar -xzf "$temporary/ruff.tar.gz" -C "$temporary"
  mkdir -p "$temporary/ruff-install"
  install -m 755 "$temporary/ruff-$target/ruff" "$temporary/ruff-install/ruff"
  rm -rf "${ruff_dir:?}"
  mv "$temporary/ruff-install" "$ruff_dir"
fi
test "$("$ruff_dir/ruff" --version | awk '{print $2}')" = "$version"

shfmt_dir="$lint_home/shfmt-$shfmt_version"
if [[ ! -x "$shfmt_dir/shfmt" ]] || [[ "$("$shfmt_dir/shfmt" --version)" != "v$shfmt_version" ]]; then
  curl -fsSL "https://github.com/mvdan/sh/releases/download/v$shfmt_version/shfmt_v${shfmt_version}_$shfmt_target" -o "$temporary/shfmt"
  test "$(sha256 "$temporary/shfmt")" = "$shfmt_checksum" || { echo 'shfmt checksum mismatch' >&2; exit 1; }
  mkdir -p "$temporary/shfmt-install"
  install -m 755 "$temporary/shfmt" "$temporary/shfmt-install/shfmt"
  rm -rf "${shfmt_dir:?}"
  mv "$temporary/shfmt-install" "$shfmt_dir"
fi
test "$("$shfmt_dir/shfmt" --version)" = "v$shfmt_version"

lock=$(sha256 "$repo_root/.lint/package-lock.json" | cut -c1-16)
node_root="$lint_home/node-$lock"
if [[ ! -x "$node_root/node_modules/.bin/eslint" ]]; then
  rm -rf "${node_root:?}"
  cp "$repo_root/.lint/package.json" "$repo_root/.lint/package-lock.json" "$temporary/"
  npm ci --prefix "$temporary" --ignore-scripts --no-audit --no-fund --loglevel=error >/dev/null
  mkdir -p "$temporary/node"
  mv "$temporary/node_modules" "$temporary/package.json" "$temporary/package-lock.json" "$temporary/node/"
  mv "$temporary/node" "$node_root"
fi
for tool in eslint tsc pyright; do
  test -x "$node_root/node_modules/.bin/$tool"
done
"$node_root/node_modules/.bin/eslint" --version
"$node_root/node_modules/.bin/tsc" --version
"$node_root/node_modules/.bin/pyright" --version
"$ruff_dir/ruff" --version
"$shfmt_dir/shfmt" --version
for old in "$lint_home"/node-*; do
  if [[ "$old" != "$node_root" && -d "$old" && ! -L "$old" && "${old##*/}" =~ ^node-[a-f0-9]{16}$ ]]; then
    rm -rf "${old:?}"
  fi
done
