@echo off
rem Copy this file to config.cmd and adjust. start-all.cmd and start-server.cmd read it on every start.

rem Where the model server listens (llama-server).
set "LOCAL_AGENT_URL=http://127.0.0.1:8080"

rem How to start the server when it is not running (leave empty to start it yourself).
set LOCAL_AGENT_START="%~dp0start-server.cmd"

rem llama-server: the program, and the model (see backends\llama-cpp.md).
rem set "LLAMA_SERVER=C:\path\to\llama.cpp\llama-server.exe"
rem set "LLAMA_MODEL_FILE=C:\path\to\Qwen3.8-27B-i1-IQ4_XS-GGUF-Smaller.gguf"
rem Keep LLAMA_PORT matching the port in LOCAL_AGENT_URL.
rem set "LLAMA_PORT=8080"
rem Extra llama-server flags, e.g. a presence penalty if the model repeats itself:
rem set "LLAMA_EXTRA=--presence-penalty 1.0"

rem Where your SearXNG answers, for launcher\status.cmd (docs\web-search.md).
rem set "LOCAL_AGENT_SEARXNG_URL=http://127.0.0.1:8888"

rem Faster coding (MTP): the coding model file needs the MTP layer, and the card needs ~0.7 GB free
rem beyond the model and its context. Programs that hold card memory can be closed by coding.cmd
rem (the "Coding Server" shortcut) before it starts the server; names as in Task Manager's Details tab:
rem set "LLAMA_MTP=1"
rem set "LOCAL_AGENT_CLOSE_FOR_CODING=App1.exe App2.exe"
