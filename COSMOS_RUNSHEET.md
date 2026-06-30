# Cosmos3-Nano Reasoner — Complete Run Sheet

> Share this document with anyone who needs to set up or run the Cosmos3-Nano visual AI model.

---

## Hardware Requirements

| Component   | Minimum Required                          |
|-------------|-------------------------------------------|
| GPU         | 1× NVIDIA GPU with 20 GB VRAM **or** 2× GPUs totaling 30+ GB |
| GPU Driver  | NVIDIA Driver 525+ with CUDA 11.8+        |
| RAM         | 32 GB minimum                             |
| Disk        | 50 GB free (30 GB model + 20 GB runtime)  |
| OS          | Ubuntu 20.04 / 22.04                      |
| Python      | 3.11 – 3.13                               |
| Node.js     | 18+                                       |

> **This server:** RTX A4000 (16 GB) + RTX A4500 (20 GB), CUDA 13.0, 101 GB RAM

---

## Prerequisites (One-Time)

### 1. Install uv (Python package manager)
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
source ~/.bashrc   # or restart terminal
```

### 2. Install Node.js (if not installed)
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 3. Install system dependencies
```bash
sudo apt-get install -y git curl wget
```

---

## First-Time Setup

### Step 1 — Create Python environment
```bash
uv venv ~/cosmos-reasoner --python 3.13
source ~/cosmos-reasoner/bin/activate
```

### Step 2 — Install vLLM and Cosmos plugin
```bash
uv pip install vllm==0.21.0 vllm-cosmos3==0.1.0
```
> Takes 5–10 minutes. Do not change versions — other versions are untested.

### Step 3 — Get HuggingFace access
1. Create account at [huggingface.co](https://huggingface.co)
2. Request model access at [huggingface.co/nvidia/Cosmos3-Nano](https://huggingface.co/nvidia/Cosmos3-Nano)
3. Wait for approval email from NVIDIA (usually within minutes)
4. Generate an access token at [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens)

### Step 4 — Download the model (~30 GB)
```bash
hf download nvidia/Cosmos3-Nano --token YOUR_HF_TOKEN_HERE
```
> Takes 10–30 minutes depending on internet speed. Download only happens once.

### Step 5 — Set up the Node.js UI
```bash
# Clone or copy the cosmos-ui folder to the server, then:

cd cosmos-ui
npm install

cd cosmos-ui/client
npm install
npm run build
```

---

## Starting the Model (Every Time)

### Step 1 — Check GPU memory is free
```bash
nvidia-smi
```
All GPUs should show minimal usage (< 500 MiB). If old vLLM processes are running, kill them first (see **Killing the Model** below).

### Step 2 — Activate the environment
```bash
source ~/cosmos-reasoner/bin/activate
```

### Step 3 — Start vLLM server
```bash
CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES=0,1 \
HF_HUB_OFFLINE=1 \
VLLM_USE_FLASHINFER_SAMPLER=0 \
VLLM_MEMORY_PROFILER_ESTIMATE_CUDAGRAPHS=0 \
vllm serve nvidia/Cosmos3-Nano \
  --hf-overrides '{"architectures": ["Cosmos3ReasonerForConditionalGeneration"]}' \
  --tensor-parallel-size 2 \
  --mm-encoder-tp-mode data \
  --async-scheduling \
  --allowed-local-media-path / \
  --media-io-kwargs '{"video": {"num_frames": -1}}' \
  --gpu-memory-utilization 0.92 \
  --max-model-len 8192 \
  --port 8001
```

**The server is ready when you see:**
```
INFO:     Application startup complete.
INFO:     Uvicorn running on http://0.0.0.0:8001
```
> Startup takes **2–3 minutes** (model loading + torch.compile). This is normal.

### Step 4 — Start the UI (separate terminal)
```bash
cd cosmos-ui
node server.js
# UI available at http://YOUR_SERVER_IP:3000
```

---

## Testing the Model

### Quick curl test
```bash
curl http://localhost:8001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nvidia/Cosmos3-Nano",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "image_url", "image_url": {"url": "https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/280px-PNG_transparency_demonstration_1.png"}},
        {"type": "text", "text": "Describe this image."}
      ]
    }],
    "max_tokens": 256
  }'
```

**Expected response:**
```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": "The image shows ..."
    }
  }]
}
```

### Check health endpoint
```bash
curl http://localhost:8001/health
# Should return: OK
```

---

## Killing the Model

### Clean stop (preferred)
Press `Ctrl+C` in the terminal running vLLM and wait a few seconds.

### Force kill by name
```bash
pkill -9 -f "vllm"
```

### Kill by specific PID (find from nvidia-smi)
```bash
nvidia-smi                  # note the PIDs under "Processes"
kill -9 <PID1> <PID2>       # replace with actual PIDs
```

### Nuclear — free all GPU memory
```bash
sudo fuser -k /dev/nvidia*
```

### Verify GPUs are released
```bash
nvidia-smi
# Should show < 500 MiB on all GPUs
```

---

## Troubleshooting

| Error | Fix |
|-------|-----|
| `Free memory ... less than desired GPU memory utilization` | Old vLLM process still running — kill it first with `pkill -9 -f vllm` |
| `nvcc: not found` | Add `VLLM_USE_FLASHINFER_SAMPLER=0` to the start command (already included above) |
| `No available memory for cache blocks` | Add `VLLM_MEMORY_PROFILER_ESTIMATE_CUDAGRAPHS=0` (already included above) |
| `429 Too Many Requests` from HuggingFace | Use `HF_HUB_OFFLINE=1` (already included) — model must be downloaded first |
| `CUDA out of memory` during profiling | Lower `--gpu-memory-utilization` to `0.88` or free up GPU memory |
| Port 8001 already in use | Change `--port 8001` to `--port 8002` and update `VLLM_URL` in `server.js` |
| UI shows "vLLM unreachable" | Check vLLM is running: `curl http://localhost:8001/health` |

---

## Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `VLLM_URL` | `http://103.204.95.220:8001` | vLLM server address |
| `MODEL` | `nvidia/Cosmos3-Nano` | Model name sent in API calls |
| `PORT` | `3000` | Node.js UI port |

To override:
```bash
VLLM_URL=http://localhost:8001 PORT=4000 node server.js
```

---

## File Locations (This Server)

| Item | Path |
|------|------|
| Python venv | `~/cosmos-reasoner/` |
| Model weights | `~/.cache/huggingface/hub/models--nvidia--Cosmos3-Nano/` |
| vLLM torch cache | `~/.cache/vllm/torch_compile_cache/` |
| UI source | `~/cosmos-ui/` |

---

*Cosmos3-Nano Reasoner — NVIDIA Visual AI · vLLM v0.21.0*
