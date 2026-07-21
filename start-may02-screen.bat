@echo off
cd /d C:\Users\ASUS\Desktop\CyberNet_Cloud

set CYBERNET_USERNAME=may02
set CYBERNET_MACHINE=MAY02
set CYBERNET_SCREEN_INTERVAL=5000

echo Dang chay Screen Agent cho MAY02...
node edge-screen-agent.js

pause
