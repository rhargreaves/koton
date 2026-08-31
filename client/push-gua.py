#!/usr/bin/env python3
"""Push this host's active Global Unicast Addresses (GUAs) to Cloudflare KV.

Discovers active, non-deprecated public IPv6 addresses on this host and
uploads them with a UTC timestamp to Cloudflare Workers KV under `targets/<hostname>`.
"""

import datetime
import ipaddress
import json
import os
import socket
import subprocess
import urllib.request


def get_active_guas():
    # Discover non-deprecated global IPv6 addresses on local interfaces
    out = subprocess.run(
        ["ip", "-6", "-o", "addr", "show", "scope", "global", "-deprecated"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    addrs = []
    seen = set()
    for line in out.splitlines():
        for token in line.split():
            addr = token.split("/")[0]
            try:
                parsed = ipaddress.IPv6Address(addr)
            except ValueError:
                continue
            if parsed.is_global and addr not in seen:
                addrs.append(addr)
                seen.add(addr)
    return addrs


def kv_key():
    return f"targets/{socket.gethostname()}"


def push(addrs):
    token = os.environ["CF_API_TOKEN"]
    account = os.environ["CF_ACCOUNT_ID"]
    namespace = os.environ["CF_KV_NAMESPACE_ID"]
    url = (
        f"https://api.cloudflare.com/client/v4/accounts/{account}/"
        f"storage/kv/namespaces/{namespace}/values/{kv_key()}"
    )
    pushed_at = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    payload = {
        "addresses": addrs,
        "pushed_at": pushed_at,
    }
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        method="PUT",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        body = json.loads(response.read())
        if not body.get("success"):
            raise SystemExit(f"KV write failed: {body}")
    print(f"pushed {len(addrs)} addresses to KV key {kv_key()} at {pushed_at}")


if __name__ == "__main__":
    push(get_active_guas())
