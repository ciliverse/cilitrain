"""Generate text from a registered nanogpt checkpoint.

Rebuilds MiniGPT from the config saved by train.py, loads model.pt from
$CILITRAIN_MODEL_DIR, and continues the prompt in $CILITRAIN_INFER_INPUT.
A CSV batch comes as JSON lines in the file named by $CILITRAIN_INFER_BATCH.
Writes prediction.json (and predictions.csv for a batch) under $CILITRAIN_OUTPUT.

Importing this module only loads the model; serve.py calls predict() per request.
"""

from __future__ import annotations

import csv
import json
import os
from pathlib import Path

import torch
import torch.nn as nn
from torch.nn import functional as F

MODEL_DIR = Path(os.environ.get("CILITRAIN_MODEL_DIR", "/model"))
OUT = Path(os.environ.get("CILITRAIN_OUTPUT", "/output"))

ckpt = torch.load(MODEL_DIR / "model.pt", map_location="cpu")
cfg = ckpt["config"]
chars = ckpt["chars"]
N_LAYER, N_HEAD, N_EMBD, BLOCK = cfg["n_layer"], cfg["n_head"], cfg["n_embd"], cfg["block"]
stoi = {ch: i for i, ch in enumerate(chars)}
itos = {i: ch for ch, i in stoi.items()}
vocab = len(chars)


class Head(nn.Module):
    def __init__(self, head_size: int) -> None:
        super().__init__()
        self.key = nn.Linear(N_EMBD, head_size, bias=False)
        self.query = nn.Linear(N_EMBD, head_size, bias=False)
        self.value = nn.Linear(N_EMBD, head_size, bias=False)
        self.register_buffer("tril", torch.tril(torch.ones(BLOCK, BLOCK)))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        _, t, _ = x.shape
        k, q, v = self.key(x), self.query(x), self.value(x)
        wei = q @ k.transpose(-2, -1) * (k.shape[-1] ** -0.5)
        wei = wei.masked_fill(self.tril[:t, :t] == 0, float("-inf"))
        return F.softmax(wei, dim=-1) @ v


class MiniGPT(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        head = N_EMBD // N_HEAD
        self.tok = nn.Embedding(vocab, N_EMBD)
        self.pos = nn.Embedding(BLOCK, N_EMBD)
        self.blocks = nn.ModuleList(
            [
                nn.ModuleDict(
                    {
                        "ln1": nn.LayerNorm(N_EMBD),
                        "heads": nn.ModuleList([Head(head) for _ in range(N_HEAD)]),
                        "proj": nn.Linear(N_EMBD, N_EMBD),
                        "ln2": nn.LayerNorm(N_EMBD),
                        "ff": nn.Sequential(
                            nn.Linear(N_EMBD, 4 * N_EMBD),
                            nn.GELU(),
                            nn.Linear(4 * N_EMBD, N_EMBD),
                        ),
                    }
                )
                for _ in range(N_LAYER)
            ]
        )
        self.ln_f = nn.LayerNorm(N_EMBD)
        self.head = nn.Linear(N_EMBD, vocab)

    def forward(self, idx: torch.Tensor) -> torch.Tensor:
        _, t = idx.shape
        x = self.tok(idx) + self.pos(torch.arange(t))
        for blk in self.blocks:
            h = torch.cat([hd(blk["ln1"](x)) for hd in blk["heads"]], dim=-1)
            x = x + blk["proj"](h)
            x = x + blk["ff"](blk["ln2"](x))
        return self.head(self.ln_f(x))


model = MiniGPT()
model.load_state_dict(ckpt["state_dict"])
model.eval()


def generate(prompt: str, max_new: int, temperature: float) -> dict:
    known = "".join(c for c in prompt if c in stoi)
    dropped = len(prompt) - len(known)
    if dropped:
        print(f"[cilitrain] dropped {dropped} prompt characters outside the model vocabulary", flush=True)
    ids = [stoi[c] for c in known] or [0]
    idx = torch.tensor([ids], dtype=torch.long)
    print(f"[cilitrain] generating {max_new} tokens at temperature {temperature}", flush=True)
    torch.manual_seed(0)
    with torch.no_grad():
        for _ in range(max_new):
            logits = model(idx[:, -BLOCK:])[:, -1, :] / temperature
            idx = torch.cat([idx, torch.multinomial(F.softmax(logits, dim=-1), 1)], dim=1)
    new = "".join(itos[int(i)] for i in idx[0, len(ids):].tolist())
    pred = {"type": "text", "text": known + new, "prompt": prompt, "new_tokens": len(new)}
    if dropped:
        pred["dropped_chars"] = dropped
    return pred


def predict(inp: dict) -> dict:
    return generate(
        str(inp.get("prompt", "")),
        int(inp.get("max_new_tokens", 200)),
        float(inp.get("temperature", 0.8)),
    )


def run_batch(batch: str) -> None:
    items = [json.loads(line) for line in Path(batch).read_text(encoding="utf-8").splitlines() if line.strip()]
    print(f"[cilitrain] batch of {len(items)} rows", flush=True)
    keys = ("prompt", "max_new_tokens", "temperature")
    extras = list(items[0]["extra"]) if items else []
    sample = []
    with (OUT / "predictions.csv").open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow([*extras, *keys, "generated"])
        for it in items:
            row = it["input"]
            p = predict(row)
            gen = p["text"][len(p["text"]) - p["new_tokens"]:]
            w.writerow([*(it["extra"].get(k, "") for k in extras), *(row[k] for k in keys), gen])
            if len(sample) < 5:
                sample.append({"input": row, "generated": gen[:160]})
    summary = {"type": "batch", "output": "text", "rows": len(items), "file": "predictions.csv", "sample": sample}
    (OUT / "prediction.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    print("[cilitrain] wrote", OUT / "predictions.csv", flush=True)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    batch = os.environ.get("CILITRAIN_INFER_BATCH")
    if batch:
        run_batch(batch)
    else:
        pred = predict(json.loads(os.environ.get("CILITRAIN_INFER_INPUT", "{}")))
        (OUT / "prediction.json").write_text(json.dumps(pred, indent=2, ensure_ascii=False), encoding="utf-8")
    print("[cilitrain] wrote", OUT / "prediction.json", flush=True)


if __name__ == "__main__":
    main()
