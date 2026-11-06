#!/bin/sh
# Starts the image the way the docs say to and checks that a fresh server is
# ready for setup: healthy, serving the web app and API, printing its setup
# code, and keeping its state as PUID. usage: docker/smoke-test.sh <image>
set -eu
image=$1
name=citadel-smoke-$$
port=${SMOKE_PORT:-18081}
cleanup() {
	status=$?
	if [ "$status" != 0 ]; then docker logs "$name" 2>&1 | tail -40 || true; fi
	docker rm -f "$name" >/dev/null 2>&1 || true
	docker volume rm "$name" >/dev/null 2>&1 || true
	exit "$status"
}
trap cleanup EXIT
fail() { echo "smoke test: $*" >&2; exit 1; }

docker run -d --name "$name" -p "127.0.0.1:$port:8081" -v "$name:/var/lib/citadel" \
	-e CITADEL_UPDATE_CHECK=false "$image" >/dev/null

health=starting
for _ in $(seq 1 60); do
	health=$(docker inspect --format '{{.State.Health.Status}}' "$name")
	[ "$health" = healthy ] && break
	[ "$(docker inspect --format '{{.State.Running}}' "$name")" = true ] || fail "the container stopped"
	sleep 1
done
[ "$health" = healthy ] || fail "not healthy after 60s ($health)"
echo "healthy"

version=$(curl -fsS "http://127.0.0.1:$port/api/version")
echo "version: $version"
curl -fsS -H 'accept: text/html' "http://127.0.0.1:$port/books/1" | grep -q '<div id="root">' \
	|| fail "the web app isn't served"
echo "web app served"
docker logs "$name" 2>&1 | grep -q '"setup_code":"' || fail "no setup code in the log"
echo "setup code printed"

owner=$(docker exec "$name" stat -c %u:%g /var/lib/citadel/citadel.db)
[ "$owner" = 1000:1000 ] || fail "citadel.db belongs to $owner, not PUID:PGID 1000:1000"
docker exec "$name" sh -c 'echo "a long password" | citadel-server users add smoke --password-stdin --admin' >/dev/null
owner=$(docker exec "$name" stat -c %u:%g /var/lib/citadel/citadel.db)
[ "$owner" = 1000:1000 ] || fail "docker exec left citadel.db owned by $owner"
docker exec "$name" citadel-server users list | grep -q smoke || fail "the CLI didn't see the new user"
echo "CLI works through docker exec as PUID"
