@echo off
cd /d C:\Users\ASUS\Desktop\CyberNet_Cloud

set CYBERNET_USERNAME=may01
set CYBERNET_MACHINE=MAY01
set CYBERNET_SCREEN_INTERVAL=5000

echo Dang chay Screen Agent cho MAY01...
node edge-screen-agent.js

pause
