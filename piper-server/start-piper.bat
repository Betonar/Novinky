@echo off
rem Local Piper TTS server for the Novinky reader userscript (http://127.0.0.1:5000).
rem Needs Python 3.9+ (python.org installer, or the Python Install Manager: "py install 3.13").
cd /d "%~dp0"

set PY=
where py >nul 2>nul && set PY=py -3
if "%PY%"=="" (where python >nul 2>nul && set PY=python)
if "%PY%"=="" (
  echo Python was not found. Install it first ^(py install 3.13^) and run this again.
  goto :fail
)

if not exist venv\Scripts\python.exe (
  echo Creating virtual environment...
  %PY% -m venv venv || goto :fail
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
