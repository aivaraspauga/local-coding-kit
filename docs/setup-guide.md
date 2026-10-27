# Setup guide: local model in VS Code (Windows)

This guide starts from zero. At the end, Qwen Code in VS Code runs on your own graphics card. Paste each command into **PowerShell**. You install only VS Code and Docker Desktop by hand.

```
VS Code + Qwen Code extension ──► llama-server (Qwen3.8-27B on your GPU)
        │  kit: rules, checks, recipes
        └──► SearXNG in Docker ──► the web
```

You must have:

- an NVIDIA card with 16 GB
- approximately 15 GB of free disk space
- Windows 10 or 11

Do steps 1 to 7 one time on each PC. Do step 8 one time for each project.

---

## 1. Make sure that you have the necessary programs

```powershell
code --version          # VS Code
node --version          # Node.js 20 or newer
git --version           # Git
nvidia-smi              # top right must say CUDA ... 13.x or higher
```

If a program is missing, do the applicable step:

- **VS Code:** Download it from code.visualstudio.com. Then add the **Qwen Code Companion** extension: `code --install-extension qwenlm.qwen-code-vscode-ide-companion`.
- **Node.js:** Run `winget install OpenJS.NodeJS.LTS`. Then open a new PowerShell window.
- **Git:** Run `winget install Git.Git`. Then open a new PowerShell window.
- **CUDA lower than 13:** Update your NVIDIA driver.
- **Docker Desktop** (for web search): Install it from docker.com. Start it one time.

Then download this repo. The launcher scripts are in it, and the commands below use this folder:

```powershell
git clone https://github.com/aivaraspauga/local-coding-kit C:\Development\local-coding-kit
```

If you put it in a different folder, change the path in the commands below.

## 2. Install llama.cpp

These commands put the newest llama.cpp version for NVIDIA cards into `C:\llama.cpp`:

```powershell
$releases = Invoke-RestMethod "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=20"
$release = $releases | Where-Object { $_.assets.name -match "bin-win-cuda-13.*-x64\.zip$" } | Select-Object -First 1
$files = $release.assets | Where-Object { $_.name -match "win-cuda-13.*-x64\.zip$" }
New-Item -ItemType Directory -Force C:\llama.cpp | Out-Null
foreach ($f in $files) {
  curl.exe -L -o "$env:TEMP\$($f.name)" $f.browser_download_url
  Expand-Archive "$env:TEMP\$($f.name)" C:\llama.cpp -Force
}
C:\llama.cpp\llama-server.exe --version
```

The last line must show a version and the word CUDA.

## 3. Download the model

The model is 13.5 GB. If the download stops before the end, run the line again. The download continues from where it stopped.

```powershell
New-Item -ItemType Directory -Force C:\models | Out-Null
curl.exe -L -C - -o C:\models\Qwen3.8-27B-i1-IQ4_XS-GGUF-Smaller.gguf "https://huggingface.co/jrell/Qwen3.8-27B-i1-IQ4_XS-GGUF-Smaller/resolve/main/Qwen3.8-27B-i1-IQ4_XS-GGUF-Smaller.gguf"
```

## 4. Tell the kit where the programs are

```powershell
Set-Content -Encoding ascii C:\Development\local-coding-kit\launcher\config.cmd -Value @(
  '@echo off',
  'set "LLAMA_SERVER=C:\llama.cpp\llama-server.exe"',
  'set "LLAMA_MODEL_FILE=C:\models\Qwen3.8-27B-i1-IQ4_XS-GGUF-Smaller.gguf"',
  'set LOCAL_AGENT_START="%~dp0start-server.cmd"',
  'set "LOCAL_AGENT_SEARXNG_URL=http://127.0.0.1:8888"'
)
```

## 5. Start the model and examine it

1. Run this command:

   ```powershell
   Start-Process C:\Development\local-coding-kit\launcher\start-server.cmd
   ```

2. A window opens and loads the model. This takes one or two minutes.

   **CAUTION:** Keep the window open. When you close it, the model stops.

3. Run this command:

   ```powershell
   curl.exe http://127.0.0.1:8080/models
   ```

4. Make sure that the result shows `"id":"qwen3.8-27b"` with `"loaded"`.

