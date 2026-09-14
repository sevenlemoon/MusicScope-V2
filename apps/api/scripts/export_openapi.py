import argparse
import json
from pathlib import Path

from app.main import app


def rendered_schema() -> str:
    return json.dumps(app.openapi(), indent=2, sort_keys=True) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Export the authoritative FastAPI OpenAPI schema.")
    parser.add_argument("output", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    generated = rendered_schema()

    if args.check:
        if not args.output.exists() or args.output.read_text() != generated:
            print(f"API contract is stale: regenerate {args.output}")
            return 1
        return 0

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(generated)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
