#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)

# Defaults are the audited sources bundled in this canonical repository.
BOSS_CLI_SOURCE=${BOSS_CLI_SOURCE:-$PROJECT_ROOT/boss-cli-source}
GATEWAY_SOURCE=${GATEWAY_SOURCE:-$PROJECT_ROOT/recruiting-gateway}
WUYOU_CLI_SOURCE=${WUYOU_CLI_SOURCE:-$PROJECT_ROOT/wuyou-cli}
# Liepin source is not bundled. Fail closed instead of silently installing an unpinned package.
LIEPIN_CLI_SOURCE=${LIEPIN_CLI_SOURCE:-}
PROFILE_BLOCK_START='# >>> recruiting-copilot npm global bin >>>'
PROFILE_BLOCK_END='# <<< recruiting-copilot npm global bin <<<'
CHECK_ONLY=0
boss_build_dir=''
wuyou_build_dir=''
gateway_build_dir=''

cleanup_build_dirs() {
  [ -z "$boss_build_dir" ] || rm -rf -- "$boss_build_dir"
  [ -z "$wuyou_build_dir" ] || rm -rf -- "$wuyou_build_dir"
  [ -z "$gateway_build_dir" ] || rm -rf -- "$gateway_build_dir"
}
trap cleanup_build_dirs 0 HUP INT TERM

copy_source_tree() {
  source_dir=$1
  destination_dir=$2
  keep_dist=${3:-0}
  command -v tar >/dev/null 2>&1 || die 'tar is required to stage bundled source packages.'
  mkdir -p "$destination_dir"
  if [ "$keep_dist" -eq 1 ]; then
    (cd "$source_dir" && tar --exclude='./node_modules' --exclude='./coverage' -cf - .) |
      (cd "$destination_dir" && tar -xf -)
  else
    (cd "$source_dir" && tar --exclude='./node_modules' --exclude='./dist' --exclude='./coverage' -cf - .) |
      (cd "$destination_dir" && tar -xf -)
  fi
}

usage() {
  cat <<'EOF'
Usage: install-dependencies.sh [--check-only]

Installs recruiting-copilot's Gateway (recruitctl), Boss, Liepin and Wuyou (51job) CLIs. On macOS and other
Unix-like systems, it also repairs the npm global executable PATH when needed.

Environment overrides:
  GATEWAY_SOURCE    npm install source for recruiting-gateway
  BOSS_CLI_SOURCE   npm install source for Boss CLI
  LIEPIN_CLI_SOURCE explicit pinned source for Liepin CLI (required; no unsafe default)
  WUYOU_CLI_SOURCE  npm install source for Wuyou (51job) CLI
EOF
}

die() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check-only) CHECK_ONLY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

command -v node >/dev/null 2>&1 || die 'Node.js 20 or newer is required.'
command -v npm >/dev/null 2>&1 || die 'npm is required.'
[ -n "$LIEPIN_CLI_SOURCE" ] || die 'LIEPIN_CLI_SOURCE is required because no audited Liepin source is bundled.'

node_major=$(node -p 'process.versions.node.split(".")[0]')
case "$node_major" in
  ''|*[!0-9]*) die "could not parse Node.js version: $node_major" ;;
esac
[ "$node_major" -ge 20 ] || die "Node.js 20 or newer is required (found $node_major)."

npm_prefix=$(npm config get prefix)
[ -n "$npm_prefix" ] || die 'npm global prefix is empty.'

platform=$(uname -s 2>/dev/null || printf 'unknown')
case "$platform" in
  MINGW*|MSYS*|CYGWIN*) npm_bin=$npm_prefix ;;
  *) npm_bin=$npm_prefix/bin ;;
esac

path_contains() {
  case ":${PATH:-}:" in
    *:"$1":*) return 0 ;;
    *) return 1 ;;
  esac
}

profile_path() {
  case "${SHELL:-}" in
    */zsh) printf '%s/.zprofile\n' "$HOME" ;;
    */bash) printf '%s/.bash_profile\n' "$HOME" ;;
    *) printf '%s/.profile\n' "$HOME" ;;
  esac
}