If you see an "out of memory" error, see [Troubleshooting](#troubleshooting).

## 6. Web search: SearXNG in Docker

With SearXNG, the model can search the web. SearXNG uses **one search engine, Yahoo**. SearXNG waits for its slowest engine, so one fast engine gives the quickest answer (less than one second).

**NOTE:** Google is the best engine, but Google blocks SearXNG since August 2026. When SearXNG corrects this problem, change the engine here to `google`.

1. Write the SearXNG settings:

   ```powershell
   New-Item -ItemType Directory -Force C:\searxng | Out-Null
   $secret = -join ((48..57) + (97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
   $settings = @"
   use_default_settings:
     engines:
       keep_only:
         - yahoo
   server:
     secret_key: "$secret"
     limiter: false
   search:
     formats:
       - html
       - json
   engines:
     - name: yahoo
       disabled: false
   "@
   [IO.File]::WriteAllText("C:\searxng\settings.yml", $settings)
   ```

2. Make sure that Docker Desktop runs.
3. Start SearXNG and do a test search:

   ```powershell
   docker run -d --name searxng --restart unless-stopped -p 127.0.0.1:8888:8080 -v C:\searxng:/etc/searxng searxng/searxng
   Start-Sleep -Seconds 15
   (Invoke-RestMethod "http://127.0.0.1:8888/search?q=nextjs&format=json").results | Select-Object -First 5 engine, title
   ```

4. Make sure that you see results from `yahoo`.

SearXNG starts again automatically each time Docker Desktop starts. Only your PC can connect to it.

**NOTE:** If searches suddenly give no results, the search engine limits automatic searches for some time. This problem stops automatically.

## 7. Set Qwen Code to the local model

Qwen Code needs to know your model server. `qwen-code\user-settings.json` in the kit holds the settings the kit is tuned for: the local model, the web search tool, and no follow-up suggestions or background memory (each extra request pushes your conversation out of the server's memory, and the next answer is slower).

You can let the AI add them: the first time you set up the kit in a project (step 8), it asks to add what is missing to `%USERPROFILE%\.qwen\settings.json`, and keeps your other settings. To do it by hand, copy the keys of `user-settings.json` into that file.

## 8. Put the kit into a project and use it

1. Open the project folder in VS Code: a project you already have, or a new, empty folder. If VS Code was already open, push **Ctrl+Shift+P → Developer: Reload Window**.
2. Click the Qwen icon and start a **new conversation**. If Qwen Code asks if you trust the folder, answer yes.
3. Type:

   > Download https://github.com/aivaraspauga/local-coding-kit into a temporary folder and follow its SETUP-FOR-AI.md to set it up in this project.

   The AI copies the kit into the project, fits it to the project and removes the download. It never overwrites a file the project already has.
4. Start a **new conversation**. This loads the kit's hooks. Then type a request.

The server window shows each request. This is your GPU when it answers.

## 9. Current library versions (automatic)

The model knows only the library versions from its training. Thus the kit gives the model this information at the start of each conversation and after each installation:

- which versions are newer than the model knows
- where the model can read what changed

The model writes the important information into the notes of the project.

After an installation, the kit also runs `npm audit --omit=dev`. It tells you about high and critical vulnerabilities in the packages that the app uses.

Only package names and versions go to the internet: the names go to deps.dev, and the package list of the lockfile goes to the npm registry for the audit. Your code does not go to the internet. To stop the two functions, set `"LOCAL_AGENT_OFFLINE": "1"` under `"env"` in `.qwen\settings.json`.

**Tell the kit when the knowledge of the model stops.** The kit uses March 2026. To find the correct date:

1. Ask the model: *"Without looking anything up: what is the newest version of Next.js, React and TypeScript you know, and roughly when was each released?"*
2. If the answer is very different, set `"LOCAL_AGENT_MODEL_CUTOFF"` (for example `"2026-03"`) under `"env"` in `.qwen\settings.json`.

## Each day

1. Run:

   ```powershell
   C:\Development\local-coding-kit\launcher\start-all.cmd coding
   ```

   This script starts the model and Docker if they do not run. It waits, then it shows what runs.
2. Open VS Code.

**NOTE:** To start more of your own programs with it, write them in `launcher\start-extra.cmd`. The script runs that file when it exists.

If there is a problem, run `C:\Development\local-coding-kit\launcher\status.cmd`. It shows what does not run and what to do.

## When the local model cannot continue

1. Type `/model` and pick a stronger model (for example a bigger model on another server), in the same conversation.
2. If you start a new conversation, tell the model to read `.local-agent/plan.md` and the output of `git diff`. These hold the plan and the work so far. `AGENTS.md` loads by itself.

To remove the kit from a project, delete `.qwen` and `QWEN.md`.

## Update

- **The kit in a project:** Ask the AI the same as in step 8: *"Download https://github.com/aivaraspauga/local-coding-kit into a temporary folder and follow its SETUP-FOR-AI.md to update the kit in this project."* It replaces `.qwen\kit`, `.qwen\skills` and `.qwen\agents`, and keeps your settings. Then start a new conversation.
- **llama.cpp:** Close the server window and do step 2 again.
- **SearXNG:** Run `docker pull searxng/searxng` and `docker rm -f searxng`. Then run the `docker run` line from step 6. Your settings stay.

## Troubleshooting

| Problem | Corrective action |
| --- | --- |
| You do not know what is wrong | Run `launcher\status.cmd`. |
| Qwen Code does not use the local model | Type `/model` and pick `qwen3.8-27b`. If it is not in the list, add the `modelProviders` entry of `qwen-code\user-settings.json` to `%USERPROFILE%\.qwen\settings.json` (step 7). Then start a new conversation. |
| `model not found` | The model name must be `qwen3.8-27b` in `config.cmd` and in `%USERPROFILE%\.qwen\settings.json`. |
| `connection refused` | The model window is closed, or the model still loads (step 5). |
| Answers are slow (much less than 40 tokens each second) | The card is full, and Windows uses the usual RAM. Close other programs that use the GPU (games, RGB lighting apps). Then start the model again. Make sure that `config.cmd` does not set `LLAMA_KV_TYPE` to `q8_0` or `f16`. |
| Out of memory when the model starts | Close other programs that use the GPU. Then start the model again. If MTP is on (`LLAMA_MTP=1`), close other programs that use the card, or turn MTP off. |
| Error 500 "System message must be at the beginning" | The model started without the chat template of the kit. Close the model window. Start the model again with `launcher\start-server.cmd` (or `start-all.cmd`). |
| The model repeats the same sentence | Add `set "LLAMA_EXTRA=--presence-penalty 1.0"` to `config.cmd`. Then start the model again. |
| Web search does not work | Do the test in step 6 again. Make sure that `.qwen\settings.json` is in the project (it is in a hidden folder). |
| Qwen Code asks for approval again and again | Select "always allow". When the model wants to read a full web page, Qwen Code always asks you. This is intentional. |

More information: [server settings](../backends/llama-cpp.md), [web search](web-search.md).
