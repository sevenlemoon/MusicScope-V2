from collections.abc import Iterable, Iterator, Sequence
from typing import TypeVar

T = TypeVar("T")


def unique_in_order(values: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(value for value in values if value))


def batched(values: Sequence[T], size: int) -> Iterator[Sequence[T]]:
    if size < 1:
        raise ValueError("Batch size must be positive")
    for start in range(0, len(values), size):
        yield values[start : start + size]

