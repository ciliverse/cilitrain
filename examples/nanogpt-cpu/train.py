"""Tiny character-level GPT (nanoGPT-style) for CiliTrain CPU jobs.

Writes metrics.json + model.pt + sample.txt under $CILITRAIN_OUTPUT.
Hyperparameters come from CILITRAIN_EPOCHS / CILITRAIN_STEPS_PER_EPOCH /
CILITRAIN_LEARNING_RATE / CILITRAIN_BATCH_SIZE. When CILITRAIN_RESUME_DIR holds
a model.pt from an earlier run, training continues from it for EPOCHS more epochs.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

import torch
import torch.nn as nn
from torch.nn import functional as F

OUT = Path(os.environ.get("CILITRAIN_OUTPUT", "/output"))
OUT.mkdir(parents=True, exist_ok=True)
EPOCHS = int(os.environ.get("CILITRAIN_EPOCHS", "8"))
STEPS = int(os.environ.get("CILITRAIN_STEPS_PER_EPOCH", "40"))
LR = float(os.environ.get("CILITRAIN_LEARNING_RATE", "3e-4"))
BATCH = int(os.environ.get("CILITRAIN_BATCH_SIZE", "16"))
N_LAYER, N_HEAD, N_EMBD, BLOCK = 4, 4, 128, 64
RESUME = Path(os.environ.get("CILITRAIN_RESUME_DIR", "/nonexistent")) / "model.pt"

# Public-domain Hamlet excerpt, repeated so the tiny model has enough tokens.
TEXT = (
    "To be, or not to be, that is the question: "
    "Whether 'tis nobler in the mind to suffer "
    "The slings and arrows of outrageous fortune, "
    "Or to take arms against a sea of troubles, "
    "And by opposing end them. To die—to sleep, "
    "No more; and by a sleep to say we end "
    "The heart-ache and the thousand natural shocks "
    "That flesh is heir to: 'tis a consummation "
    "Devoutly to be wish'd. To die, to sleep; "
    "To sleep, perchance to dream—ay, there's the rub: "
    "For in that sleep of death what dreams may come, "
    "When we have shuffled off this mortal coil, "
    "Must give us pause. There's the respect "
    "That makes calamity of so long life.\n"
) * 40

chars = sorted(set(TEXT))
stoi = {ch: i for i, ch in enumerate(chars)}
itos = {i: ch for ch, i in stoi.items()}
vocab = len(chars)
data = torch.tensor([stoi[c] for c in TEXT], dtype=torch.long)
n = max(BLOCK * 4, int(0.9 * len(data)))
train_data, val_data = data[:n], data[n:]
if len(val_data) <= BLOCK:
    val_data = train_data


def get_batch(split: str) -> tuple[torch.Tensor, torch.Tensor]:
    src = train_data if split == "train" else val_data
    ix = torch.randint(len(src) - BLOCK, (BATCH,))
    x = torch.stack([src[i : i + BLOCK] for i in ix])
    y = torch.stack([src[i + 1 : i + BLOCK + 1] for i in ix])
    return x, y


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
        wei = F.softmax(wei, dim=-1)
        return wei @ v


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

    def forward(self, idx: torch.Tensor, targets: torch.Tensor | None = None):
        _, t = idx.shape
        x = self.tok(idx) + self.pos(torch.arange(t))
        for blk in self.blocks:
            h = torch.cat([hd(blk["ln1"](x)) for hd in blk["heads"]], dim=-1)
            x = x + blk["proj"](h)
            x = x + blk["ff"](blk["ln2"](x))
        logits = self.head(self.ln_f(x))
        loss = None
        if targets is not None:
            loss = F.cross_entropy(logits.view(-1, vocab), targets.view(-1))
        return logits, loss

    @torch.no_grad()
    def generate(self, idx: torch.Tensor, steps: int) -> torch.Tensor:
        for _ in range(steps):
            logits, _ = self(idx[:, -BLOCK:])
            probs = F.softmax(logits[:, -1, :], dim=-1)
            idx = torch.cat([idx, torch.multinomial(probs, 1)], dim=1)
        return idx


torch.manual_seed(42)
model = MiniGPT()
params = sum(p.numel() for p in model.parameters())
print(f"[cilitrain] nanogpt params: {params} vocab: {vocab} device: cpu", flush=True)
opt = torch.optim.AdamW(model.parameters(), lr=LR)

history: list[dict] = []
start = 0
if RESUME.exists():
    ckpt = torch.load(RESUME, map_location="cpu")
    if ckpt.get("chars") != chars:
        raise SystemExit("[cilitrain] checkpoint vocabulary does not match this dataset")
    model.load_state_dict(ckpt["state_dict"])
    if ckpt.get("optimizer"):
        opt.load_state_dict(ckpt["optimizer"])
        for group in opt.param_groups:
            group["lr"] = LR
    history = list(ckpt.get("history") or [])
    start = int(ckpt.get("epoch") or len(history))
    print(f"[cilitrain] resumed from checkpoint at epoch {start}", flush=True)
print(f"[cilitrain] plan: {EPOCHS} epochs x {STEPS} steps, lr {LR}, batch {BATCH}", flush=True)

t0 = time.time()
for epoch in range(start + 1, start + EPOCHS + 1):
    model.train()
    losses = []
    for step in range(1, STEPS + 1):
        x, y = get_batch("train")
        _, loss = model(x, y)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
        losses.append(float(loss.item()))
        if step % 10 == 0:
            print(
                f"[cilitrain] epoch {epoch}/{start + EPOCHS} step {step}/{STEPS} "
                f"loss {losses[-1]:.4f}",
                flush=True,
            )
    model.eval()
    with torch.no_grad():
        vx, vy = get_batch("val")
        _, vloss = model(vx, vy)
    tr = sum(losses) / len(losses)
    vl = float(vloss.item())
    print(f"metrics epoch={epoch} loss={tr:.4f} val_loss={vl:.4f}", flush=True)
    history.append({"epoch": epoch, "loss": tr, "val_loss": vl})

ctx = torch.zeros((1, 1), dtype=torch.long)
sample = "".join(itos[int(i)] for i in model.generate(ctx, 200)[0].tolist())
(OUT / "sample.txt").write_text(sample, encoding="utf-8")
torch.save({
    "state_dict": model.state_dict(),
    "optimizer": opt.state_dict(),
    "epoch": start + EPOCHS,
    "history": history,
    "chars": chars,
    "config": {"n_layer": N_LAYER, "n_head": N_HEAD, "n_embd": N_EMBD, "block": BLOCK},
}, OUT / "model.pt")
payload = {
    "params": params,
    "vocab": vocab,
    "epochs": start + EPOCHS,
    "learning_rate": LR,
    "batch_size": BATCH,
    "loss": history[-1]["loss"],
    "val_loss": history[-1]["val_loss"],
    "duration_seconds": round(time.time() - t0, 2),
    "history": history,
    "arch": "nanogpt-char",
}
(OUT / "metrics.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
print(f"score {history[-1]['loss']:.4f}", flush=True)
print("[cilitrain] wrote", OUT / "metrics.json", flush=True)
