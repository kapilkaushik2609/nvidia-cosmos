# Cosmos3-Nano Reasoner UI

React + Node.js frontend for the Cosmos3-Nano vLLM server.

## Setup

**Backend**
```bash
cd cosmos-ui
npm install
node server.js          # runs on :3000
```

**Frontend (dev)**
```bash
cd cosmos-ui/client
npm install
npm run dev             # runs on :5173, proxies /api → :3000
```

**Frontend (production build)**
```bash
cd cosmos-ui/client
npm run build           # outputs to client/dist/
cd ..
node server.js          # serves built React app + API on :3000
```

## Environment Variables

| Variable   | Default                  | Description              |
|------------|--------------------------|--------------------------|
| `VLLM_URL` | `http://localhost:8001`  | vLLM server address      |
| `MODEL`    | `nvidia/Cosmos3-Nano`    | Model name               |
| `PORT`     | `3000`                   | Backend port             |

```bash
VLLM_URL=http://localhost:8001 node server.js
```
