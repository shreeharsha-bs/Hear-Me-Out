import sys
import torch

_original_torch_load = torch.load


def _patched_torch_load(*args, **kwargs):
    if "map_location" not in kwargs and len(args) < 2:
        kwargs["map_location"] = (
            torch.device("cpu") if not torch.cuda.is_available() else None
        )
    return _original_torch_load(*args, **kwargs)


torch.load = _patched_torch_load

from aiohttp import web  # noqa: E402

_original_getitem = web.BaseRequest.__getitem__


def _patched_getitem(self, key):
    try:
        return _original_getitem(self, key)
    except KeyError:
        val = self.query.get(key)
        if val is not None:
            return val
        raise


web.BaseRequest.__getitem__ = _patched_getitem

print(
    "[personaplex_entrypoint] Applied patches: torch.load map_location, aiohttp request fallback",
    flush=True,
)

from moshi.server import main  # noqa: E402

if __name__ == "__main__":
    main()
