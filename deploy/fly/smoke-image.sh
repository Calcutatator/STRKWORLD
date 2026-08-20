#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -gt 1 ]; then
  printf 'usage: %s [image-tag]\n' "$0" >&2
  exit 64
fi

image=${1:-strkworld-fly:ci}
case "$image" in
  ''|-*|*[[:space:]]*)
    printf 'Fly smoke image tag is invalid.\n' >&2
    exit 64
    ;;
esac

run_id=${GITHUB_RUN_ID:-0}
run_attempt=${GITHUB_RUN_ATTEMPT:-0}
case "$run_id:$run_attempt" in
  *[!0-9:]*)
    printf 'Fly smoke ownership identifiers are invalid.\n' >&2
    exit 64
    ;;
esac

name="strkworld-fly-smoke-${run_id}-${run_attempt}-$$"
if [[ ! "$name" =~ ^strkworld-fly-smoke-[0-9]+-[0-9]+-[0-9]+$ ]]; then
  printf 'Fly smoke container name is invalid.\n' >&2
  exit 64
fi

owned_id=''
cleanup_owned_container() {
  [ -n "$owned_id" ] || return 0
  if [[ ! "$name" =~ ^strkworld-fly-smoke-[0-9]+-[0-9]+-[0-9]+$ ]]; then
    printf 'Refusing to clean an invalid Fly smoke target.\n' >&2
    return 1
  fi

  local matches inspected
  matches=$(docker container ls --all --no-trunc --quiet --filter "name=^/${name}$") || return 1
  if [ "$matches" != "$owned_id" ]; then
    printf 'Refusing to clean an unowned Fly smoke target.\n' >&2
    return 1
  fi
  inspected=$(docker inspect --type container --format '{{.Id}} {{.Name}}' "$owned_id") || return 1
  if [ "$inspected" != "$owned_id /$name" ]; then
    printf 'Refusing to clean a changed Fly smoke target.\n' >&2
    return 1
  fi
  docker container rm --force -- "$owned_id" >/dev/null
  owned_id=''
}
trap cleanup_owned_container EXIT

fail() {
  printf 'Fly image smoke failed: %s\n' "$1" >&2
  exit 1
}

image_user=$(docker image inspect --format '{{.Config.User}}' "$image") || fail 'image is unavailable'
[ "$image_user" = 'node' ] || fail 'image user is not node'

inert_hmac=$(printf '%032d' 0)
create_fly_container() {
  local public_origin=$1
  local built_override=${2:-}
  local command=(docker container create --name "$name" --network none
    --env PORT=8080
    --env STARKNET_RPC_URL=https://rpc.invalid/ci
    --env STRK20_POOL_ADDRESS=0x1
    --env STRK20_FEE_TOKEN=0x2
    --env STRK20_NOTE_MATURITY_BLOCKS=1
    --env AVNU_PAYMASTER_API_KEY=inert
    --env STARKNET_CHAIN_ID=SN_MAIN
    --env "FEE_AUTHORIZATION_SECRET=$inert_hmac"
    --env BACKEND_MAX_REQUEST_BYTES=1
    --env BACKEND_MAX_CALLDATA_ITEMS=1
    --env BACKEND_MAX_PROOF_BYTES=1
    --env BACKEND_REQUEST_TIMEOUT_MS=1
    --env BACKEND_GLOBAL_ENABLED=false
    --env BACKEND_RATE_LIMIT_MAX_REQUESTS=1
    --env BACKEND_RATE_LIMIT_WINDOW_MS=1
    --env BACKEND_SPONSORSHIP_MAX_FEE_AMOUNT=0
    --env BACKEND_SPONSORSHIP_WINDOW_MS=1
    --env BACKEND_QUEUE_MAX_IN_FLIGHT=1
    --env BACKEND_QUEUE_MAX_QUEUED=0
    --env BACKEND_ROUTE_TRANSFER_ENABLED=false
    --env BACKEND_ROUTE_TRANSFER_MAX_RELAY_FEE=0
    --env BACKEND_ROUTE_TRANSFER_MAX_QUEUE_DELAY_MS=1
    --env BACKEND_ROUTE_TRANSFER_ALLOWED_TOKENS=0x2
    --env BACKEND_ROUTE_UNSHIELD_ENABLED=false
    --env BACKEND_ROUTE_UNSHIELD_MAX_RELAY_FEE=0
    --env BACKEND_ROUTE_UNSHIELD_MAX_QUEUE_DELAY_MS=1
    --env BACKEND_ROUTE_UNSHIELD_ALLOWED_TOKENS=0x2
    --env BACKEND_ROUTE_SWAP_ENABLED=false
    --env BACKEND_ROUTE_SWAP_MAX_RELAY_FEE=0
    --env BACKEND_ROUTE_SWAP_MAX_QUEUE_DELAY_MS=0
    --env BACKEND_ROUTE_SWAP_ALLOWED_TOKENS=0x2
    --env BACKEND_ROUTE_SWAP_MAX_SLIPPAGE_BPS=1
    --env "FLY_PUBLIC_ORIGIN=$public_origin"
    --env "LOBBY_ALLOWED_ORIGINS=$public_origin")
  if [ -n "$built_override" ]; then
    command+=(--env "FLY_BUILT_LOBBY_URL=$built_override")
  fi
  command+=("$image")
  "${command[@]}"
}

