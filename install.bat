@echo off
title RoBoot Dependencies Setup

echo =========================================
echo Installing Node modules...
echo =========================================
call npm install

echo.
echo =========================================
echo Auditing package vulnerabilities...
echo =========================================
call npm audit

echo.
echo =========================================
echo Attempting automatic vulnerability fixes...
echo =========================================
call npm audit fix

echo.
echo =========================================
echo Setup complete! Press any key to close.
echo =========================================
pause
