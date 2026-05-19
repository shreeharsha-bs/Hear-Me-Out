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

print("[personaplex_entrypoint] Applied patch: torch.load map_location", flush=True)

from moshi.server import main  # noqa: E402

if __name__ == "__main__":
    main()