validate_owned_id() {
  [[ "$owned_id" =~ ^[0-9a-f]{64}$ ]] || fail 'Docker returned an invalid container identity'
}

owned_id=$(create_fly_container https://ci.example.com) || fail 'container creation failed'

validate_owned_id
docker container start "$owned_id" >/dev/null || fail 'container start failed'

probe_fly() {
  docker exec "$owned_id" node -e "void (async () => {
    const signal = AbortSignal.timeout(1_000);
    const statuses = await Promise.all(['/', '/health', '/metrics'].map(async (path) =>
      (await fetch('http://127.0.0.1:8080' + path, { signal })).status
    ));
    if (JSON.stringify(statuses) !== JSON.stringify([200, 404, 404])) process.exit(1);
  })().catch(() => process.exit(1));" >/dev/null 2>&1
}

readiness_deadline=$((SECONDS + 20))
until probe_fly; do
  running=$(docker inspect --type container --format '{{.State.Running}}' "$owned_id") || fail 'container disappeared'
  [ "$running" = 'true' ] || fail 'container exited before readiness'
  [ "$SECONDS" -lt "$readiness_deadline" ] || fail 'container readiness exceeded 20 seconds'
  sleep 0.25
done

effective_uid=$(docker exec "$owned_id" awk '/^Uid:/{print $3}' /proc/1/status) || fail 'could not inspect PID 1'
[ "$effective_uid" = '1000' ] || fail 'PID 1 is not the node user'
metadata_mode=$(docker exec "$owned_id" stat -c '%u:%g:%a' /app/build-metadata/lobby-url) || fail 'could not inspect build-owned metadata'
[ "$metadata_mode" = '0:0:644' ] || fail 'build-owned metadata is writable by the runtime user'

stop_started=$(date +%s)
docker container stop --time 10 "$owned_id" >/dev/null || fail 'container did not stop'
stop_finished=$(date +%s)
if [ "$stop_finished" -lt "$stop_started" ] || [ $((stop_finished - stop_started)) -gt 12 ]; then
  fail 'container stop exceeded the bounded grace period'
fi
exit_code=$(docker inspect --type container --format '{{.State.ExitCode}}' "$owned_id") || fail 'could not inspect stopped container'
[ "$exit_code" -eq 0 ] || fail 'container did not complete graceful shutdown'

# The image was built for wss://ci.example.com. A runtime environment value
# must not be able to relabel that browser artifact as another origin.
cleanup_owned_container
owned_id=$(create_fly_container \
  https://mismatch.example.com \
  wss://mismatch.example.com) || fail 'adversarial container creation failed'
validate_owned_id
docker container start "$owned_id" >/dev/null || fail 'adversarial container start failed'

override_deadline=$((SECONDS + 5))
while :; do
  running=$(docker inspect --type container --format '{{.State.Running}}' "$owned_id") || fail 'adversarial container disappeared'
  [ "$running" = 'false' ] && break
  [ "$running" = 'true' ] || fail 'Docker returned an invalid adversarial running state'
  [ "$SECONDS" -lt "$override_deadline" ] || fail 'runtime lobby override replaced build-owned metadata'
  sleep 0.25
done
exit_code=$(docker inspect --type container --format '{{.State.ExitCode}}' "$owned_id") || fail 'could not inspect adversarial exit'
[ "$exit_code" -ne 0 ] || fail 'mismatched baked lobby origin did not fail startup'
cleanup_owned_container

printf 'Fly image smoke passed.\n'
