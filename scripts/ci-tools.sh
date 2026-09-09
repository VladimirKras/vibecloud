#!/usr/bin/env bash
# Linux CI has no OrbStack requirement: these tools validate generated artifacts;
# pnpm dev itself is covered separately on the OrbStack workstation.
set -euo pipefail
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl unzip python3 gnupg
install -m 0755 -d /etc/apt/keyrings
curl --fail --silent --show-error --location https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable\n' "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin
ci_tools_temp="$(mktemp -d)"
trap 'rm -rf "$ci_tools_temp"' EXIT
ci_arch="$(dpkg --print-architecture)"
ci_terraform_version=1.15.8
ci_terraform_archive="terraform_${ci_terraform_version}_linux_${ci_arch}.zip"
curl --fail --silent --show-error --location "https://releases.hashicorp.com/terraform/${ci_terraform_version}/${ci_terraform_archive}" -o "$ci_tools_temp/$ci_terraform_archive"
curl --fail --silent --show-error --location "https://releases.hashicorp.com/terraform/${ci_terraform_version}/terraform_${ci_terraform_version}_SHA256SUMS" -o "$ci_tools_temp/SHA256SUMS"
(cd "$ci_tools_temp" && sha256sum --check --ignore-missing SHA256SUMS)
unzip -q "$ci_tools_temp/$ci_terraform_archive" terraform -d /usr/local/bin
ci_go_version=go1.27.0
ci_go_archive="${ci_go_version}.linux-${ci_arch}.tar.gz"
curl --fail --silent --show-error --location "https://go.dev/dl/$ci_go_archive" -o "$ci_tools_temp/$ci_go_archive"
curl --fail --silent --show-error --location 'https://go.dev/dl/?mode=json&include=all' -o "$ci_tools_temp/go-releases.json"
python3 - "$ci_tools_temp" "$ci_go_version" "$ci_go_archive" <<'PY'
import hashlib, json, pathlib, sys
root, version, filename = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
release = next(item for item in json.loads((root / 'go-releases.json').read_text()) if item['version'] == version)
expected = next(item['sha256'] for item in release['files'] if item['filename'] == filename)
assert hashlib.sha256((root / filename).read_bytes()).hexdigest() == expected
PY
tar -C /usr/local -xzf "$ci_tools_temp/$ci_go_archive"
ln -s /usr/local/go/bin/go /usr/local/bin/go
terraform version
docker compose version
go version
python3 --version
