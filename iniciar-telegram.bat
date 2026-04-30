@echo off
cd /d "%~dp0"

if "%TELEGRAM_BOT_TOKEN%"=="" (
  echo Falta TELEGRAM_BOT_TOKEN.
  echo Configuralo en PowerShell:
  echo   setx TELEGRAM_BOT_TOKEN "TU_TOKEN"
  echo   setx TELEGRAM_ALLOWED_CHAT_ID "TU_CHAT_ID"
  pause
  exit /b 1
)

echo Iniciando proyecto Telegram...
echo Proyecto independiente: no requiere el panel web.
echo Se levantara tambien panel admin local en http://localhost:4020
npm start
