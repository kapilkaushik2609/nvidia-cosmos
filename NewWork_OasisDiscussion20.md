# New Work — Oasis Discussion (20), 2026-07-09

Source: call between Shubham Prajapati and Rahul Vishwakarma, transcript `Oasis Discussion  (20).docx`. This captures the concrete action items from that call — status column to be updated as work proceeds.

## Action Items

| # | Item | Details | Status |
|---|---|---|---|
| 1 | Gitignore `allocations/` folder | Folder is huge (~14–50 GB uncompressed, ~1.6 GB zipped). Rahul explicitly does not want it committed. Add `allocations/` to `.gitignore`. | Not started |
| 2 | Make `allocations/` path configurable | Currently the folder-driven batch script defaults to a hardcoded relative path (`../../allocations`). Move this into config (env var, e.g. `ALLOCATIONS_DIR` in `backend/.env`) so the pipeline just looks it up, rather than assuming a fixed location. | Not started |
| 3 | README note for `allocations/` | Document that this folder must be dropped in manually (not part of the repo) and how to point the config at it. | Not started |
| 4 | Multi-model comparison support | Run the *same* prompt against Cosmos Reason plus at least one other vision-language model (Gemma 4, Qwen 3.6 VL, or something served via Ollama). Goal: compare Cosmos's spatial/physics-informed strengths against general VL models on the same allocation dataset. | Not started — biggest scope item |
| 5 | Prompt versioning | Extract the compliance prompt into a separate, versioned artifact (e.g. CSV/JSON), tagged with a version like "R1". The *same* prompt template must be used across every model compared — changing it per model invalidates the comparison. | Not started |
| 6 | Result file versioning | Every output filename must embed: model name + prompt template version + a date-time stamp, so repeated runs/iterations don't overwrite each other and stay traceable. | Not started |
| 7 | External/independent `is_correct` verification | Rahul wants a verification mechanism that's independent of the pipeline's own ground-truth cross-check (what `auto_check()` in the batch scripts already does isn't what he means by "external"). He's still deciding on the right approach — no concrete ask yet. | Waiting on Rahul |
| 8 | Updated README/runsheet for native Cosmos setup | Environment setup only (GPU/CUDA/vLLM install), not the codebase — Rahul will pull the git repo separately. Likely an update to `COSMOS_RUNSHEET.md`. | Not started |

## Deliverable Rahul Is Waiting On

Run 2–3 models against the same allocation set, using the identical prompt template, and share labeled/versioned result files (Excel/CSV) — committed to for 2026-07-10.

## Notes

- Rahul is planning to split Omniverse/metaverse-related work into a **new, separate repository** (tentatively "DC Omni"/"DC"). This repo stays OASIS-focused. Not an action item here, just context for later "keep the mirror in sync" questions.
- Full call notes also synced into `OASIS_COSMOS_PROGRESS.md` under "Meeting Context (Rahul — Oasis Discussion 20)" — that's the fuller historical record; this file is the actionable/working checklist.
