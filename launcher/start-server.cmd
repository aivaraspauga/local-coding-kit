@echo off
rem Starts llama.cpp's llama-server in router mode with Qwen3.8-27B (IQ4_XS, 13.5 GB), the way this kit
rem expects. Router mode loads the model on the first request and can unload it on request
rem (POST /models/unload), so another program can borrow the graphics card.
rem start-all.cmd runs this when no server answers; you can also start it by hand.
rem What each setting does: backends\llama-cpp.md. Overrides go in config.cmd next to this file.
setlocal
set "HERE=%~dp0"

rem Defaults; config.cmd overrides them.
set "LLAMA_SERVER=llama-server"
rem The name clients use for the model (Qwen Code). Keep it in step with LOCAL_AGENT_MODEL.
set "LLAMA_MODEL_ID=qwen3.8-27b"
rem A Hugging Face reference (downloaded once, then cached), or set LLAMA_MODEL_FILE to a local .gguf.
set "LLAMA_MODEL=jrell/Qwen3.8-27B-i1-IQ4_XS-GGUF-Smaller:IQ4_XS"
set "LLAMA_MODEL_FILE="
set "LLAMA_PORT=8080"
rem 100K, so MTP (LLAMA_MTP below) fits next to it on a 16 GB card. Qwen Code compacts at 69.4K with 100K
rem (min of 85% and the window less 33K). Each 1K costs ~6 MB of card memory; 160K spilled into RAM (2026-10-22).
rem Keep qwen-code\user-settings.json (contextWindowSize) and LOCAL_AGENT_CONTEXT in step with it.
set "LLAMA_CONTEXT=102400"
rem Caps each thought. Without it, recent llama.cpp builds let this model think without limit.
rem 4096 since 2026-10-29 (was 8192): in the kit's auth run 4 thoughts held 70% of all thinking,
rem most of it code drafted before it was written. Not yet measured at 4096: set 8192 in
rem config.cmd if runs get worse.
set "LLAMA_THINKING_BUDGET=4096"
rem How hard the coding model thinks: xhigh, medium or low, passed to the chat template. medium adds
rem no instruction; the kit's prompt hook then asks for careful thought on bugs, failures, design
rem questions and big requests, and for short thoughts on clear ones. Empty = the template's default,
rem xhigh, which tells the model on every request to "validate key assumptions, consider plausible
rem alternatives". It is set once here: changing it per request would rewrite the start of the
rem prompt and make the server re-read all of it.
set "LLAMA_REASONING_EFFORT=medium"
rem Sampling temperature for the coding model (Qwen's card: 1.0). 0.7 measured 2026-10-24 on the q1
rem price-quote task with the kit: 17 vs 24 min, ~30% fewer tokens, same hidden score (1 run each).
set "LLAMA_TEMP=0.7"
rem 1 = n-gram speculative decoding for the coding model: it guesses the next tokens from text already
rem in the conversation (code it read, an Edit's old_string, a file it rewrites) and the model checks
rem the guess, so answers are the same, only faster when guesses land. Needs no extra card memory,
rem unlike MTP. Off until measured on this setup.
set "LLAMA_SPEC_NGRAM="
rem 1 = MTP (guess-ahead) for the coding model too, with a file that has the MTP layer. It needs ~0.7 GB
rem more than a 16 GB card has free at 105K (long chats then crawl), so free card memory first: monitor
rem on the motherboard's graphics, other programs that use the card closed. Combines with LLAMA_SPEC_NGRAM.
set "LLAMA_MTP="
rem How compactly the conversation memory is stored. q4_0 lets 105K fit next to the model on a 16 GB
rem card; at f16 or q8_0 it spills into normal RAM and reading gets ~15x slower.
set "LLAMA_KV_TYPE=q4_0"
rem MiB of normal RAM for saved prompt states (llama.cpp's default is 8192). One state of this model at
rem 100K is ~14 GB, so the default cache grew the server to 33 GB in a long session: the PC ran out of
rem RAM and writing fell from ~68 to under 2 tok/s. 0 = off; a session still reuses its own context.
set "LLAMA_CACHE_RAM=0"
rem Saved points in a conversation (llama.cpp's default is 32), also in normal RAM. With 32, the server
rem grew ~0.5 GB for each request of a coding session (to 29.9 GB in 10 min); with 4 it stayed flat,
rem and a growing conversation is still read only from where it changed.
set "LLAMA_CTX_CHECKPOINTS=4"
rem The model's own chat template refuses a system message after the first one, and some clients
rem (Claude Code did) send hook context that way, so every request would fail.
rem This copy keeps such a message as a system turn instead. Empty = the model's own template.
set "LLAMA_CHAT_TEMPLATE_FILE=%HERE%qwen3.8-chat-template.jinja"
set "LLAMA_EXTRA="
rem Vision: a multimodal projector (.gguf named mmproj-...) for Qwen3.8-27B lets the model read
rem images; without it llama-server answers "image input is not supported". It runs on the processor
rem (~0.6 GB of normal RAM, a few seconds per image) because the card is full at these contexts.
rem LLAMA_MMPROJ_GPU=1 puts it on the card instead (~0.6 GB more card memory).
set "LLAMA_MMPROJ_FILE="
set "LLAMA_MMPROJ_GPU="
if exist "%HERE%config.cmd" call "%HERE%config.cmd"
rem Your own additions to the preset file below (more models), if you have any.
if exist "%HERE%server-extra.cmd" set "HAS_SERVER_EXTRA=1"

rem Speculative decoding types for the coding model, as one comma-separated list.
set "SPEC="
if "%LLAMA_MTP%"=="1" set "SPEC=draft-mtp"
if "%LLAMA_SPEC_NGRAM%"=="1" if defined SPEC set "SPEC=%SPEC%,ngram-mod"
if "%LLAMA_SPEC_NGRAM%"=="1" if not defined SPEC set "SPEC=ngram-mod"

rem The router reads the model and its settings from a preset file, written fresh on every start.
set "PRESET=%HERE%models.generated.ini"
> "%PRESET%" (
  echo version = 1
  echo.
  echo [%LLAMA_MODEL_ID%]
  if "%LLAMA_MODEL_FILE%"=="" (echo hf-repo = %LLAMA_MODEL%) else (echo model = %LLAMA_MODEL_FILE%)
  echo c = %LLAMA_CONTEXT%
  echo n-gpu-layers = 99
  echo cache-type-k = %LLAMA_KV_TYPE%
  echo cache-type-v = %LLAMA_KV_TYPE%
  echo cache-ram = %LLAMA_CACHE_RAM%
  echo ctx-checkpoints = %LLAMA_CTX_CHECKPOINTS%
  echo ubatch-size = 256
  echo parallel = 1
  echo jinja = true
  if not "%LLAMA_CHAT_TEMPLATE_FILE%"=="" echo chat-template-file = %LLAMA_CHAT_TEMPLATE_FILE%
  echo reasoning-budget = %LLAMA_THINKING_BUDGET%
  if not "%LLAMA_REASONING_EFFORT%"=="" echo reasoning-effort = %LLAMA_REASONING_EFFORT%
  if defined SPEC echo spec-type = %SPEC%
  if "%LLAMA_MTP%"=="1" echo spec-draft-n-max = 2
  if not "%LLAMA_MMPROJ_FILE%"=="" echo mmproj = %LLAMA_MMPROJ_FILE%
  if not "%LLAMA_MMPROJ_FILE%"=="" if not "%LLAMA_MMPROJ_GPU%"=="1" echo mmproj-offload = false
  echo temp = %LLAMA_TEMP%
  echo top-k = 20
  echo top-p = 0.95
  echo min-p = 0
  echo load-on-startup = true
  if defined HAS_SERVER_EXTRA call "%HERE%server-extra.cmd"
)

"%LLAMA_SERVER%" --models-preset "%PRESET%" --models-max 1 --host 127.0.0.1 --port %LLAMA_PORT% %LLAMA_EXTRA%
if errorlevel 1 pause
