#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -gt 1 ]; then
  printf 'usage: %s [image-tag]\n' "$0" >&2
  exit 64
fi

image=${1:-strkworld-backend:ci}
case "$image" in
  ''|-*|*[[:space:]]*)
    printf 'Backend smoke image tag is invalid.\n' >&2
    exit 64
    ;;
esac

run_id=${GITHUB_RUN_ID:-0}
run_attempt=${GITHUB_RUN_ATTEMPT:-0}
case "$run_id:$run_attempt" in
  *[!0-9:]*)
    printf 'Backend smoke ownership identifiers are invalid.\n' >&2
    exit 64
    ;;
esac

name="strkworld-backend-smoke-${run_id}-${run_attempt}-$$"
if [[ ! "$name" =~ ^strkworld-backend-smoke-[0-9]+-[0-9]+-[0-9]+$ ]]; then
  printf 'Backend smoke container name is invalid.\n' >&2
  exit 64
fi

owned_id=''
cleanup_owned_container() {
  [ -n "$owned_id" ] || return 0
  if [[ ! "$name" =~ ^strkworld-backend-smoke-[0-9]+-[0-9]+-[0-9]+$ ]]; then
    printf 'Refusing to clean an invalid Backend smoke target.\n' >&2
    return 1
  fi

  local matches inspected
  matches=$(docker container ls --all --no-trunc --quiet --filter "name=^/${name}$") || return 1
  if [ "$matches" != "$owned_id" ]; then
    printf 'Refusing to clean an unowned Backend smoke target.\n' >&2
    return 1
  fi
  inspected=$(docker inspect --type container --format '{{.Id}} {{.Name}}' "$owned_id") || return 1
  if [ "$inspected" != "$owned_id /$name" ]; then
    printf 'Refusing to clean a changed Backend smoke target.\n' >&2
    return 1
  fi
  docker container rm --force -- "$owned_id" >/dev/null
}
trap cleanup_owned_container EXIT

fail() {
  printf 'Backend image smoke failed: %s\n' "$1" >&2
  exit 1
}

image_user=$(docker image inspect --format '{{.Config.User}}' "$image") || fail 'image is unavailable'
[ "$image_user" = 'node' ] || fail 'image user is not node'

inert_hmac=$(printf '%032d' 0)
owned_id=$(docker container create --name "$name" --network none \
  --env PORT=8080 \
  --env STARKNET_RPC_URL=https://rpc.invalid/ci \
  --env STRK20_POOL_ADDRESS=0x1 \
  --env STRK20_FEE_TOKEN=0x2 \
  --env STRK20_NOTE_MATURITY_BLOCKS=1 \
  --env AVNU_PAYMASTER_API_KEY=inert \
  --env STARKNET_CHAIN_ID=SN_MAIN \
  --env "FEE_AUTHORIZATION_SECRET=$inert_hmac" \
  --env BACKEND_MAX_REQUEST_BYTES=1 \
  --env BACKEND_MAX_CALLDATA_ITEMS=1 \
  --env BACKEND_MAX_PROOF_BYTES=1 \
  --env BACKEND_REQUEST_TIMEOUT_MS=1 \
  --env BACKEND_GLOBAL_ENABLED=false \
  --env BACKEND_RATE_LIMIT_MAX_REQUESTS=1 \
  --env BACKEND_RATE_LIMIT_WINDOW_MS=1 \
  --env BACKEND_SPONSORSHIP_MAX_FEE_AMOUNT=0 \
  --env BACKEND_SPONSORSHIP_WINDOW_MS=1 \
  --env BACKEND_QUEUE_MAX_IN_FLIGHT=1 \
  --env BACKEND_QUEUE_MAX_QUEUED=0 \
  --env BACKEND_ROUTE_TRANSFER_ENABLED=false \
  --env BACKEND_ROUTE_TRANSFER_MAX_RELAY_FEE=0 \
  --env BACKEND_ROUTE_TRANSFER_MAX_QUEUE_DELAY_MS=1 \
  --env BACKEND_ROUTE_TRANSFER_ALLOWED_TOKENS=0x2 \
  --env BACKEND_ROUTE_UNSHIELD_ENABLED=false \
  --env BACKEND_ROUTE_UNSHIELD_MAX_RELAY_FEE=0 \
  --env BACKEND_ROUTE_UNSHIELD_MAX_QUEUE_DELAY_MS=1 \
  --env BACKEND_ROUTE_UNSHIELD_ALLOWED_TOKENS=0x2 \
  --env BACKEND_ROUTE_SWAP_ENABLED=false \
  --env BACKEND_ROUTE_SWAP_MAX_RELAY_FEE=0 \
  --env BACKEND_ROUTE_SWAP_MAX_QUEUE_DELAY_MS=0 \
  --env BACKEND_ROUTE_SWAP_ALLOWED_TOKENS=0x2 \
  --env BACKEND_ROUTE_SWAP_MAX_SLIPPAGE_BPS=1 \
  "$image") || fail 'container creation failed'

if [[ ! "$owned_id" =~ ^[0-9a-f]{64}$ ]]; then
  fail 'Docker returned an invalid container identity'
fi
docker container start "$owned_id" >/dev/null || fail 'container start failed'

probe_backend() {
  docker exec "$owned_id" node -e "const net=require('node:net');
    const socket=net.connect(Number(process.env.PORT), '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); process.exit(0); });
    socket.once('error', () => process.exit(1));
    socket.setTimeout(500, () => { socket.destroy(); process.exit(1); });" >/dev/null 2>&1
}

readiness_deadline=$((SECONDS + 20))
until probe_backend; do
  running=$(docker inspect --type container --format '{{.State.Running}}' "$owned_id") || fail 'container disappeared'
  [ "$running" = 'true' ] || fail 'container exited before readiness'
  [ "$SECONDS" -lt "$readiness_deadline" ] || fail 'container readiness exceeded 20 seconds'
  sleep 0.25
done

effective_uid=$(docker exec "$owned_id" awk '/^Uid:/{print $3}' /proc/1/status) || fail 'could not inspect PID 1'
[ "$effective_uid" = '1000' ] || fail 'PID 1 is not the node user'

stop_started=$(date +%s)
docker container stop --time 3 "$owned_id" >/dev/null || fail 'container did not stop'
stop_finished=$(date +%s)
if [ "$stop_finished" -lt "$stop_started" ] || [ $((stop_finished - stop_started)) -gt 5 ]; then
  fail 'container stop exceeded the bounded grace period'
fi
exit_code=$(docker inspect --type container --format '{{.State.ExitCode}}' "$owned_id") || fail 'could not inspect stopped container'
case "$exit_code" in
  0)
    ;;
  [1-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5])
    fail "container exited with aggregate code $exit_code"
    ;;
  *)
    fail 'Docker returned an invalid aggregate exit code'
    ;;
esac

printf 'Backend image smoke passed.\n'
