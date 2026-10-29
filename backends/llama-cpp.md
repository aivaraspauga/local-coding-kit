# The model server: llama.cpp with Qwen3.8-27B

The kit uses one setup: the llama.cpp `llama-server` with [Qwen3.8-27B IQ4_XS](https://huggingface.co/jrell/Qwen3.8-27B-i1-IQ4_XS-GGUF-Smaller). The model file is 13.5 GB and fits a 16 GB graphics card. Qwen Code connects directly to the server.

> **NOTE:** We tested this on an RTX 5080 (16 GB). On a new computer, do the checklist at the end of this page when you start the server for the first time.

## How the server starts

`launcher\start-server.cmd` writes a small settings file for the model and starts the server:

```ini
version = 1

[qwen3.8-27b]
hf-repo = jrell/Qwen3.8-27B-i1-IQ4_XS-GGUF-Smaller:IQ4_XS
c = 102400
n-gpu-layers = 99
cache-type-k = q4_0
cache-type-v = q4_0
ubatch-size = 256
parallel = 1
jinja = true
chat-template-file = launcher\qwen3.8-chat-template.jinja
reasoning-budget = 4096
reasoning-effort = medium
temp = 0.7
top-k = 20
top-p = 0.95
min-p = 0
load-on-startup = true
```

```bat
llama-server --models-preset launcher\models.generated.ini --models-max 1 --host 127.0.0.1 --port 8080
```

## What the settings do

| Setting | Reason |
| --- | --- |
| Name `qwen3.8-27b` | Each app asks for the model with this name (Qwen Code: `qwen-code/user-settings.json`). |
| `c = 102400` (context, 100K) | Qwen Code makes long conversations shorter at the smaller of 85% of its window and the window minus 33K: 69.4K with 100K. With 100K, MTP fits on a 16 GB card when other programs do not use the card. Each 1K of context uses approximately 6 MB of card memory. At 160K, a 90K prompt went to RAM and became more than 9x slower. |
| `n-gpu-layers = 99` | The full model is on the graphics card. |
| `cache-type-k/v = q4_0` | Keeps the conversation small in memory, so 100K fits on the card together with the model. To change it, use `LLAMA_KV_TYPE`. |
| `ubatch-size = 256` | Reads prompts in smaller parts. This makes approximately 0.3 GB of card memory free, so less goes to RAM. Writing is approximately 10% faster. Reading speed stays the same. |
| `cache-ram = 0` | No saved prompt states in the usual RAM (llama.cpp keeps up to 8 GB by default). One state of this model at 100K is approximately 14 GB, so in a long session the server grew to 33 GB, the PC ran out of RAM, and writing fell from approximately 68 to less than 2 tokens each second. A conversation still reuses its own context. |
| `ctx-checkpoints = 4` | Saved points in a conversation (default 32), also in the usual RAM. With 32, the server grew approximately 0.5 GB for each request. With 4, it stayed the same, and a growing conversation is still read only from where it changed. |
| `parallel = 1` | One request at a time, with the full context. |
| `jinja = true` | The model needs this to use tools. |
| `chat-template-file` | The chat template of the model, with one correction. Some clients send hook notes as system messages during a conversation (Claude Code did). The original template refuses these messages ("System message must be at the beginning"), so each request failed. To change it, use `LLAMA_CHAT_TEMPLATE_FILE` (empty = the template of the model). |
| `reasoning-budget = 4096` | Sets a limit for each thought. Without it, the model can think for a very long time. It was 8192 until 2026-10-29. The model often wrote whole files in its thinking before it wrote them for real, so the limit is now lower. This is not measured yet. If results get worse, set `LLAMA_THINKING_BUDGET=8192` in `config.cmd`. |
| `reasoning-effort = medium` | The server sends this value to the chat template: `xhigh`, `medium` or `low`. See the text below this table. |
| `temp = 0.7` | Qwen recommends 1.0. With 0.7, the model wrote approximately 30% fewer tokens and finished faster, with the same test result (2026-10-24, 1 run for each setting). To change it, use `LLAMA_TEMP`. |
| `top-k`, `top-p`, `min-p` | The values that Qwen recommends ([model card](https://huggingface.co/Qwen/Qwen3.8-27B-FP8)). |
| Router mode (`--models-preset`, `--models-max 1`) | Another program can ask the server to make the card free (`POST /models/unload`). The model comes back on the next question. |

**About `reasoning-effort`:**

- The default of the template is `xhigh`. With `xhigh`, the template puts "validate key assumptions, consider plausible alternatives" into the system prompt of each request. `medium` adds nothing.
- The prompt hook of the kit changes the effort for each request. It writes "Effort: high" for bugs, failures, design questions and big requests. It writes "Effort: normal" (short thoughts) for clear requests. When the checks fail a second time, the Stop hook asks for careful thought.
- This text goes at the end of the conversation. If the kit changed the template effort for each request, the start of the prompt would change, and the server would have to read all of the prompt again.
- To change the value, set `LLAMA_REASONING_EFFORT` in `config.cmd` (empty = `xhigh`).
- We did not measure this yet.

`hf-repo` downloads the model the first time. If you already have the file, set `LLAMA_MODEL_FILE` in `config.cmd`.

Qwen Code gets these values from `qwen-code/user-settings.json`: the server address, the model name `qwen3.8-27b`, and a limit of 24,000 tokens for each answer, so that everything fits.

## Speed

Measured on an RTX 5080 (16 GB), Windows 11, llama.cpp b11461, 131K context:

| Conversation storage | Writing | Reading a long prompt | On the card / moved to RAM |
| --- | --- | --- | --- |
| `f16` (llama.cpp default) | 19 tok/s | 108 tok/s | 13.6 / 7.1 GB |
| `q8_0` | 18 tok/s | 109 tok/s | 13.6 / 3.8 GB |
| **`q4_0` (kit default)** | **46 tok/s** | **~1600 tok/s** | 15.1 / 0.3 GB |

With the 105K context of the kit and `q4_0`: **52 tok/s** writing, **~1900 tok/s** reading, 14.7 GB on the card, 0.2 GB moved to RAM.

Real chats (thinking on, usual settings, answers of 3,000 tokens):

| Setting | Short chat | Chat with 25K tokens of history | Moved to RAM |
| --- | --- | --- | --- |
| Before | 48 tok/s | 43 tok/s | 0.4 GB |
| **`ubatch-size = 256` (kit default)** | **53 tok/s** | **47 tok/s** | 0.1 GB |
| + MTP (layer that guesses the next words) | 58 tok/s | 21 tok/s | 1.0 GB |

**N-gram speculative decoding (not measured yet):**

- `set "LLAMA_SPEC_NGRAM=1"` in `config.cmd` adds `spec-type = ngram-mod` to the coding model.
- The server guesses the next tokens from text that is already in the conversation. The model checks each guess, so the answers do not change.
- The llama.cpp documentation recommends it for "iterating over a block of text/code" and for reasoning models that repeat their thinking. An agent that writes again the code that it just read does this.
- It does not need more card memory.
- Not known: how frequently the guesses are correct in agent work, and the cost of a wrong guess for the recurrent layers of this hybrid model. (MTP also guesses and checks, and it works on this model.)
- To compare, look at the writing speed in the server window, with and without it.

**MTP** (`--spec-type draft-mtp`):

- It makes short chats faster. But at 105K, it needs approximately 0.7 GB more than a 16 GB card has free, and long chats then become very slow.
- `set "LLAMA_MTP=1"` turns it on for the coding model (with `spec-draft-n-max = 2`, together with n-gram when both are on).
- Make card memory free first. When the monitor uses the graphics of the CPU, and other programs that use the card are closed, 0.5-2 GB can become free.
- On a 24 GB card, try `set "LLAMA_EXTRA=--spec-type draft-mtp --spec-draft-n-max 1"`.

Other programs also use card memory. RGB lighting apps can use approximately 1 GB. For the best speed, close them.

**CAUTION:** When the card is full, Windows does not show an error. It moves the remaining data into the usual RAM without a warning, and everything becomes much slower. `q4_0` is the only setting that fits. It still found 3 of 3 facts at the start of a 38K-token prompt.

If you have a 24 GB card, `set "LLAMA_KV_TYPE=q8_0"` in `config.cmd` is slightly more accurate.

## Settings at the llama.cpp defaults (b11461)

We compared these settings with the model file and `llama-server --help`. They need no change:

- **The model is a hybrid** (`qwen35`: each 4th layer is full attention, and the other layers are recurrent). Only the full-attention layers need conversation memory. This is one reason why 120K fits. The server cannot rewind recurrent layers, so the reuse of an earlier prompt uses context checkpoints (`ctx-checkpoints`, see the table above). A coding chat only adds to the end of the conversation, so the server reads most of each prompt from the cache.
- **Flash attention** is `auto` (on for CUDA). The `q4_0` conversation memory needs it.
- **`--fit`** is on, but it changes only the settings that are not set. The context and `n-gpu-layers` are set.
- **The server keeps past thinking** (`--reasoning-preserve`, on by default, and the template keeps it). If the server removed it, the context would be smaller, but earlier messages would change. Then the server would read the prompt again from a checkpoint for each request.
- **Sampling** (`top-k 20`, `top-p 0.95`) has the same values as the model file. `temp` is 0.7, not 1.0 (see the table above).

## If the model repeats itself

Add `set "LLAMA_EXTRA=--presence-penalty 1.0"` to `config.cmd`.

**CAUTION:** A value that is too high can make the model mix languages.

## Checklist for the first start

1. Make sure that `curl http://127.0.0.1:8080/models` shows `qwen3.8-27b` as `loaded`, and that `curl http://127.0.0.1:8080/v1/models` shows `"n_ctx": 102400`.
2. Make sure that unloading works: `curl -X POST http://127.0.0.1:8080/models/unload -H "Content-Type: application/json" -d "{\"model\":\"qwen3.8-27b\"}"` makes the card free, and the next question loads the model again.
3. Make sure that the writing speed is approximately 40 or more tokens each second (`eval time` in the server window). If it is much slower, the card is full. Close other programs that use the GPU and start the model again.
4. Make sure that a short Qwen Code conversation can read a file and run a command.
