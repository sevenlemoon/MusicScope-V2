"""Control probe for isolated acceptance: no HTTP, credentials or user data."""
import argparse
import socket

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--expect-blocked", action="store_true")
args = parser.parse_args()
try:
    with socket.create_connection(("dl.fbaipublicfiles.com", 443), timeout=5):
        reachable = True
except OSError:
    reachable = False
print("Outbound control reachable" if reachable else "Outbound control blocked/unreachable")
raise SystemExit(0 if reachable != args.expect_blocked else 1)