write_managed_path_block() {
  profile=$1
  bin_dir=$2
  mkdir -p "$(dirname "$profile")"
  touch "$profile"

  escaped_bin=$(printf '%s' "$bin_dir" | sed 's/[\\"`$]/\\&/g')
  temp_file=$(mktemp "${TMPDIR:-/tmp}/recruiting-copilot-profile.XXXXXX")
  awk -v start="$PROFILE_BLOCK_START" -v end="$PROFILE_BLOCK_END" '
    $0 == start { skipping = 1; next }
    $0 == end { skipping = 0; next }
    !skipping { print }
  ' "$profile" >"$temp_file"

  if [ -s "$temp_file" ] && [ "$(tail -c 1 "$temp_file" 2>/dev/null || true)" != '' ]; then
    printf '\n' >>"$temp_file"
  fi
  {
    printf '%s\n' "$PROFILE_BLOCK_START"
    printf 'export PATH="%s:$PATH"\n' "$escaped_bin"
    printf '%s\n' "$PROFILE_BLOCK_END"
  } >>"$temp_file"
  mv "$temp_file" "$profile"
}

printf 'Node.js: v%s\n' "$node_major"
printf 'npm global bin: %s\n' "$npm_bin"
printf 'Boss CLI source: %s\n' "$BOSS_CLI_SOURCE"
printf 'Gateway source: %s\n' "$GATEWAY_SOURCE"
printf 'Liepin CLI source: %s\n' "$LIEPIN_CLI_SOURCE"
printf 'Wuyou CLI source: %s\n' "$WUYOU_CLI_SOURCE"

if ! path_contains "$npm_bin"; then
  if [ "$CHECK_ONLY" -eq 1 ]; then
    printf 'PATH needs update: add %s\n' "$npm_bin"
  else
    profile=$(profile_path)
    write_managed_path_block "$profile" "$npm_bin"
    PATH="$npm_bin:$PATH"
    export PATH
    printf 'Updated shell PATH in %s\n' "$profile"
  fi
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  printf 'Check only: no packages were installed.\n'
  exit 0
fi

