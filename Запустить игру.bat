@echo off
chcp 65001 >nul
title Осада Замков — сервер
cd /d "%~dp0"
echo ==============================================
echo   ОСАДА ЗАМКОВ
echo ==============================================
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js не найден!
  echo   Скачайте и установите его с https://nodejs.org
  echo   , затем запустите этот файл снова.
  echo.
  pause
  exit /b 1
)
echo.
echo Запускаю сервер... Не закрывайте это окно во время игры!
echo.
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:8080"
node server.js
echo.
echo Сервер остановлен.
pause
