@echo off
rem Shows which parts of the local setup are running, and what to do about the rest.
setlocal
if exist "%~dp0config.cmd" call "%~dp0config.cmd"
node "%~dp0status.mjs"