boss_install_source=$BOSS_CLI_SOURCE
case "$BOSS_CLI_SOURCE" in
  /*)
    [ -d "$BOSS_CLI_SOURCE" ] || die "Boss CLI source directory does not exist: $BOSS_CLI_SOURCE"
    boss_build_dir=$(mktemp -d "${TMPDIR:-/tmp}/recruiting-copilot-boss.XXXXXX")
    copy_source_tree "$BOSS_CLI_SOURCE" "$boss_build_dir/source"
    printf 'Building bundled Boss CLI...\n'
    (
      cd "$boss_build_dir/source"
      npm ci
      npm run build
      npm pack --pack-destination "$boss_build_dir"
    )
    set -- "$boss_build_dir"/*.tgz
    [ "$#" -eq 1 ] && [ -f "$1" ] || die 'Boss CLI build did not produce exactly one package archive.'
    boss_install_source=$1
    ;;
  git+*'#'*)
    command -v git >/dev/null 2>&1 || die 'git is required to build the Boss CLI fork.'
    repository_and_ref=${BOSS_CLI_SOURCE#git+}
    boss_repository=${repository_and_ref%#*}
    boss_ref=${repository_and_ref##*#}
    [ -n "$boss_repository" ] || die 'Boss CLI repository is empty.'
    [ -n "$boss_ref" ] || die 'Boss CLI git ref is empty.'

    boss_build_dir=$(mktemp -d "${TMPDIR:-/tmp}/recruiting-copilot-boss.XXXXXX")
    printf 'Cloning Boss CLI fork (%s)...\n' "$boss_ref"
    git clone --depth 1 --branch "$boss_ref" "$boss_repository" "$boss_build_dir/source"
    printf 'Building Boss CLI fork...\n'
    (
      cd "$boss_build_dir/source"
      npm ci
      npm run build
      npm pack --pack-destination "$boss_build_dir"
    )
    set -- "$boss_build_dir"/*.tgz
    [ "$#" -eq 1 ] && [ -f "$1" ] || die 'Boss CLI build did not produce exactly one package archive.'
    boss_install_source=$1
    ;;
esac

printf 'Installing Boss CLI from maintained fork...\n'
npm install -g "$boss_install_source"
printf 'Installing Liepin CLI...\n'
npm install -g "$LIEPIN_CLI_SOURCE"

wuyou_install_source=$WUYOU_CLI_SOURCE
case "$WUYOU_CLI_SOURCE" in
  /*)
    [ -d "$WUYOU_CLI_SOURCE" ] || die "Wuyou CLI source directory does not exist: $WUYOU_CLI_SOURCE"
    wuyou_build_dir=$(mktemp -d "${TMPDIR:-/tmp}/recruiting-copilot-wuyou.XXXXXX")
    copy_source_tree "$WUYOU_CLI_SOURCE" "$wuyou_build_dir/source" 1
    (
      cd "$wuyou_build_dir/source"
      npm pack --pack-destination "$wuyou_build_dir"
    )
    set -- "$wuyou_build_dir"/*.tgz
    [ "$#" -eq 1 ] && [ -f "$1" ] || die 'Wuyou CLI pack did not produce exactly one package archive.'
    wuyou_install_source=$1
    ;;
esac
printf 'Installing Wuyou (51job) CLI...\n'
npm install -g "$wuyou_install_source"

# --- Gateway (recruitctl) ---
gateway_source=$GATEWAY_SOURCE
case "$GATEWAY_SOURCE" in
  /*)
    [ -d "$GATEWAY_SOURCE" ] || die "Gateway source directory does not exist: $GATEWAY_SOURCE"
    gateway_build_dir=$(mktemp -d "${TMPDIR:-/tmp}/recruiting-copilot-gateway.XXXXXX")
    copy_source_tree "$GATEWAY_SOURCE" "$gateway_build_dir/source"
    printf 'Building bundled Gateway...\n'
    (
      cd "$gateway_build_dir/source"
      npm ci
      npm run build
      npm pack --pack-destination "$gateway_build_dir"
    )
    set -- "$gateway_build_dir"/*.tgz
    [ "$#" -eq 1 ] && [ -f "$1" ] || die 'Gateway build did not produce exactly one package archive.'
    gateway_source=$1
    ;;
  git+*'#'*)
    command -v git >/dev/null 2>&1 || die 'git is required to build the Gateway.'
    repository_and_ref=${GATEWAY_SOURCE#git+}
    gateway_repository=${repository_and_ref%#*}
    gateway_ref=${repository_and_ref##*#}
    [ -n "$gateway_repository" ] || die 'Gateway repository is empty.'
    [ -n "$gateway_ref" ] || die 'Gateway git ref is empty.'

    gateway_build_dir=$(mktemp -d "${TMPDIR:-/tmp}/recruiting-copilot-gateway.XXXXXX")
    printf 'Cloning Gateway (%s)...\n' "$gateway_ref"
    git clone --depth 1 --branch "$gateway_ref" "$gateway_repository" "$gateway_build_dir/source"
    printf 'Building Gateway...\n'
    (
      cd "$gateway_build_dir/source"
      npm ci
      npm run build
      npm pack --pack-destination "$gateway_build_dir"
    )
    set -- "$gateway_build_dir"/*.tgz
    [ "$#" -eq 1 ] && [ -f "$1" ] || die 'Gateway build did not produce exactly one package archive.'
    gateway_source=$1
    ;;
esac

printf 'Installing Gateway (recruitctl)...\n'
npm install -g "$gateway_source"

recruitctl_executable=$npm_bin/recruitctl
boss_executable=$npm_bin/boss
liepin_executable=$npm_bin/liepin
wuyou_executable=$npm_bin/wuyou
[ -x "$recruitctl_executable" ] || die "Gateway executable not found at $recruitctl_executable"
[ -x "$boss_executable" ] || die "Boss CLI executable not found at $boss_executable"
[ -x "$liepin_executable" ] || die "Liepin CLI executable not found at $liepin_executable"
[ -x "$wuyou_executable" ] || die "Wuyou CLI executable not found at $wuyou_executable"

"$recruitctl_executable" help >/dev/null 2>&1
"$boss_executable" help >/dev/null 2>&1
"$liepin_executable" --version >/dev/null 2>&1
"$wuyou_executable" help >/dev/null 2>&1

printf 'Gateway (recruitctl) ready: %s\n' "$recruitctl_executable"
printf 'Boss CLI ready: %s\n' "$boss_executable"
printf 'Liepin CLI ready: %s\n' "$liepin_executable"
printf 'Wuyou CLI ready: %s\n' "$wuyou_executable"
printf 'Next: run "recruitctl session.login", "liepin login" and "wuyou login" once in a new terminal.\n'
printf '       verify Gateway: "recruitctl doctor".\n'
