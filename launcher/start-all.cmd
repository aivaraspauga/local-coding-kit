@echo off
rem Starts whatever is not running yet (the model server, Docker Desktop and SearXNG for web
rem search), then shows the status. The first argument ("coding" or nothing) goes on to
rem start-extra.cmd, if there is one.
setlocal
set "HERE=%~dp0"
set "LOCAL_AGENT_URL=http://127.0.0.1:8080"
set "LLAMA_SERVER=llama-server"
if exist "%HERE%config.cmd" call "%HERE%config.cmd"

rem The model server, unless it already answers or llama.cpp is not set up yet.
curl.exe -sf -m 3 -o nul "%LOCAL_AGENT_URL%/models" && goto server_done
if exist "%LLAMA_SERVER%" goto start_server
where "%LLAMA_SERVER%" >nul 2>&1 && goto start_server
echo llama.cpp is not set up yet: set LLAMA_SERVER in launcher\config.cmd ^(setup guide, steps 2 and 4^).
set "NO_SERVER=1"
goto server_done
:start_server
echo Starting the model server ...
start "Local model" "%HERE%start-server.cmd"
:server_done

rem Docker Desktop installs either for all users (Program Files) or for one user (AppData).
set "DOCKER_DESKTOP="
if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" set "DOCKER_DESKTOP=%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
if exist "%LOCALAPPDATA%\Programs\DockerDesktop\Docker Desktop.exe" set "DOCKER_DESKTOP=%LOCALAPPDATA%\Programs\DockerDesktop\Docker Desktop.exe"
docker info >nul 2>&1
if errorlevel 1 if defined DOCKER_DESKTOP (
  echo Starting Docker Desktop ...
  start "" "%DOCKER_DESKTOP%"
)

rem The containers restart with Docker only if nobody stopped them by hand (restart: unless-stopped),
rem so start SearXNG here. "start" never recreates a container, so its settings stay as they are.
if not defined DOCKER_DESKTOP goto docker_done
for /l %%i in (1,1,40) do (
  docker info >nul 2>&1 && goto docker_up
  timeout /t 3 /nobreak >nul
)
echo Docker Desktop did not answer within two minutes; SearXNG is not started.
goto docker_done
:docker_up
docker start searxng >nul 2>&1
:docker_done

rem Extras for this PC only (git-ignored): launcher\start-extra.cmd, called with the same argument.
if exist "%HERE%start-extra.cmd" call "%HERE%start-extra.cmd" %1

if defined NO_SERVER goto ready
echo Waiting for the model server to answer (the first load takes a minute or two) ...
for /l %%i in (1,1,72) do (
  curl.exe -sf -m 3 -o nul "%LOCAL_AGENT_URL%/models" && goto ready
  timeout /t 5 /nobreak >nul
)
:ready
echo.
node "%HERE%status.mjs" --speed
