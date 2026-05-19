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

from moshi.server import ServerState, main  # noqa: E402

_original_handle_chat = ServerState.handle_chat


async def _patched_handle_chat(self, request):
    request._state.setdefault("seed", request.query.get("seed"))
    return await _original_handle_chat(self, request)


ServerState.handle_chat = _patched_handle_chat

if __name__ == "__main__":
    main()
