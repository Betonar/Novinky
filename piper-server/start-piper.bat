@echo off
rem Local Piper TTS server for the Novinky reader userscript (http://127.0.0.1:5000).
rem Needs Python 3.9+ (python.org installer, or the Python Install Manager: "py install 3.13").
cd /d "%~dp0"

set PY=
rem Piper needs onnxruntime, which has no wheels for the newest Python versions - prefer 3.12.
for %%V in (3.12 3.11 3.13 3.10) do (
  if not defined PY (
    py -%%V -c "import sys" >nul 2>nul && (set PY=py -%%V) && (set PYVER=%%V)
  )
)
if not defined PY (
  echo Compatible Python not found. Run:  py install 3.12   then start this again.
  goto :fail
)
echo Using %PY%

rem A venv made by a different Python (e.g. 3.14 from an earlier run) cannot install Piper - rebuild it.
if exist venv\Scripts\python.exe if not exist venv\.made-with-%PYVER% (
  echo Removing old virtual environment...
  rmdir /s /q venv
)

if not exist venv\Scripts\python.exe (
  echo Creating virtual environment with %PY%...
  %PY% -m venv venv || goto :fail
  echo ok> venv\.made-with-%PYVER%
)

venv\Scripts\python -c "import piper, flask" >nul 2>nul
if errorlevel 1 (
  echo Installing Piper ^(one time^)...
  venv\Scripts\python -m pip install --upgrade pip || goto :fail
  venv\Scripts\python -m pip install piper-tts flask || goto :fail
)

if not exist voices\cs_CZ-jirka-medium.onnx (
  echo Downloading Czech voice ^(one time, about 60 MB^)...
  venv\Scripts\python -m piper.download_voices cs_CZ-jirka-medium --download-dir voices || goto :fail
)

echo.
echo Piper is running on http://127.0.0.1:5000  - keep this window open.
venv\Scripts\python -m piper.http_server -m voices\cs_CZ-jirka-medium.onnx --host 127.0.0.1 --port 5000
goto :eof

:fail
echo.
echo Something failed - see the message above.
pause
