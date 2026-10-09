@echo off
rem Local Piper TTS server for the Novinky reader userscript (http://127.0.0.1:5000).
rem Needs Python 3.9+ installed (https://www.python.org/downloads/ - tick "Add python.exe to PATH").
cd /d "%~dp0"

if not exist venv\Scripts\python.exe (
  echo Installing Piper (one time)...
  python -m venv venv || goto :fail
  venv\Scripts\python -m pip install --upgrade pip piper-tts flask || goto :fail
)

if not exist voices\cs_CZ-jirka-medium.onnx (
  echo Downloading Czech voice (one time, ~60 MB)...
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
