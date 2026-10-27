@echo off
rem Starts the model server for coding and web search (start-all.cmd coding), then shows what runs.
rem The "Coding Server" desktop shortcut runs this. Open VS Code yourself when it is ready.
rem First it closes the programs named in LOCAL_AGENT_CLOSE_FOR_CODING (config.cmd), which hold graphics
rem card memory that the model (and MTP) needs, for example: set "LOCAL_AGENT_CLOSE_FOR_CODING=App1.exe App2.exe"
setlocal
set "LOCAL_AGENT_CLOSE_FOR_CODING="
if exist "%~dp0config.cmd" call "%~dp0config.cmd"
for %%p in (%LOCAL_AGENT_CLOSE_FOR_CODING%) do (
  tasklist /fi "imagename eq %%~p" 2>nul | find /i "%%~p" >nul && (
    echo Closing %%~p to free graphics card memory ...
    taskkill /im "%%~p" /f >nul 2>&1
  )
)
call "%~dp0start-all.cmd" coding
echo.
echo This window closes in 20 seconds (push a key to close it now).
timeout /t 20 >nul
